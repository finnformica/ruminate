# Graph storage

The database-backed storage architecture Ruminate runs on. This document
extends [architecture-notes.md](./architecture-notes.md); the principles there
(stable `blk_` ids, multi-homing by reference, the `src/data` seam, view state
as UI state) are load-bearing here and are not restated in full.

## The architecture: database-authoritative

**Database storage is THE app.** After GitHub sign-in — which is purely
identity/auth for the Worker API — data loads from D1 (the authoritative
cross-device copy), the local SQL store is the runtime store, and saves write
locally and push to D1 through the replica queue. Signed out, the sample notes
render. There is no git anywhere in the data path.

```
local SQLite runtime store (wa-sqlite / OPFS)   ← the store the app runs on
    │  PUT /api/replica/notes   (write-behind push, src/data/replica-sync.ts)
    │  GET /api/replica/notes   (boot + since-cursor pulls, src/data/d1-note-source.ts)
    ▼
D1 behind the Worker                            ← the authoritative cross-device copy
```

### How the app is fed

Everything above `src/data` reads one atom: `markdownFilesAtom`, a
repo-file-shaped map (`<id>.md` note entries plus
`.ruminate/view-state/<id>.json` sidecar entries). `src/data/database-mode.ts`
synthesizes that map from the SQL store's contents (`databaseFilesAtom`), and
`markdownFilesAtom` serves it whenever a user is signed in. `notesAtom`, tags,
templates, search, the collapse-state hook, the editor's external-change path
(`useEditorValue`), and the replica push payload builder all read the same
shape.

A small XState machine (`src/global-state.ts`) handles the rest: auth
resolution at boot (`resolvingUser` → `signedIn` / `signedOut`),
sign-in/sign-out, and the signed-out sample notes. The write seam
(`src/data/store.ts`) routes all writes to `databaseWriteFiles`; signed out
(sample notes) the runtime is not mounted and writes are no-ops.

### Boot, saves, and sync

- **Boot:** open the SQL store (OPFS; per-tab fallback to memory) → serve
  local contents into the atoms immediately → pull from D1 (full corpus on
  first boot; `?since=<cursor>` after) → apply into the store and atoms. The
  pull cursor persists in the store's `meta` table (`d1_pull_cursor`), so it
  can never outlive the data it describes.
- **Saves:** files-shaped writes land in the files atom synchronously (the UI
  never waits), then the SQL store, then mark the note dirty in the replica
  push queue — write-behind, coalesced, backoff-retried (`replica-sync.ts`).
  The push loop is not leader-gated: every tab pushes its own writes, and
  last-writer-wins at the replica makes concurrent tab pushes safe.
- **Cross-device sync:** visibility change and coming back online (plus a
  retry timer after a failed pull) re-run the since-cursor pull. Applied
  changes flow through the store into the atoms; the open editor picks them up
  through `useEditorValue`'s existing external-change path.
- **Offline:** the OPFS store serves everything; pushes queue with backoff and
  pulls retry on the `online` event. A first-ever boot while offline shows an
  explanatory empty state; anything written then is kept locally and synced
  later.

### Conflict semantics: last-writer-wins

The D1 model is last-writer-wins, decided by **push order at the replica** —
there is no merge machinery:

- A pull never touches a note with a queued or in-flight local push
  (`ReplicaSyncHandle.pendingNoteIds`), so pull timing cannot revert an edit
  that is on its way out — and a locally created, not-yet-pushed note cannot
  be "deleted" for being unknown remotely.
- The editor's remote-change notice still protects **unsaved** local edits: a
  pulled change landing under uncommitted typing raises the non-blocking
  "updated on another device" notice, and a plain save stays blocked until the
  user picks a side ("Show latest" / "Save mine anyway").
- Two devices editing the same note and both pushing: the later push wins
  wholesale. Accepted for a single-user app; the losing content is not
  recoverable from D1 (no history — see "no event sourcing" below).

### Since-pull fidelity (accepted limits)

The replica tracks no per-note change time beyond `notes.updated_at` (the
frontmatter timestamp `useSaveNote` stamps on every save), so incremental
pulls return notes with `updated_at >` the since-timestamp. Consequences,
accepted and mitigated:

