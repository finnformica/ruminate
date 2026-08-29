# Graph storage

The database-backed storage architecture Ruminate runs on. This document
extends [architecture-notes.md](./architecture-notes.md); the principles there
(stable `blk_` ids, multi-homing by reference, the `src/data` seam, view state
as UI state) are load-bearing here and are not restated in full. The schema
itself — and the reasoning behind it — is
[graph-schema-v2.md](./graph-schema-v2.md); this document describes how the
app runs on it.

## The architecture: database-authoritative, blocks-first

**Database storage is THE app.** After GitHub sign-in — which is purely
identity/auth for the Worker API — data loads from D1 (the authoritative
cross-device copy), the local SQL store is the runtime store, and saves write
locally and push to D1 through the replica queue. Signed out, the sample notes
render. There is no git anywhere in the data path.

**The graph is truth; markdown is a projection.** Since schema v2, both
databases hold typed `nodes` + containment `link` rows, not markdown. A note's
markdown is the _rollup_ — `rollup(pageId)` walks the page node's child links
in sort-key order and serializes each node by type — and every save is parsed
back into row diffs by `docToGraph`/`docToGraphParts`
(`src/data/graph.ts`). For canonical markdown (the editor's own
`serialize(parse(md))` fixpoint) the round trip is byte-identical — the most
heavily tested invariant in the app (`src/data/graph.test.ts`, plus
`scripts/rollup-equivalence.ts` for checking a real corpus directory).

```
local SQLite runtime store (sqlite-wasm / OPFS)   ← the store the app runs on
    │  PUT /api/replica/notes   (row-diff push, src/data/replica-sync.ts)
    │  GET /api/replica/notes   (boot + since-cursor row pulls, src/data/d1-note-source.ts)
    ▼
D1 behind the Worker                              ← the authoritative cross-device copy
```

### How the app is fed

Everything above `src/data` reads one atom: `markdownFilesAtom`, a
repo-file-shaped map of `<id>.md` entries. `src/data/database-mode.ts`
synthesizes that map from the SQL store — each entry is the rollup of its page
node — into `databaseFilesAtom`, and `markdownFilesAtom` serves it whenever a
user is signed in. `notesAtom`, tags, templates, search, the editor's
external-change path (`useEditorValue`), all read the same shape. The editor,
parser, and UI were untouched by the v2 cutover — they still speak markdown.

A small XState machine (`src/global-state.ts`) handles the rest: auth
resolution at boot (`resolvingUser` → `signedIn` / `signedOut`),
sign-in/sign-out, and the signed-out sample notes. The write seam
(`src/data/store.ts`) routes all writes to `databaseWriteFiles`; signed out
(sample notes) the runtime is not mounted and writes are no-ops.

### Boot, saves, and sync

- **Boot:** open the SQL store (OPFS; per-tab fallback to memory) → serve
  local rollups into the atoms immediately → pull rows from D1 (full corpus on
  first boot; `?since=<cursor>` after) → apply into the store and atoms. The
  pull cursor persists in the store's `meta` table (`d1_pull_cursor`), so it
  can never outlive the data it describes.
- **Saves:** files-shaped writes land in the files atom synchronously (the UI
  never waits), then the SQL store ingests them as a **row diff** — nodes
  whose type/text/props changed, links whose sort key changed, deletions —
  and that diff (not a whole-note replace) is queued for the replica —
  write-behind, coalesced by row, backoff-retried (`replica-sync.ts`). Hiding
  or closing the tab flushes the queue immediately with `fetch keepalive`.
  The push loop is not leader-gated: every tab pushes its own writes, and
  per-row last-writer-wins at the replica makes concurrent tab pushes safe.
- **Cross-device sync:** visibility change, window focus, and coming back
  online (plus a retry timer after a failed pull) re-run the since-cursor
  pull. Applied rows flow through the store into the atoms; the open editor
  picks them up through `useEditorValue`'s existing external-change path.
