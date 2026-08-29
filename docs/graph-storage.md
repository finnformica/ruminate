# Graph storage

The trial architecture for moving Ruminate's blocks into a database as a
graph, and what each phase ships. This document extends
[architecture-notes.md](./architecture-notes.md); the principles there (stable
`blk_` ids, multi-homing by reference, the `src/data` seam, view state as UI
state) are load-bearing here and are not restated in full.

## The trial architecture

Three stores, one contract, git stays canonical:

```
git/markdown (source of truth)
    │  parse (src/blocks) + docToRows (src/data/doc-to-rows.ts)
    ▼
local SQLite runtime store          ← Phase 2 (wa-sqlite in the browser)
    │  PUT /api/replica/notes
    ▼
D1 replica behind the Worker        ← Phase 3 (this repo's Worker + D1)
```

- **Git/markdown remains the source of truth for the whole trial.** Every
  write still lands as a markdown file and commits/syncs exactly as today. The
  SQLite store and the D1 replica are _derived_ — rebuildable at any time by
  re-ingesting the repo — so a bug in the new path can never lose a note.
- **The swap point is `src/data`.** The `NoteStore` interface
  (`src/data/note-store.ts`) is the typed contract extracted from what
  `src/data` provides today: note CRUD by id, bulk read, view-state get/set.
  The git-backed implementation (`createGitNoteStore`) is a thin adapter over
  the existing machine primitives; the Phase 2 SQLite store implements the
  same interface. Callers do not change.
- **A storage flag selects the implementation.** Phase 2 introduces a flag
  (planned: `localStorage["ruminate_storage"]`, values `"git"` (default) |
  `"sqlite"`) read once at startup where `src/data` constructs its store. The
  flag flips only the _runtime read/query_ path; writes go to git in both
  modes during the trial. Rollback is "flip the flag back" — no data
  migration in either direction, because the SQLite side is derived.
- **Cutover is a post-trial decision, not part of this work.** Criteria to
  evaluate at the end of the trial: (1) the conformance suite plus a shadow
  period (both stores populated, reads compared) shows no divergence; (2)
  graph queries (backlinks, block transclusions, tags) are correct and faster
  than the in-memory reparse they replace; (3) sync/merge behavior is not
  degraded; (4) the ceilings in "Scale limits" (architecture-notes.md) are
  actually lifted. Only then does a later phase consider making the DB
  canonical and demoting markdown to an export format.

## The contract: `NoteStore` + conformance suite

`src/data/note-store-conformance.ts` exports
`describeNoteStoreConformance(name, makeStore)` — an executable specification
covering write/read/delete round-trips, id-keyed semantics, batch writes,
non-note-namespace isolation, and view-state round-trips (canonical
sorted/deduped sets, empty-clears). The git adapter passes it today
(`src/data/note-store.test.ts`, backed by an in-memory `GitStoreBackend`);
Phase 2's SQLite store must pass it **unchanged**. Anything the suite doesn't
pin down is an implementation detail a store may choose freely.

## Schema (`migrations/0001_init.sql`)

One migration file in the wrangler d1 migrations layout, written in strictly
shared SQLite dialect so the identical file initializes both the D1 replica
(`wrangler d1 migrations apply ruminate`) and the Phase 2 wa-sqlite store. No
D1- or wa-sqlite-specific syntax.

### `notes` (id TEXT PK, content, updated_at)

The full verbatim markdown, frontmatter included. Rationale: git is
canonical, so the replica must be able to answer "what is this note,
exactly?" without consulting the repo, and every derived row (blocks, links)
must be re-derivable from the replica alone. `updated_at` is the frontmatter
timestamp (ms epoch) when present. Note ids are the app's existing ids —
filenames minus `.md` — unchanged.

### `blocks` (id TEXT PK, note_id FK, parent_id, position, content)

