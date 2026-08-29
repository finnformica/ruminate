# Graph storage

The database-backed storage architecture for Ruminate's notes, and what each
phase shipped. This document extends
[architecture-notes.md](./architecture-notes.md); the principles there (stable
`blk_` ids, multi-homing by reference, the `src/data` seam, view state as UI
state) are load-bearing here and are not restated in full.

## The architecture (this branch: database-authoritative)

**On this branch, database mode is THE app experience.** The storage flag
(`ruminate_storage`) defaults to `"database"`: after GitHub sign-in there is no
repo screen and no git pulling — data loads from D1 (seeded with the user's
notes), the local SQL store is the runtime store, and saves write locally and
push to D1 through the replica queue. GitHub OAuth remains purely
identity/auth for the Worker API. Setting the flag to `"git"` restores the
classic experience (repo selection, git sync, note history) unchanged.

```
local SQLite runtime store (wa-sqlite / OPFS)   ← the store the app runs on
    │  PUT /api/replica/notes   (write-behind push, src/data/replica-sync.ts)
    │  GET /api/replica/notes   (boot + since-cursor pulls, src/data/d1-note-source.ts)
    ▼
D1 behind the Worker                            ← the authoritative cross-device copy
```

### How the app is fed (the cutover surgery)

Everything above `src/data` reads one atom: `markdownFilesAtom`, a repo-file
shaped map (`<id>.md` note entries plus `.ruminate/view-state/<id>.json`
sidecar entries). The cutover swaps what feeds that atom and nothing else:

- **Database mode** (`src/data/database-mode.ts`): the SQL store's contents
  are synthesized into the same file-shaped map (`databaseFilesAtom`), and
  `markdownFilesAtom` serves it whenever database mode is active. `notesAtom`,
  tags, templates, search, the collapse-state hook, and the editor's
  external-change path (`useEditorValue`) all work unchanged — including the
  replica push payload builder, which reads the same map.
- **Git mode**: `markdownFilesAtom` serves the machine's worktree walk, as
  always.

The XState machine is not deleted — it still resolves auth, handles
sign-in/sign-out, and provides the signed-out sample notes. In database mode
its `resolveRepo` service refuses immediately, parking the machine in
`signedIn.notCloned` (a state with no service invocations), so no clone, pull,
push, or commit can ever run. The write seam (`src/data/store.ts`) routes
writes to `databaseWriteFiles` instead of the machine's `WRITE_FILES` event.

### Boot, saves, and sync in database mode

- **Boot:** open the SQL store (OPFS; per-tab fallback to memory) → serve
  local contents into the atoms immediately → pull from D1 (full corpus on
  first boot; `?since=<cursor>` after) → apply into the store and atoms. The
  pull cursor persists in the store's `meta` table (`d1_pull_cursor`), so it
  can never outlive the data it describes.
- **Saves:** files-shaped writes land in the files atom synchronously (the UI
  never waits), then the SQL store, then mark the note dirty in the replica
  push queue — the same write-behind, coalesced, backoff-retried
  `replica-sync.ts` loop from phase 3. No git anywhere in the path. In
  database mode the push loop is **not** leader-gated: there is no shared git
  worktree to carry a follower tab's edits to a leader, so every tab pushes
  its own writes.
- **Cross-device sync:** the same triggers the git machine synced on
  (visibility change, coming back online, plus a retry timer after a failed
  pull) re-run the since-cursor pull. Applied changes flow through the store
  into the atoms; the open editor picks them up through `useEditorValue`'s
  existing external-change path.
- **Offline:** the OPFS store serves everything; pushes queue with backoff and
  pulls retry on the `online` event. A first-ever boot while offline shows an
  explanatory empty state; anything written then is kept locally and synced
  later.

### Conflict semantics: last-writer-wins