- Clock skew between devices could miss a change → the client pulls with a
  10-minute overlap window (`SINCE_OVERLAP_MS`); re-applying identical content
  is a no-op.
- Notes with a null `updated_at` (never saved through the editor) and
  view-state-only changes don't surface in `changed` → caught by the next full
  pull; cosmetic in practice.
- Deletions have no tombstones → every since-pull response carries `ids`, the
  full remote id list, and the client deletes local notes absent from it
  (pending-push notes excepted).

### What the database deliberately does not do

D1 stores current state only, so history-derived features have no source and
do not exist in the app:

- **Note version history**: no per-edit log; a save replaces the row.
- **Past-day reconstruction**: calendar past days show a simple "history isn't
  available" placeholder instead of a reconstructed roll-up.
- **File attachments**: uploads were a git-repo feature; legacy `/uploads`
  references in note content render as inert placeholders.

**No event sourcing — reserved.** The store remains state-based (current rows
only, no per-edit event log). An event/history layer over the database — which
would bring back version history and day roll-ups — is deliberately reserved
for later rather than half-built here.

## The contract: `NoteStore` + conformance suite

`src/data/note-store-conformance.ts` exports
`describeNoteStoreConformance(name, makeStore)` — an executable specification
covering write/read/delete round-trips, id-keyed semantics, batch writes,
non-note-namespace isolation, and view-state round-trips (canonical
sorted/deduped sets, empty-clears). The SQL store
(`src/data/sql-note-store.test.ts`) passes it; anything the suite doesn't pin
down is an implementation detail a store may choose freely.

## Schema (`migrations/0001_init.sql`)

One migration file in the wrangler d1 migrations layout, written in strictly
shared SQLite dialect so the identical file initializes both the D1 database
(`wrangler d1 migrations apply ruminate`) and the local wa-sqlite store. No
D1- or wa-sqlite-specific syntax.

### `notes` (id TEXT PK, content, updated_at)

The full verbatim markdown, frontmatter included. Rationale: the database must
answer "what is this note, exactly?" on its own, and every derived row
(blocks, links) must be re-derivable from `notes.content` alone. `updated_at`
is the frontmatter timestamp (ms epoch) when present — `useSaveNote` stamps it
on every editor save, which is what makes since-pulls workable. Note ids are
the app's existing ids — filenames minus `.md` — unchanged.

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
- Known gap, accepted: links appearing only in frontmatter (frontmatter
  wikilinks, date fields) have no source block, so they are not in `links`;
  they remain derivable from `notes.content`.

### `view_state` (note_id PK, collapsed JSON)