- **Offline:** the OPFS store serves everything; pushes queue with backoff and
  pulls retry on the `online` event. A first-ever boot while offline shows an
  explanatory empty state; anything written then is kept locally and synced
  later. If a _second_ tab opens while another holds the OPFS database, the
  tab says so honestly ("open in another tab — temporary in-memory copy",
  with a reload action) instead of showing an empty corpus; detection is a
  Web Lock the owning tab holds.

### Conflict semantics: per-row last-writer-wins

Sync is per-row LWW on `updated_at`, decided by push order at the replica —
there is no merge machinery, but the unit of conflict shrank from a note to a
row:

- Two devices editing _different blocks_ of the same note now merge cleanly —
  each edit is its own node row. Concurrent sibling inserts are two distinct
  link rows that both survive. Only edits to the _same block_ collide, and the
  later push wins.
- A pull never touches rows belonging to a note with a queued or in-flight
  local push (`ReplicaSyncHandle.pendingNoteIds`, expanded to the page's
  subtree), so pull timing cannot revert an edit that is on its way out — and
  a locally created, not-yet-pushed note cannot be "deleted" for being unknown
  remotely.
- The editor's remote-change notice still protects **unsaved** local edits: a
  pulled change landing under uncommitted typing raises the non-blocking
  "updated on another device" notice, and a plain save stays blocked until the
  user picks a side ("Show latest" / "Save mine anyway").
- Known sharp edge — the cross-parent move (delete-link + insert-link, two
  rows) is not atomic under plain LWW; see graph-schema-v2.md. Accepted at
  current scale; the delete-rescue rule means a dropped listing resurfaces at
  the page root rather than disappearing.

### Since-pull fidelity (accepted limits)

Incremental pulls return rows with `updated_at >` the since-timestamp, per
table. Consequences, accepted and mitigated:

- Clock skew between devices could miss a change → the client pulls with a
  10-minute overlap window (`SINCE_OVERLAP_MS`); re-applying identical rows is
  a no-op under LWW.
- Deletions have no tombstones → every since-pull response carries the full
  key list of both tables (`nodeIds`, `linkKeys`), and the client deletes
  local rows absent from them (rows of pending-push notes excepted).

### What the database deliberately does not do

D1 stores current state only, so history-derived features have no source and
do not exist in the app:

- **Note version history**: no per-edit log; a save replaces rows.
- **Past-day reconstruction**: calendar past days show a simple "history isn't
  available" placeholder instead of a reconstructed roll-up.
- **File attachments**: uploads were a git-repo feature; legacy `/uploads`
  references in note content render as inert placeholders.

**No event sourcing — reserved.** The store remains state-based (current rows
only, no per-edit event log). An event/history layer over the database — which
would bring back version history and day roll-ups — is deliberately reserved
for later rather than half-built here. The v2 shape was chosen so that
migration is additive: every mutation is already a text edit, a type change,
or a link-row change.

## The contract: `NoteStore` + conformance suite

`src/data/note-store-conformance.ts` exports
`describeNoteStoreConformance(name, makeStore)` — an executable specification
covering write/read/delete round-trips, id-keyed semantics, batch writes, and
the graph semantics of graph-schema-v2.md: `upstream`/`downstream`
containment queries, multi-parent `addLink` (the shared node renders fully in
every location), ordered insertion by fractional sort key, cycle rejection at
write, and delete-rescue (unlinking a node's last occurrence re-parents its
orphaned children to the page root). The SQL store
(`src/data/sql-note-store.test.ts`) passes it; anything the suite doesn't pin
down is an implementation detail a store may choose freely.

## Schema (`migrations/0001_init.sql` + `migrations/0002_nodes.sql`)

Wrangler d1 migration files, written in strictly shared SQLite dialect so the
identical files initialize both the D1 database
(`wrangler d1 migrations apply ruminate`) and the local sqlite-wasm store.
`0001` created the v1 markdown-as-truth tables; `0002` creates the v2 graph
and drops them. Full DDL and rationale in
[graph-schema-v2.md](./graph-schema-v2.md); in brief:

