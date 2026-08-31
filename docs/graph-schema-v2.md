# Graph schema v2: blocks-first storage

Status: **implemented** (2026-08-29, on `claude/graph-storage` — migration
`migrations/0002_nodes.sql`, ingest/rollup in `src/data/graph.ts`, store in
`src/data/sql-note-store.ts`), and extended to **v3** in 2026-W36
(`migrations/0004_tenant_columns.sql`): tenant columns on D1 and soft deletes
on both engines. The inversion this document argues for is unchanged; the
schema below is the current one. Supersedes the v1 schema from
`migrations/0001_init.sql`; `graph-storage.md` describes the running system.

## The inversion

v1 stores markdown as truth (`notes.content`, byte-for-byte) and derives block
rows from it as a queryable projection. v2 inverts this: **the block graph is
truth, and markdown is a rendered projection** — `serialize(walk(graph))`,
called the _rollup_. A block is the atomic unit; a note is just the root node
you start walking from. Because containment is many-to-many, a block can
appear in multiple places in the graph and renders fully in each.

What this buys: block-level sync granularity (v1 LWW is per-note), real
multi-parent blocks (today's `((blk_x))` transclusion becomes structural),
typed blocks queryable without parsing, and a data model that maps one-to-one
onto the op vocabulary in `event-sourcing-design.md` — each node is an
aggregate; every mutation is a text edit, a type change, or a link-row change.

What it costs: markdown flips from _preserved bytes_ to _canonical
serialization_. The rollup is deterministic and stable (the editor's
`parse(serialize(doc))` round-trip invariant already guarantees canonical form
is a fixpoint), but exported files are rendered, not stored. The rollup is
therefore the most load-bearing function in the app — see the test plan below.

## Schema

Three tables, in **two shapes** (v3, `migrations/0004_tenant_columns.sql`):
the D1 database holds every user's corpus, scoped by a `user_id` column, while
the browser store is one user per browser profile and has no such column. Both
have soft deletes. The shape deliberately mirrors a production-proven cousin
(the typed-entity graph Finn works with professionally: entity + link with
`kind` and a fractional `sort_key`).

The **D1 shape** (`0004`), where `user_id` leads every key and index:

```sql
CREATE TABLE nodes (
  user_id INTEGER NOT NULL,  -- the tenant: the server-verified GitHub id
  id TEXT NOT NULL,          -- blk_ ids as-is; page nodes use the note id
  type TEXT NOT NULL,        -- see the type registry below
  text TEXT NOT NULL,        -- marker-free content; for pages, the title
  props TEXT,                -- JSON or NULL; pages: parsed frontmatter entries; code: language
  updated_at INTEGER NOT NULL, -- ms epoch, drives LWW + since-cursor pulls
  deleted_at INTEGER,        -- NULL = live; a tombstoned node never renders
  PRIMARY KEY (user_id, id)
);

CREATE INDEX nodes_tenant_type ON nodes (user_id, type);        -- "my pages", "my todos"
CREATE INDEX nodes_tenant_updated ON nodes (user_id, updated_at); -- since-cursor pulls

CREATE TABLE link (
  user_id INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'child',  -- 'child' = containment; room for more
  sort_key TEXT NOT NULL,    -- fractional index; sibling order under a source
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,        -- NULL = live; a tombstoned link is retained, not traversed
  PRIMARY KEY (user_id, source_id, destination_id, kind)
);

-- Downstream: a node's children in order.
CREATE INDEX link_tenant_source ON link (user_id, source_id, kind, sort_key);
-- Upstream: who contains this node (multi-parent lookup, delete-rescue).
CREATE INDEX link_tenant_destination ON link (user_id, destination_id);
-- Since-cursor pulls read changed link rows the same way as changed nodes.
CREATE INDEX link_tenant_updated ON link (user_id, updated_at);

CREATE TABLE meta (
  user_id INTEGER NOT NULL,  -- per-tenant: each has its own cursor and versions
  key TEXT NOT NULL,         -- schema_version = '3', replica_cursor, data_version
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
```

The **browser shape** is the same DDL minus `user_id` (and with the original
un-prefixed keys and indexes). `src/data/corpus-schema.ts` is the one place
the divergence lives: its `tenancy` flag selects `0004` or an ALTER-only step
that adds just `deleted_at`, and the worker test suites build the D1 shape
from `0004` itself so the seam is pinned rather than described.

Design notes, and why:

- **Tenancy is a column, and the discipline is mechanical.** Filtering, not
  placement — chosen for data visibility (the D1 console) over structural
  isolation, with a tenant-scoped handle, a runtime guard, and a CI gate as the
  price. The decision record, including what is given up, is
  [multi-tenant-design.md §0](./multi-tenant-design.md). `nodes.id` is a
  client-minted `blk_` id, so two users can legitimately mint the same one —
  which is exactly why the primary key had to become `(user_id, id)`.
- **`deleted_at`: nothing is hard-deleted.** A delete stamps the column; all
  rows one delete operation retires share one stamp, so a restore is "revive
  the rows stamped at T". Reads discard tombstones at read time
  (`buildGraphSnapshot`), so deletes never cascade at write time — and a link
  pointing at a deleted node is _retained_, holding the position a restore
  would put it back into. See "Delete = unlink + rescue" in graph-storage.md.
- **No foreign keys.** v2 had `ON DELETE CASCADE` on both link endpoints; v3
  drops it. Nothing is hard-deleted, so it could never fire; retaining links
  to tombstoned nodes is the design; the write path already cleans link rows
  explicitly; and a composite FK across the tenant key would buy nothing but
  rebuild pain.

- **Containment is link rows, not a children array on the parent.** Each edge
  is an independently replicable unit: two devices concurrently inserting
  siblings under the same parent write two different rows that both survive a
  sync — no array-level last-writer-wins conflict. The primary key also makes
  "same block twice under one parent" unrepresentable, which is the sane
  invariant (multi-parent means _different_ parents).
- **Sibling order is a fractional `sort_key`** (string keys ordered
  lexicographically, generated between neighbours — the `fractional-indexing`
  approach used by Figma et al.). Inserting between two siblings touches one
  row; nothing renumbers. Known tax: keys grow with repeated insertion at the
  same spot, so the ingest assigns fresh evenly-spaced keys per note, which
  doubles as the rebalancing mechanism (any future rebalance = re-key the
  siblings of one parent, a handful of rows).
- **No stored upstream, no second direction.** `link_destination` _is_ the
  reverse edge — maintained atomically by the engine, zero drift risk. The
  store exposes `upstream(id)` / `downstream(id)` as first-class methods so
  callers never care that one direction is an index scan.
- **`kind` is `'child'` only, for now.** Tags stay derived from `text` at
  load (the v1 links table was a derived index). Wikilinks were removed as a
  feature — `[[...]]` in text is plain text and produces no edges. The `kind`
  column still reserves the slot: if reference edges are ever worth
  materializing, they land here as another kind — a cache, never truth.
- **No view_state table.** Collapse state is per-device ephemera →
  localStorage, as overrides on top of the default expansion policy (below).

## Type registry

`type` is stored, not derived from markers. `text` is marker-free; the
serializer is a pure type→marker map.

| type           | markdown marker    | notes                                     |
| -------------- | ------------------ | ----------------------------------------- |
| `page`         | — (file root)      | `text` = title; `props` = frontmatter     |
| `text`         | `- `               | plain outline bullet                      |
| `h1` `h2` `h3` | `# ` `## ` `### `  | always expanded by default                |
| `todo`         | `- [ ] `           | checked state is a TYPE, not an attribute |
| `done`         | `- [x] `           |                                           |
| `ul`           | `- ` (styled)      |                                           |
| `ol`           | `1. ` (renumbered) | renderer/serializer renumbers, as today   |
| `quote`        | `> `               |                                           |
| `code`         | fenced block       | `props.language`                          |

Checked-as-type was a deliberate call: type transitions are already the native
mutation (the marker turn-into keys), so toggling a checkbox is
`turnInto(id, type === 'todo' ? 'done' : 'todo')` — one generic helper covers
every type change, and the serializer stays a lookup table with no attribute
branching. The registry extends by adding a row here + a marker mapping; the
`CHECK` constraint is intentionally omitted so new types don't need a
migration.

## Semantics

**Walk.** Rendering a page = start at the page node, follow `kind='child'`
links ordered by `sort_key`, depth-first, serialize each node by type. A node
reached from two parents renders fully in both places — that is the feature,
not a bug.

**Cycles: forbidden at write.** Adding a link P→C is rejected if P is
reachable from C (ancestor check over the in-memory adjacency map — cheap at
this scale). The renderer additionally enforces a hard depth cap as
belt-and-braces, so even a corrupted graph (bad sync merge) cannot hang the
walk.

**Delete = unlink + rescue, never destroy content.**
Deleting node X in the context of parent P:

1. Tombstone the link row P→X (`deleted_at`).
2. If X still has another live inbound `child` link, stop — X lives on there.
3. Otherwise X's row is tombstoned, and each of X's children left with no live
   inbound link gets a new link from the **page root**, appended at the end
   (fresh trailing sort keys). The page node _is_ the dedicated root entity —
   no extra machinery. Children that also live elsewhere in the graph are left
   where they are.

Consequence: no orphan state exists. Nothing is ever unreachable, so no orphan
view, no garbage collection, no materialized orphan cache. Deleting a
container visibly demotes its contents to the page root instead of vanishing
them — never-lose-work, structurally.

Since v3 that "never destroy content" is literal: step 3 stamps a column
rather than issuing a `DELETE`, and X's own outbound links are left alone —
retained, not cascaded, because they describe the shape a restore would put
back. Everything above is what a _reader_ sees, and it is unchanged; the walk
simply skips tombstoned nodes and links into them. Whether unlink-plus-rescue
is still the right rule now that a delete is recoverable is a separate,
deliberately unmade decision.

**Default expansion.** Headers (`h1`–`h3`) always expanded; below any header,
expand **n=2** levels by default. Per-device overrides in localStorage keyed
by node id. The depth cap from the cycle policy doubles as the guard against
pathologically deep transclusion chains.

## Rollup test plan

The rollup replaces stored bytes as the source of exported markdown, so it is
tested harder than anything else:

1. **Real-corpus equivalence.** Ingest every note in the live corpus and
   assert one ingest+rollup pass converges: the output may normalize the
   bytes (near-miss markers, canonical frontmatter — the data-quality pass,
   see graph-storage.md), and must be a strict byte-for-byte fixpoint of a
   second pass. Already-normalized notes round-trip byte-identically.
2. **Property tests.** `parse → rows → rollup → parse` is a fixpoint for
   generated documents covering every type, nesting depth, and marker; plus
   sort-key properties (insert-between always yields a key strictly between
   its neighbours; order survives arbitrary insert sequences).
3. **Named edge cases.** Frontmatter round-trip via `props`; code fences
   containing fake markers (`- [ ]` inside a fence must not become a todo);
   multi-line blocks; empty pages; multi-parent blocks rendering in every
   location; delete-rescue re-parenting; the cycle rejection; ol renumbering;
   unicode/whitespace preservation inside `text`; sort-key collision on
   concurrent same-gap inserts (deterministic tiebreak).
4. **Conformance suite.** `describeNoteStoreConformance` grows the graph
   operations (multi-parent add/remove, delete-rescue, cycle rejection,
   ordered insertion) and runs against the local store; the D1 replica
   handler is exercised by the existing live e2e script, updated for
   node + link rows.

## Sync

Per-row LWW on `updated_at` for both tables, since-cursor pulls of changed
rows, with the existing `isReplicaDrasticallyBehind` guard. Link rows are the
payoff of this shape: concurrent sibling inserts on two devices are two
distinct rows that merge cleanly — no ordering conflict to resolve.

Since v3, **a deletion is just a change**: the tombstoned row carries
`deleted_at` and a fresh `updated_at`, so it arrives in an ordinary since-pull
and the client applies it like any edit. The old deletion-by-absence channel
(the full key lists) is kept as belt-and-braces until tombstone propagation
has proven itself — note that a tombstoned row is still a row and still
appears in those lists, so absence from them now means _purged_.

**Known sharp edge — the cross-parent move.** A move is delete-link +
insert-link (two rows), so it is not atomic under plain LWW: a badly timed
race can briefly double-list or drop a listing. At current scale (single
user, one active device at a time, the flush-on-hide + repull-on-focus
tweaks) this is acceptable; the delete-rescue rule means a dropped listing
resurfaces at the page root rather than disappearing. The real fix is the op
log (`event-sourcing-design.md`), where `move` is a single atomic event — this
schema was shaped so that migration is additive, not another rewrite.

## Migration

No production users; D1 is re-seedable. Sequence, all on `claude/graph-storage`
before PR #11 merges:

1. `migrations/0002_nodes.sql` — create `nodes` + `link`, drop `notes` /
   `blocks` / `links` / `view_state`, bump `schema_version` to 2.
2. Ingest: `parse(md)` → node + link rows (parser unchanged; `docToRows`
   becomes `docToGraph`; evenly-spaced sort keys per parent). Seed script
   re-targets the new shape; re-seed D1 from a fresh notes checkout as the
   final pre-merge step.
3. Read path: the store synthesizes the same `<id>.md` shapes into
   `markdownFilesAtom` via the rollup — the editor, parser, and UI are
   untouched on day one.
4. Write path: saves land as row diffs (changed nodes + changed links only)
   instead of a whole-note replace; replica PUT/GET reshaped accordingly.
5. View-state table dropped; collapse overrides move to localStorage
   (existing per-device state is disposable by design).

Rollback at any step before the D1 re-seed: revert the code, v1 data is
untouched on main's seed.

## Open items

- ~~`props` schema for pages~~ — **decided (2026-W36, the data-quality
  bundle):** individual parsed entries (`{"updated_at": …, "tags": […]}`),
  re-serialized by the canonical YAML serializer; the raw-blob
  `{"frontmatter": "…"}` shape survives as a value-fidelity fallback for
  degenerate YAML and rows from older versions. See graph-storage.md.
- Whether `((blk_x))` syntax survives in `text` as an authoring gesture that
  the editor converts into a child link, or disappears entirely.
- Materialized reference edges (as new link `kind`s) — explicitly deferred;
  with wikilinks removed there is currently nothing to materialize.
- **Future: semantic types.** The cousin schema's `category`/`field` layer
  (user-defined types with typed, ordered fields — Notion-database/Tana-style)
  is the natural next chapter: a `#book` tag carrying `author`/`status`
  fields, queryable. v2 deliberately doesn't preclude it — `type` has no
  CHECK constraint and instance values would live in `props`; formalizing
  means adding a categories/fields pair later, additively. Adopt its
  key-minting discipline when that happens: stable key minted once, display
  name renameable.
