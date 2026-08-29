# Graph schema v2: blocks-first storage

Status: **design agreed, not yet implemented.** Decided in discussion on
2026-08-29; supersedes the v1 schema in `migrations/0001_init.sql` (documented
in `graph-storage.md`). To be built on `claude/graph-storage` before PR #11
merges, while the zero-migration window is open (single user, D1 re-seedable
from the notes repo in minutes).

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
aggregate; every mutation is a text edit, a type change, or a children-array
splice.

What it costs: markdown flips from _preserved bytes_ to _canonical
serialization_. The rollup is deterministic and stable (the editor's
`parse(serialize(doc))` round-trip invariant already guarantees canonical form
is a fixpoint), but exported files are rendered, not stored. The rollup is
therefore the most load-bearing function in the app — see the test plan below.

## Schema

Two tables. One dialect, two engines (D1 + local sqlite-wasm), same as v1.

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,       -- blk_ ids as-is; page nodes use the note id
  type TEXT NOT NULL,        -- see the type registry below
  text TEXT NOT NULL,        -- marker-free content; for pages, the title
  children TEXT NOT NULL DEFAULT '[]',  -- ordered JSON array of node ids
  props TEXT,                -- JSON or NULL; pages: frontmatter; code: language
  updated_at INTEGER NOT NULL  -- ms epoch, drives LWW + since-cursor pulls
);

CREATE INDEX nodes_type ON nodes (type);        -- "all pages", "all todos"
CREATE INDEX nodes_updated ON nodes (updated_at);  -- since-cursor pulls

CREATE TABLE meta (
  key TEXT PRIMARY KEY,      -- schema_version = '2', replica_cursor
  value TEXT NOT NULL
);
```

Deliberate absences, and why:

- **No edges table.** Containment lives in the parent's ordered `children`
  array. Array order _is_ position: reordering is one row write, no
  renumbering, no fractional positions. Multi-parent = the same id listed in
  several arrays.
- **No upstream column, ever.** Upstream (parents-of, backlinks) is derived —
  a one-pass in-memory adjacency map built at load. Persisting both directions
  creates a consistency invariant that can drift; the derived map cannot.
  The store exposes `upstream(id)` / `downstream(id)` as first-class methods
  so callers never care where the answer comes from.
- **No links table.** Wikilinks and tags are already encoded in `text`; the
  v1 table was a derived index. v2 computes the reference graph in memory at
  load. If scale ever demands it, a materialized backlinks cache is a pure
  optimization added later — same category as any other cache, never truth.
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

**Walk.** Rendering a page = start at the page node, walk `children`
depth-first, serialize each node by type. A node reached from two parents
renders fully in both places — that is the feature, not a bug.

**Cycles: forbidden at write.** Adding child C to parent P is rejected if P is
reachable from C (ancestor check over the in-memory adjacency map — cheap at
this scale). The renderer additionally enforces a hard depth cap as
belt-and-braces, so even a corrupted graph (bad sync merge) cannot hang the
walk.

**Delete = unlink + rescue, never destroy content.**
Deleting node X in the context of parent P:

1. Remove X from P's `children`.
2. If X still appears in some other parent's array, stop — X lives on there.
3. Otherwise X's row is deleted, and X's children that are now parentless are
   **appended to the page root's `children` array** (the page node _is_ the
   dedicated root entity — no extra machinery). Children that also live
   elsewhere in the graph are left where they are.

Consequence: no orphan state exists. Nothing is ever unreachable, so no orphan
view, no garbage collection, no materialized orphan cache. Deleting a
container visibly demotes its contents to the page root instead of vanishing
them — never-lose-work, structurally.

**Default expansion.** Headers (`h1`–`h3`) always expanded; below any header,
expand **n=2** levels by default. Per-device overrides in localStorage keyed
by node id. The depth cap from the cycle policy doubles as the guard against
pathologically deep transclusion chains.

## Rollup test plan

The rollup replaces stored bytes as the source of exported markdown, so it is
tested harder than anything else:

1. **Real-corpus equivalence.** Ingest every note in the live corpus both
   ways and assert `rollup(ingest(md)) === canonicalize(md)` byte-for-byte
   (`canonicalize` = the existing `serialize(parse(md))`, already a fixpoint).
2. **Property tests.** `parse → nodes → rollup → parse` is a fixpoint for
   generated documents covering every type, nesting depth, and marker.
3. **Named edge cases.** Frontmatter round-trip via `props`; code fences
   containing fake markers (`- [ ]` inside a fence must not become a todo);
   multi-line blocks; empty pages; multi-parent blocks rendering in every
   location; delete-rescue re-parenting; the cycle rejection; ol renumbering;
   unicode/whitespace preservation inside `text`.
4. **Conformance suite.** `describeNoteStoreConformance` grows the graph
   operations (multi-parent add/remove, delete-rescue, cycle rejection) and
   runs against the local store; the D1 replica handler is exercised by the
   existing live e2e script, updated for node rows.

## Sync

Per-node LWW on `updated_at`, since-cursor pulls of changed node rows,
deletion handled replica-side by id-absence with the existing
`isReplicaDrasticallyBehind` guard. Pushes ship node rows (no derived data —
there is none to ship).

**Known sharp edge — the cross-parent move.** A move touches two rows (source
parent's array, destination parent's array), so it is not atomic under plain
LWW: two devices racing can double-list or drop a node. At current scale
(single user, one active device at a time, the flush-on-hide + repull-on-focus
tweaks) this is acceptable; the delete-rescue rule means a dropped listing
resurfaces at the page root rather than disappearing. The real fix is the op
log (`event-sourcing-design.md`), where `move` is a single atomic event — this
schema was shaped so that migration is additive, not another rewrite.

## Migration

No production users; D1 is re-seedable. Sequence, all on `claude/graph-storage`
before PR #11 merges:

1. `migrations/0002_nodes.sql` — create `nodes`, drop `notes` / `blocks` /
   `links` / `view_state`, bump `schema_version` to 2.
2. Ingest: `parse(md)` → node rows (parser unchanged; `docToRows` becomes
   `docToNodes`). Seed script re-targets the new shape; re-seed D1 from a
   fresh notes checkout as the final pre-merge step.
3. Read path: the store synthesizes the same `<id>.md` shapes into
   `markdownFilesAtom` via the rollup — the editor, parser, and UI are
   untouched on day one.
4. Write path: saves land as node-row diffs (changed nodes only) instead of a
   whole-note replace; replica PUT/GET reshaped to node rows.
5. View-state table dropped; collapse overrides move to localStorage
   (existing per-device state is disposable by design).

Rollback at any step before the D1 re-seed: revert the code, v1 data is
untouched on main's seed.

## Open items

- `props` schema for pages (frontmatter keys carried as-is vs typed fields) —
  decide during implementation.
- Whether `((blk_x))` syntax survives in `text` as an authoring gesture that
  the editor converts into a children-array entry, or disappears entirely.
- Materialized backlink cache — explicitly deferred until in-memory
  derivation measurably hurts.