### `nodes` (id TEXT PK, type, text, props, updated_at)

One row per node. `id` is the app's existing TEXT id (`blk_…` for blocks, the
note id for page nodes). `type` is stored, not derived — the registry in the
schema doc (`page`, `text`, `h1`–`h3`, `todo`, `done`, `ul`, `ol`, `quote`,
`code`); checked state is a type (`todo` ↔ `done`), so a checkbox toggle is a
generic type transition. `text` is marker-free. `props` is JSON: a page node
carries its raw frontmatter verbatim (`{"frontmatter": "…"}` — never
re-serialized, so block editing can never corrupt YAML it didn't author); a
code node carries `{"language": "…"}`. `updated_at` (ms epoch) drives per-row
LWW and since-cursor pulls.

### `link` (source_id, destination_id, kind, sort_key, updated_at)

Containment as rows: `kind = 'child'`, primary key
`(source_id, destination_id, kind)`, `ON DELETE CASCADE` both ends. Sibling
order is a fractional `sort_key` (the `fractional-indexing` package): inserts
touch one row, nothing renumbers, and ingest assigns fresh evenly-spaced keys
per note — which doubles as the rebalancing mechanism. The store's diffing
write path (`reconcileSortKeys`) keeps existing keys wherever the relative
order allows, so an unchanged sibling produces no row change. Multi-parent is
just two link rows pointing at one node; the same-parent duplicate is
unrepresentable by the primary key. Wikilinks and tags stay derived from
`text` in memory (`parseNote`), not materialized — `kind` reserves the slot.

### `meta` (key/value)

`schema_version` (`2`), `replica_cursor` (D1: the last push a client
confirmed), and, in the **local** store only, `d1_pull_cursor` (the last
replica cursor this device pulled through).

### No view_state table

Collapse state is per-device ephemera. The default-expansion policy is pure
(`defaultCollapsedIds`, `src/blocks/default-collapsed.ts`): headings always
expanded, two levels expanded below any heading (or the page root), deeper
starts collapsed. The user's toggles are stored in localStorage as per-note
overrides on top of that default (`src/data/view-state.ts`); losing them
merely falls back to the defaults. The rollup's hard depth cap doubles as the
render guard against corrupted (cyclic) graphs.

## Delete = unlink + rescue

Deleting node X in the context of parent P removes the link row P→X; if X has
another inbound child link it lives on there; otherwise X's row is deleted and
each of X's children left with no inbound link is re-parented to the **page
root** with trailing sort keys. No orphan state exists — deleting a container
visibly demotes its contents instead of vanishing them. Whole-note saves
apply the same rule: a node that fell out of the note and has no other parent
is deleted; children it strands are rescued. Deleting a _note_ removes the
page and cascades everything not multi-homed elsewhere.

## Cross-file block-id dedup

`parse.ts` regenerates duplicate ids _within_ one document; across notes,
`findCrossNoteIdCollisions` (`src/data/graph.ts`) detects collisions
deterministically (collisions by block id, notes by note id, first note is
the keeper). The seed script (`scripts/seed-d1.ts`) reports collisions when a
corpus is seeded — under v2 an unfixed collision silently becomes a
multi-parent node, so the report matters.

## Worker replica API (`/api/replica/*`)

`worker/handlers/replica.ts`, routed like every other API route via
`run_worker_first` in wrangler.jsonc.

- `PUT /api/replica/notes` — batch of row upserts + deletes
  (`{nodes, links, deleteNodes?, deleteLinks?, cursor?}`), executed as a
  single `db.batch()` — one atomic D1 transaction. Upserts are per-row
  last-writer-wins (`WHERE excluded.updated_at >= …`), so replays are
  idempotent and a stale push cannot clobber a newer row; node deletes clean
  their link rows explicitly. Payloads are validated (`parseReplicaPayload`)
  and planned (`planReplicaPut`) by pure, unit-tested functions; the D1
  wiring is a thin shell typed against `@cloudflare/workers-types`.
- `GET /api/replica/notes` — row pull, the read half:
  - Full: `{ nodes, links, cursor }` — every row of both tables.
  - `?since=<cursor>`: `{ nodes, links, nodeIds, linkKeys, cursor }` — the
    changed rows (`updated_at > since`) plus the **full key list of each
    table** for deletion-by-absence. A malformed `since` is a 400.
- `GET /api/replica/status` — row counts (`nodes`, `links`, `pages`),
  `schema_version`, `replica_cursor`.
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

- **Row diffs, coalesced.** Saves hand the store's row diff to the queue;
  diffs accumulate keyed by row (upserts and deletes cancel), and a push runs
  ~2s after the first dirty mark, so rapid saves coalesce into one request.
  `visibilitychange → hidden` / `pagehide` flush the queue immediately with
  `fetch keepalive`, so backgrounding the tab inside the debounce window
  doesn't strand the last save.
- **Full pushes** read every row from the store and chunk them with all node
  rows before any link rows (the link table's foreign keys); the cursor rides
  only the final chunk.
- **Every tab pushes its own edits.** Per-row last-writer-wins at the replica
  makes concurrent tab pushes safe.
- **Auth.** Same-origin fetch (the `gh_refresh` cookie rides along) plus the
  current GitHub access token as a Bearer header (`ensureFreshToken`
  proactively, `withAuthRetry` refreshing once and retrying on a 401). The
  pull side (`d1-note-source.ts`) uses the identical pattern. When the
  refresh token itself is dead (`/github-refresh` answers 401), the machine
  signs out cleanly — stale localStorage user cleared, the signed-out screen
  says "session expired — sign in again" — rather than showing the
  offline-database notice, which is reserved for genuine network failure.
- **Resilience.** A failed push merges its rows back into the pending diff
  (newer rows queued during the flight win) and retries with exponential
  backoff (2s doubling to a 60s cap); the browser's `online` event
  short-circuits the wait. Failures are recorded in the Settings diagnostics,
  never thrown.
- **Cursor.** Each push carries a monotonic ms-timestamp cursor (sent only
  with the final chunk, so it means "the replica reflects local state as of
  this push"). `GET /api/replica/status` echoes it back — the Settings panel
  shows it as confirmed — and supplies remote row counts. If the counts show
  the replica drastically behind (empty, or missing >10% of the pages), a
  full push is scheduled automatically (cooldown-guarded); the Settings panel
  also has a manual "Push full copy to D1 now" action.
- **Known gap, accepted:** pending rows live only in memory, so a change made
  while the replica was unreachable can be lost remotely if the tab closes
  before the retry lands (the keepalive flush narrows this to actual network
  failure). The next since-pull then resurrects the stale rows locally —
  visible, correctable by editing again, and bounded by the push backoff
  window. A durable pending queue closes this properly if it ever bites.

## History: the git era, and schema v1

Until this architecture landed, Ruminate was a git app: notes were markdown
files in a GitHub repository cloned into the browser (isomorphic-git +
lightning-fs), synced by a pull/commit/push state machine, with version
history, merge drivers, conflicted-copy notes, and a repo-selection screen.
That architecture is recorded in [architecture-notes.md](./architecture-notes.md)
and in git history (`main` holds the git app until this branch merges). The
database architecture was built alongside it in phases — the `NoteStore`
contract + conformance suite and shared schema first, then the local
sqlite-wasm store validated by a dual-write/shadow-read mirror while git
stayed canonical, then write-behind D1 replication, then the cutover — and
the git path, the storage flag, and the mirror were deleted once the database
became the app.

Schema v1 (`migrations/0001_init.sql`) stored markdown as truth
(`notes.content`, byte-for-byte) with derived `blocks`/`links` rows and a
`view_state` table, and synced whole notes with per-note LWW. Schema v2
(`migrations/0002_nodes.sql`) inverted it the same week, before any
production data existed; the v1 rationale survives in git history and the
inversion's rationale in [graph-schema-v2.md](./graph-schema-v2.md).