The D1 model is last-writer-wins, decided by **push order at the replica** —
there is no merge machinery (that was git mode's job):

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
  recoverable from D1 (no history — see "dormant features" below).

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

### Features dormant in database mode (and why)

Git-derived features have nothing to derive from — D1 stores current state
only — so they are hidden rather than disabled-with-a-tooltip (less clutter):

- **Note history** (dialog, note-menu item, palette entry): reconstructs
  versions from commits; hidden. Available in git mode.
- **Day-activity past-day reconstruction**: calendar past days show a simple
  "history isn't available in database mode" placeholder instead of the
  git-reconstructed roll-up.
- **Merge-notice banner / conflicted-copy paths**: pull-merge concepts;
  structurally unreachable (the machine never pulls) and explicitly gated.
- **Open in GitHub**: hidden whenever no repo backs the notes.
- **Sync-status sidebar**: not dormant but re-pointed — it reflects replica
  state (pull in flight / pending pushes / push or pull errors from the
  replica diagnostics) instead of the machine's git sync states.
- **Settings**: the GitHub repo section (choose/change/reset repo) is
  git-mode-only; account + sign out remain. The Storage section toggles
  "Database (default)" / "Git classic" and reloads the app on change (the
  engine decides how the whole app boots).

**No event sourcing — reserved.** The store remains state-based (current rows
only, no per-edit event log). Git already provided audit/time-travel in
classic mode; an event/history layer over the database is deliberately
reserved for later rather than half-built here.

### Git classic (the `"git"` flag value)

The pre-cutover experience, retained as the rollback path: repo screen, git
sync, note history, merge notices. The phase-2 dual-write/shadow-read mirror
(`storage-mirror.ts`) is **off** in git mode — it was the trial that validated
the SQL store while git was canonical, and it is retained (with its tests and
its diagnostics atom, which database mode reuses) but no longer mounted.
Switching modes is "flip the flag" (Settings → Storage); the two stores don't
migrate into each other — git mode re-clones from GitHub, database mode pulls
from D1.

## The contract: `NoteStore` + conformance suite

`src/data/note-store-conformance.ts` exports
`describeNoteStoreConformance(name, makeStore)` — an executable specification
covering write/read/delete round-trips, id-keyed semantics, batch writes,
non-note-namespace isolation, and view-state round-trips (canonical
sorted/deduped sets, empty-clears). Both implementations pass it unchanged:
the git adapter (`src/data/note-store.test.ts`) and the SQL store
(`src/data/sql-note-store.test.ts`). Anything the suite doesn't pin down is an
implementation detail a store may choose freely.

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

The `.ruminate/view-state/<id>.json` sidecars folded into a table, one row per
note, exactly as architecture-notes.md anticipated ("folds cleanly into a
future SQLite `view_state` table"). `collapsed` holds the same canonical
(sorted, de-duplicated) JSON array the sidecar file holds; an empty set is the
absence of a row, mirroring "empty deletes the sidecar file".

### `meta` (key/value)

`schema_version` (currently `1`), `replica_cursor` (D1: the last push a
client confirmed — see "Replication" below), and, in the **local** store only,
`d1_pull_cursor` (the last replica cursor this device pulled through).

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
   line, and persist through the **normal save path**, so the markdown and DB
   can never disagree about an id. Conflicted-copy notes (`<id>-conflict-…`)
   sort after their originals, so the original naturally keeps its ids.
3. **Consequences accepted:** a `((blk_x))` reference or collapsed-state entry
   pointing at a re-keyed block keeps pointing at the keeper's block — the
   right resolution, since before the re-key the reference was ambiguous and
   the keeper is the canonical home.
4. This runs in the git-worktree ingest path (`ingestWorktree`), i.e. when a
   git corpus is (re-)ingested into the SQL store. Content arriving via D1
   pulls was pushed from an ingested corpus, so it is already collision-free.

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

## Replication to D1 (`src/data/replica-sync.ts`)

The push half, shared by both modes (in git-classic it replicated the
worktree; in database mode it replicates the store-fed files map).
**Write-behind, always:** the local write happens first and never waits on the
network; the push is queued afterwards and a push failure can only ever
produce a diagnostic and a retry, never a blocked or lost local write.

- **Coalescing + chunking.** Dirty note ids accumulate in a set; a push runs
  ~2s after the first dirty mark, so rapid saves coalesce into one request.
  Full pushes are chunked (~50 notes per `PUT`) to stay under the Worker body
  cap and D1 batch limits; each note entry is built by the same
  `docToRows`-based builder the local store ingests through, and the payload
  types are imported from `worker/handlers/replica-payload.ts` — the exact
  module the Worker validates with — so the two sides cannot drift.
- **Leadership.** Git mode: leader-tab-only (followers' edits reach the
  leader's worktree via git sync). Database mode: every tab pushes its own
  edits (`isLeader: () => true`) — there is no shared worktree, and
  last-writer-wins at the replica makes concurrent tab pushes safe.
- **Auth.** Same-origin fetch (the `gh_refresh` cookie rides along) plus the
  current GitHub access token as a Bearer header, obtained exactly like the
  git layer's (`ensureFreshToken` proactively, `withAuthRetry` refreshing
  once and retrying on a 401). The pull side (`d1-note-source.ts`) uses the
  identical pattern.
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
  closes before the retry lands. In database mode the next since-pull would
  then resurrect it locally (it is still in `ids`) — visible, correctable by
  deleting again, and bounded by the push backoff window. A durable pending
  queue closes this properly if it ever bites.

## What each phase shipped

- **Phase 1:** the `NoteStore` contract + git adapter + conformance suite; the
  shared schema and migration; the pure `docToRows` / `extractBlockLinks` /
  `findCrossNoteIdCollisions` transforms; the authed D1 replica API skeleton
  and binding.
- **Phase 2:** the local SQLite (wa-sqlite) `NoteStore` passing the
  conformance suite unchanged; ingest through `docToRows` with collision
  re-keying; the `ruminate_storage` flag; the dual-write + shadow-read mirror
  that validated the store against git.
- **Phase 3:** the client-side replica push (`src/data/replica-sync.ts` —
  write-behind, coalesced, chunked, monotonic cursor) feeding
  `PUT /api/replica/notes`; the shared wire-format module
  (`worker/handlers/replica-payload.ts`); replica status + full-push action in
  the Settings Storage panel; the live D1 end-to-end script
  (`scripts/replica-e2e.ts`).
- **Cutover (this branch):** database-authoritative mode as the default —
  `GET /api/replica/notes` (full + since-cursor pulls), `database-mode.ts` +
  `d1-note-source.ts` on the client, the repo screen and git sync retired to
  the `"git"` flag value, git-derived features dormant in database mode,
  last-writer-wins as the documented conflict model.