The outline tree, relationally: `parent_id` NULL for roots, `position` the
0-based sibling index, so `(note_id, parent_id, position)` reconstructs the
tree `BlockDoc` holds in `children` arrays. `content` is the block's own raw
markdown (no children, no `id::` line) — same as `Block.content`.

- **Ids stay `blk_` TEXT.** Per architecture-notes.md, no UUID migration: the
  existing ids are globally unique, stable, persisted inline in the markdown,
  and a `TEXT` primary key keys fine. This is precisely the "clean re-key
  rather than archaeology" payoff the inline `id::` lines were kept for.
- No FK on `parent_id` (a note's blocks can then be replaced in any order);
  `note_id` has `ON DELETE CASCADE` so a note deletion can't strand rows.
- Index `blocks_note_position (note_id, position)` for outline reads.

### `links` (from_block, to_note, to_block, kind) — the graph

This table is the point of the exercise: the edges that make blocks a graph
rather than a tree, populated from the existing parse (the same micromark
extensions `parseNote` uses) by `docToRows` in `src/data/doc-to-rows.ts`.

| kind           | source syntax                | to_note  | to_block |
| -------------- | ---------------------------- | -------- | -------- |
| `wikilink`     | `[[note]]`, `[[note\|text]]` | note id  | NULL     |
| `transclusion` | `![[note]]`                  | note id  | NULL     |
| `transclusion` | `((blk_x))`                  | NULL     | block id |
| `tag`          | `#tag`, `#a/b`               | tag name | NULL     |

- **Multi-homing is by reference** (architecture-notes.md): a block has one
  physical home row in `blocks`; appearing elsewhere is a `transclusion` edge,
  never a copy. Note embeds and block references are deliberately the same
  `kind` — both mean "render that content here".
- **Targets are unconstrained** (no FKs): a wikilink to a note that doesn't
  exist yet is normal and must be storable; it becomes a backlink the moment
  the note is created.
- **Tags are name-keyed nodes.** For `kind = 'tag'`, `to_note` holds the tag
  name. Only the full tag is stored (`#a/b/c` → one edge to `a/b/c`); the
  ancestor expansion `parseNote` does in memory happens at query time
  (`to_note = ? OR to_note LIKE ? || '/%'`), keeping the stored graph minimal.
- Edges are de-duplicated per block by the transform, and a unique expression
  index (`COALESCE`d, since SQLite treats NULLs as distinct) makes replays
  idempotent at the schema level.
- Indexes: `to_note` (backlinks — the query this table exists for),
  `to_block` (block-level backlinks), `from_block` (outgoing edges and
  replace-time cleanup). "Which _notes_ link here" is
  `links JOIN blocks ON links.from_block = blocks.id`.
- Known gap, accepted for the trial: links appearing only in frontmatter
  (frontmatter wikilinks, date fields) have no source block, so they are not
  in `links`; they remain derivable from `notes.content`. Phase 2 decides
  whether they warrant a synthetic frontmatter edge or query-time derivation.

### `view_state` (note_id PK, collapsed JSON)

The `.ruminate/view-state/<id>.json` sidecars folded into a table, one row per
note, exactly as architecture-notes.md anticipated ("folds cleanly into a
future SQLite `view_state` table"). `collapsed` holds the same canonical
(sorted, de-duplicated) JSON array the sidecar file holds; an empty set is the
absence of a row, mirroring "empty deletes the sidecar file".

### `meta` (key/value)

`schema_version` (currently `1`) and `replica_cursor` — an opaque,
client-supplied marker of the last replicated repo state (in practice the git
HEAD sha at push time), letting the client and the status endpoint agree on
how fresh the replica is without diffing content.

## Cross-file block-id dedup (designed here, at the migration)

architecture-notes.md defers cross-file id dedup to "the eventual DB
migration" — which is this one. `parse.ts` already regenerates duplicate ids
_within_ one document, but two different notes can legitimately carry the same
persisted `id::` line (a whole note duplicated in an external editor, a
conflicted-copy note created by sync). Files tolerate that; a database keyed
on `blocks.id` cannot.

**Design:**

1. **Detect on ingest.** Before rows are written, run
   `findCrossNoteIdCollisions(notes)` (`src/data/doc-to-rows.ts`) over the
   corpus. It parses each note with the real `parse` — so it sees exactly the
   ids ingest would insert — and reports every block id declared by more than
   one note, deterministically ordered (collisions by block id, notes by note
   id).
2. **First note keeps the id; later ones re-key.** For each collision, the
   first note in order is the keeper. Every other note gets the colliding
   block re-keyed: mint a fresh id (`blockId()`), rewrite that block's `id::`
   line, and persist through the **normal save path** (parse → replace id →
   serialize → `writeNotes`), so the rewrite is an ordinary commit that syncs
   like any edit and the markdown and DB can never disagree about an id.
   Conflicted-copy notes (`<id>-conflict-…`) sort after their originals, so
   the original naturally keeps its ids and the copy — whose ids nothing
   should reference — is the one re-keyed.
3. **Consequences accepted:** a `((blk_x))` reference or collapsed-state entry
   pointing at a re-keyed block keeps pointing at the keeper's block — the
   right resolution, since before the re-key the reference was ambiguous and
   the keeper is the canonical home.
4. **Phased:** detection (step 1) is implemented and tested now. The actual
   rewriting (step 2) ships with Phase 2's ingest, behind the storage flag —
   it is a write to user data and belongs with the code path that needs the
   invariant. Until then a collision simply means those notes are not yet
   ingestible, which the trial surfaces via the detection helper.

## Worker replica API (`/api/replica/*`)

`worker/handlers/replica.ts`, routed like every other API route via
`run_worker_first` in wrangler.jsonc.

- `PUT /api/replica/notes` — batch upsert of `{note, blocks, links,
view_state}` entries (plus optional `deletes` and `cursor`), executed as a
  single `db.batch()` — one atomic D1 transaction. Each note is a full
  replace: upsert the note row, drop its old links/blocks, insert the new
  rows. Payloads are validated (`parseReplicaPayload`) and planned
  (`planReplicaPut`) by pure, unit-tested functions; the D1 wiring is a thin
  shell typed against `@cloudflare/workers-types`.
- `GET /api/replica/status` — row counts per table, `schema_version`,
  `replica_cursor`.
- **Auth:** every route is guarded by `requireSession`, which reuses the two
  session mechanisms the Worker already has: the `gh_refresh` HttpOnly cookie
  (set by `/github-auth`, rotated by `/github-refresh`; its presence proves
  the browser holds a session this Worker created, and SameSite=Lax blocks
  cross-site sends) and the GitHub access token as `Authorization: Bearer`,
  verified against `GET https://api.github.com/user` — the same check
  `/github-auth` performs when minting a session. Ruminate is a single-user
  app and the database only ever holds that user's notes, so _any_ valid
  GitHub session suffices; there is deliberately no per-user scoping. If the
  per-request GitHub round-trip ever matters, cache verification results in
  `caches.default` keyed by a token hash.

## What each phase ships

- **Phase 1 (this change):** the `NoteStore` contract + git adapter +
  conformance suite; the shared schema and migration; the pure
  `docToRows` / `extractBlockLinks` / `findCrossNoteIdCollisions` transforms;
  the authed D1 replica API skeleton and binding. No caller changes, no UI
  changes, nothing applied remotely.
- **Phase 2:** the local SQLite (wa-sqlite) `NoteStore` passing the
  conformance suite unchanged; ingest of the repo through `docToRows` with
  collision re-keying; the `ruminate_storage` flag wiring in `src/data`;
  graph queries (backlinks, tags, block transclusions) served from SQL.
- **Phase 3:** the client-side replica push (debounced after sync, cursor =
  HEAD sha) feeding `/api/replica/notes`; the status endpoint surfacing
  replica freshness in settings.
- **Post-trial:** the cutover decision, per the criteria above.