Per-note view state (collapsed block ids), one row per note, exactly as
architecture-notes.md anticipated ("folds cleanly into a future SQLite
`view_state` table"). `collapsed` holds a canonical (sorted, de-duplicated)
JSON array; an empty set is the absence of a row. Above `src/data` it still
travels as `.ruminate/view-state/<id>.json` entries in the files map.

### `meta` (key/value)

`schema_version` (currently `1`), `replica_cursor` (D1: the last push a
client confirmed — see "Replication" below), and, in the **local** store only,
`d1_pull_cursor` (the last replica cursor this device pulled through).

## Cross-file block-id dedup

architecture-notes.md deferred cross-file id dedup to "the eventual DB
migration". `parse.ts` regenerates duplicate ids _within_ one document; across
notes, `findCrossNoteIdCollisions` (`src/data/doc-to-rows.ts`) detects
collisions deterministically (collisions by block id, notes by note id, first
note is the keeper). The seed script (`scripts/seed-d1.ts`) reports collisions
when a corpus is seeded; content flowing through the app (saves, D1 pulls) is
collision-free because `parse` mints fresh ids for duplicates it sees within a
document and every note pushed to D1 came from a seeded-then-edited corpus.

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
- `GET /api/replica/notes` — corpus pull, the read half:
  - Full: `{ notes: [{note: {id, content, updated_at}, view_state}], cursor }`.
    **Note rows + view state only** — blocks and links are derivable
    client-side from `note.content` via the same `docToRows` transform that
    produced them, so shipping them would multiply the payload for zero
    information; `view_state` is not derivable, so it rides along.
  - `?since=<cursor>`: `{ changed: [...same shape], ids: [...all note ids],
cursor }` — `changed` is `updated_at > since`, `ids` is always the full id
    list for deletion-by-absence (see "Since-pull fidelity" above). A
    malformed `since` is a 400.
  - The pure parts (`parseSinceCursor`, `buildPullNotes`) live in
    `replica-payload.ts` and are unit-tested alongside the PUT planners.
- `GET /api/replica/status` — row counts per table, `schema_version`,
  `replica_cursor`.
- **Auth:** every route is guarded by `requireSession`: the `gh_refresh`
  HttpOnly cookie (set by `/github-auth`, rotated by `/github-refresh`; its
  presence proves the browser holds a session this Worker created, and
  SameSite=Lax blocks cross-site sends) plus the GitHub access token as
  `Authorization: Bearer`, verified against `GET https://api.github.com/user`
  — and the verified GitHub id must match `ALLOWED_GITHUB_ID`
  (wrangler.jsonc): the app is single-user and the database only ever holds
  the owner's notes, so any other valid GitHub account gets a 403. If the
  per-request GitHub round-trip ever matters, cache verification results in
  `caches.default` keyed by a token hash.

## Replication to D1 (`src/data/replica-sync.ts`)

The push half. **Write-behind, always:** the local write happens first and
never waits on the network; the push is queued afterwards and a push failure
can only ever produce a diagnostic and a retry, never a blocked or lost local
write.

- **Coalescing + chunking.** Dirty note ids accumulate in a set; a push runs
  ~2s after the first dirty mark, so rapid saves coalesce into one request.
  Full pushes are chunked (~50 notes per `PUT`) to stay under the Worker body
  cap and D1 batch limits; each note entry is built by the same
  `docToRows`-based builder the local store ingests through, and the payload
  types are imported from `worker/handlers/replica-payload.ts` — the exact
  module the Worker validates with — so the two sides cannot drift.
- **Every tab pushes its own edits.** There is no shared local store carrying
  one tab's edits to another, and last-writer-wins at the replica makes
  concurrent tab pushes safe.
- **Auth.** Same-origin fetch (the `gh_refresh` cookie rides along) plus the
  current GitHub access token as a Bearer header (`ensureFreshToken`
  proactively, `withAuthRetry` refreshing once and retrying on a 401). The
  pull side (`d1-note-source.ts`) uses the identical pattern.
- **Resilience.** A failed push returns its notes to the dirty set and
  retries with exponential backoff (2s doubling to a 60s cap); the browser's
  `online` event short-circuits the wait. Failures are recorded in the
  Settings diagnostics, never thrown.
- **Cursor.** Each push carries a monotonic ms-timestamp cursor (sent only
  with the final chunk, so it means "the replica reflects local state as of
  this push"). `GET /api/replica/status` echoes it back — the Settings panel
  shows it as confirmed — and supplies remote row counts. If the counts show
  the replica drastically behind (empty, or missing >10% of the corpus), a
  full push is scheduled automatically (cooldown-guarded); the Settings panel
  also has a manual "Push full copy to D1 now" action.
- **Known gap, accepted:** pending deletes live only in memory, so a note
  deleted while the replica was unreachable can linger remotely if the tab
  closes before the retry lands. The next since-pull would then resurrect it
  locally (it is still in `ids`) — visible, correctable by deleting again, and
  bounded by the push backoff window. A durable pending queue closes this
  properly if it ever bites.

## History: the git era

Until this architecture landed, Ruminate was a git app: notes were markdown
files in a GitHub repository cloned into the browser (isomorphic-git +
lightning-fs), synced by a pull/commit/push state machine, with version
history, merge drivers, conflicted-copy notes, and a repo-selection screen.
That architecture is recorded in [architecture-notes.md](./architecture-notes.md)
and in git history (`main` holds the git app until this branch merges). The
database architecture was built alongside it in phases — the `NoteStore`
contract + conformance suite and shared schema first, then the local
wa-sqlite store validated by a dual-write/shadow-read mirror while git stayed
canonical, then write-behind D1 replication, then the cutover — and the git
path, the storage flag, and the mirror were deleted once the database became
the app.
