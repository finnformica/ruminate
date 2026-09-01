# Graph storage

The database-backed storage architecture Ruminate runs on. This document
extends [architecture-notes.md](./architecture-notes.md); the principles there
(stable `blk_` ids, multi-homing by reference, the `src/data` seam, view state
as UI state) are load-bearing here and are not restated in full. The schema
itself — and the reasoning behind it — is
[graph-schema-v2.md](./graph-schema-v2.md); this document describes how the
app runs on it.

## The architecture: database-authoritative, blocks-first

**Database storage is THE app.** After GitHub sign-in — which is identity for
the Worker API and, since the multi-tenant cutover, names the tenant — data
loads from the user's server corpus (the authoritative cross-device copy), the
local SQL store is the runtime store, and saves write locally and push to the
replica through the replica queue. Signed out, the sample notes render. There
is no git anywhere in the data path.

**One database, scoped by column.** Every user's corpus lives in the same D1
database, in the rows whose `user_id` is theirs. That was a deliberate
reversal of the Durable-Object-per-user design, made for data visibility — the
D1 console lets the owner inspect and diagnose a real corpus, which a DO's
private SQLite has no way to offer — and paid for with structural mitigations
rather than hope: handlers receive a `TenantDb` minted only from a verified
identity, it binds `user_id` itself, it refuses unscoped statements at
runtime, and `npm run check:queries` fails CI on one. The full decision record,
including what is given up, is docs/multi-tenant-design.md §0.

**Nothing is hard-deleted.** Since schema v3, deleting a block or a note
stamps `deleted_at` (and bumps `updated_at`, so the tombstone replicates like
any edit). Reads discard tombstones at read time, so the app looks exactly as
it did; the rows survive, which is what makes a restore possible later.

**The graph is truth; markdown is a projection.** Since schema v2, both
databases hold typed `nodes` + containment `link` rows, not markdown. A note's
markdown is the _rollup_ — `rollup(pageId)` walks the page node's child links
in sort-key order and serializes each node by type — and every save is parsed
back into row diffs by `docToGraph`/`docToGraphParts`
(`src/data/graph.ts`). The round trip is a **one-step convergence**: a single
ingest+rollup pass may deliberately normalize the bytes (see "Data quality"
below), and its output is a strict byte-for-byte fixpoint of any further pass
— the most heavily tested invariant in the app (`src/data/graph.test.ts`,
plus `scripts/rollup-equivalence.ts` for checking a real corpus directory).
Markdown already in normalized form round-trips byte-identically.

```
local SQLite runtime store (sqlite-wasm / OPFS)   ← the store the app runs on
    │  PUT /api/replica/notes   (row-diff push, src/data/replica-sync.ts)
    │  GET /api/replica/notes   (boot + since-cursor row pulls, src/data/d1-note-source.ts)
    ▼
one D1 database behind the Worker                 ← the authoritative cross-device copy
    every corpus row carries `user_id`; a handler only ever holds a `TenantDb`
    bound to the server-verified GitHub id (worker/tenancy-db.ts —
    docs/multi-tenant-design.md §0)
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
- Deletions travel as ordinary rows carrying `deleted_at`, so a delete is just
  another change the since-pull returns and the client applies.
- The response nevertheless still carries the full key list of both tables
  (`nodeIds`, `linkKeys`), and the client deletes local rows absent from them
  (rows of pending-push notes excepted). Tombstones made that channel
  redundant, but it stays as belt-and-braces until tombstone propagation has
  proven itself in production; dropping it is a deliberate follow-up
  (docs/multi-tenant-design.md §0). Note that a tombstoned row is still a row,
  so it appears in the key lists — absence from them now means _purged_, not
  deleted.

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

## Schema (`migrations/0001` → `0002` → `0004`)

Wrangler d1 migration files, written in strictly shared SQLite dialect.
`0001` created the v1 markdown-as-truth tables; `0002` creates the v2 graph
and drops them; `0004` is v3 — soft deletes on both engines, plus the tenant
column on D1. Full DDL and rationale in
[graph-schema-v2.md](./graph-schema-v2.md); in brief:

### One dialect, two shapes

The identical files no longer produce identical tables, and that divergence is
deliberate and documented in one place (`src/data/corpus-schema.ts`):

- **D1** applies `0004_tenant_columns.sql`: `user_id INTEGER NOT NULL` on
  `nodes`, `link`, and `meta`, leading every primary key and index
  (`(user_id, id)`, `(user_id, source_id, destination_id, kind)`,
  `(user_id, key)`). SQLite cannot ALTER a primary key, so `0004` rebuilds
  each table and copies the existing single-tenant rows in, stamped with the
  owner's id. The `link → nodes` foreign keys are dropped: nothing is
  hard-deleted, so `ON DELETE CASCADE` can never fire, and retaining links to
  tombstoned nodes is the point.
- **The browser store** gets `deleted_at` and nothing else — one user per
  browser profile, so a `user_id` column there would be a constant. Its v3
  step is two `ALTER TABLE … ADD COLUMN` statements, no rebuild.

`ensureCorpusSchema(driver, migrations, tenancy)` selects the step; the
`"columns"` mode exists so the worker test suites build the exact D1 shape
from the exact file D1 runs, which is what keeps the seam honest rather than
merely described.

### `deleted_at` (both tables, both shapes)

`NULL` = live. A delete stamps it — never a `DELETE` statement — and all rows
one delete operation retires share one timestamp, so a future restore is
"revive the rows stamped at T". Reads discard at read time
(`buildGraphSnapshot` drops tombstoned nodes and any link whose endpoint is
tombstoned), so deletes never cascade at write time and a link into a deleted
node survives as the position a restore would put it back into.

### `nodes` (id TEXT, type, text, props, updated_at, deleted_at)

One row per node. `id` is a minted TEXT id — `blk_…` for blocks **and** pages
alike, since a page is just a node whose `type` is `page`
(docs/page-identity-design.md); daily and weekly pages are the one exception
and keep their date key (`2026-08-31`, `2026-W35`), where the date is the
identity. A page's _name_ is not its id but its `text`: the title, which the
rollup carries through the `<id>.md` seam as a projection-owned `title:`
frontmatter key. `type` is stored, not derived — the registry in the
schema doc (`page`, `text`, `h1`–`h3`, `todo`, `done`, `ul`, `ol`, `quote`,
`code`); checked state is a type (`todo` ↔ `done`), so a checkbox toggle is a
generic type transition. `text` is marker-free. `props` is JSON: a page node
carries its frontmatter as **individual parsed entries** (e.g.
`{"updated_at": "…", "tags": […]}`); the rollup re-serializes them with the
canonical YAML serializer (`canonicalFrontmatterYaml`,
`src/utils/frontmatter.ts` + `src/data/frontmatter-props.ts`), which is a
`parse(serialize(x))` fixpoint. Frontmatter that parsing cannot represent
faithfully — comments, non-map YAML, anything failing the round-trip guard —
stays in the legacy raw-blob shape (`{"frontmatter": "…"}`, emitted verbatim),
which the rollup accepts forever for rows from older app versions. A code
node carries `{"language": "…"}`. `updated_at` (ms epoch) drives per-row LWW
and since-cursor pulls.

### `link` (source_id, destination_id, kind, sort_key, updated_at, deleted_at)

Containment as rows: `kind = 'child'`, primary key
`(source_id, destination_id, kind)` — `(user_id, …)` on D1. Sibling
order is a fractional `sort_key` (the `fractional-indexing` package): inserts
touch one row, nothing renumbers, and ingest assigns fresh evenly-spaced keys
per note — which doubles as the rebalancing mechanism. The store's diffing
write path (`reconcileSortKeys`) keeps existing keys wherever the relative
order allows, so an unchanged sibling produces no row change. Multi-parent is
just two link rows pointing at one node; the same-parent duplicate is
unrepresentable by the primary key. Tags stay derived from `text` in memory
(`parseNote`), not materialized — `kind` reserves the slot. (Wikilinks were
removed as a feature; `[[...]]` in text is plain text.)

### `meta` (key/value)

`schema_version` (`3`), `data_version` (see "Data quality" below),
`replica_cursor` (the last push a client confirmed), and, in the **local**
store only, `d1_pull_cursor` (the last replica cursor this device pulled
through). On D1 the table is per-tenant (`PRIMARY KEY (user_id, key)`), so
each user has their own cursor and their own versions; a new tenant's rows are
seeded on first request (`ensureTenantMeta`), because migration `0004` only
stamped the owner's. The Worker also writes `do_import_at` there — the marker
that this tenant's Durable-Object corpus has been imported
(docs/multi-tenant-design.md §0).

## Data quality: normalization + versioned data transforms

Two deliberate departures from byte preservation (2026-W36 — before this,
ingest kept every near-miss marker spelling and the raw frontmatter text
byte-for-byte):

- **Near-miss marker normalization.** Ingest types and canonicalizes the
  conservative near-miss set in `src/data/normalize-block-text.ts` (`[] x` →
  todo, `[X] x` → done, `* x`/`+ x` → ul, `2) x`/`01. x` → ol) instead of
  leaving them untyped `text` nodes invisible to `type:todo` search.
  Ambiguous spellings (`#word` — the tag syntax; tight markers; 4+ digit
  "ordered" numbers) stay verbatim text.
- **Canonical frontmatter.** Page props hold parsed entries and the rollup
  emits canonical YAML (above), so re-serialization can change bytes vs the
  originally saved text (flow-style lists, canonical quoting) — accepted; the
  canonical form is a strict fixpoint, and each save's `updated_at` stamp
  round-trips byte-identically.
- **The projection-owned `title:` key.** A page's title lives in its node
  `text` (docs/page-identity-design.md); the rollup injects it as the FIRST
  frontmatter key and ingest lifts it back out, so a hand-written `title:`
  further down the block moves to the top on the first pass. Like the two
  above, that is a convergence: the moved form is a strict fixpoint. No key is
  emitted when a page's `text` equals its id (an untitled note, or a date
  page), which is what leaves daily/weekly notes byte-identical.

**Existing rows** are rewritten once by the versioned data transform
(`src/data/data-version.ts`): when the `data_version` meta key is below the
current version, the transform rewrites matching rows — fence-aware,
idempotent, and transactional (one write carries the rewrites and the version
stamp) — with a fresh `updated_at` so rewritten rows replicate under per-row
LWW. The browser store runs it on open (`ensureCorpusSchema →
ensureDataVersion`); the Worker runs it per verified tenant, before serving
that tenant's first request. Both go through the same pure planner behind a
four-method `CorpusAccess` port, because the two schema shapes need different
statements and stitching SQL fragments together is exactly the leak the query
guard exists to prevent. Every device and the server therefore run the
identical deterministic transform, so whichever timestamp wins, the winning
content is the same and the corpus converges.

The ladder currently has two rungs, and they compose in one pass and one
write: **version 1** normalizes near-miss markers and upgrades legacy raw
frontmatter props; **version 2** mints page ids
(docs/page-identity-design.md) — re-keying every page still named by its
title, moving that name into `text` (its `props` carry over unchanged), and
re-pointing every link row that named it. The old id is not preserved as an
address: a pre-migration `/notes/<title>` URL no longer resolves and falls
through to the new-note editor, like any unrecognized id. Version
2 is why the determinism above is load-bearing rather than merely tidy: it
mints from a hash of the old id, so the browser store and the D1 partition
independently arrive at the same new id instead of forking one page into two.
Its re-key is upserts plus tombstones — nothing is hard-deleted — so it
replicates like any other edit. An empty corpus does not stamp
the version, so rows arriving after first open (the DO import, a first pull)
are transformed next time. Tombstoned rows are skipped — a deleted row has
nothing to normalize.

### No view_state table

Collapse state is per-device ephemera. localStorage holds one set of collapsed
block ids per note (`collapse:<noteId>`, `src/data/view-state.ts`): collapsed
means folded, everything else is open, so a block can never hold two opinions
at once. The default-expansion policy is pure (`defaultCollapsedIds`,
`src/blocks/default-collapsed.ts`): headings always expanded, two levels
expanded below any heading (or the page root), deeper starts collapsed — and
it **seeds** that set the first time a note is opened on a device rather than
sitting underneath it as a layer. After that the reader's toggles are the only
thing that moves the set (blocks added later start expanded), ids the document
has lost are pruned on write, and losing localStorage simply re-seeds from the
policy. The rollup's hard depth cap doubles as the render guard against
corrupted (cyclic) graphs.

## Delete = unlink + rescue (and, underneath, a tombstone)

Deleting node X in the context of parent P retires the link row P→X; if X has
another inbound child link it lives on there; otherwise X's row is retired and
each of X's children left with no inbound link is re-parented to the **page
root** with trailing sort keys. No orphan state exists — deleting a container
visibly demotes its contents instead of vanishing them. Whole-note saves
apply the same rule: a node that fell out of the note and has no other parent
is retired; children it strands are rescued. Deleting a _note_ retires the
page and cascades everything not multi-homed elsewhere.

**"Retired" means tombstoned, not removed** — that is the only thing schema v3
changed here, and it is invisible from outside:

- A delete is `UPDATE … SET deleted_at = ?, updated_at = ?`. There is no
  `DELETE` statement in the app's write path at all, on either engine, and the
  query guard refuses one.
- **One timestamp per delete operation.** Every row a single delete touches
  shares its `deleted_at`, so a restore is "revive the rows stamped at T".
- **Read-time discard, never write-time cascade.** The rollup skips a link if
  either endpoint is tombstoned, and a tombstoned node never renders — so
  links to deleted nodes are _retained_, holding the position a restore would
  put the node back into, rather than being cascaded away.
- A tombstone replicates like any edit (fresh `updated_at`), which is how the
  delete reaches another device; re-creating the same id clears the stamp and
  revives the row.
- The user-visible rule above is deliberately unchanged by this: whether
  unlink-plus-rescue is still right once deletes are recoverable is a separate
  decision, and there is no restore UI yet — only data that supports one.

## Cross-file block-id dedup

`parse.ts` regenerates duplicate ids _within_ one document; across notes, a
persisted `id::` can legitimately appear twice (a note duplicated in an
external editor), and under v2 such a collision becomes a multi-parent node.
The store's ingest guards the important case — a block id colliding with a
page id is re-minted so it can never clobber the page row. (The seed-era
collision report, `findCrossNoteIdCollisions` + `scripts/seed-d1.ts`, was
retired along with the D1 corpus seeding path.)

## Worker replica API (`/api/replica/*`)

`worker/handlers/replica.ts`, routed like every other API route via
`run_worker_first` in wrangler.jsonc. The handler is auth + dispatch: it
verifies the session, resolves the verified id against the control plane
(users + allowlist, migration `0003_control_plane.sql`), mints a `TenantDb`
from that id, and hands it to the engine-agnostic corpus code
(`worker/handlers/replica-corpus.ts`), which runs every query through the
shared `SqlDriver` seam.

- `PUT /api/replica/notes` — batch of row upserts + deletes
  (`{nodes, links, deleteNodes?, deleteLinks?, cursor?}`), executed as a
  single `db.batch` (one transaction). Upserts are per-row
  last-writer-wins (`WHERE excluded.updated_at >= …`), so replays are
  idempotent and a stale push cannot clobber a newer row; `deleted_at` rides
  along as an ordinary column, so a tombstone replicates — and a revive clears
  — under the same rule. Current clients push tombstoned rows in
  `nodes`/`links`; the older `deleteNodes`/`deleteLinks` channel is kept and
  turned into tombstone stamps (one timestamp for the whole push), never
  removals. Payloads are validated (`parseReplicaPayload`) and planned
  (`planReplicaPut`) by pure, unit-tested functions.
- `GET /api/replica/notes` — row pull, the read half:
  - Full: `{ nodes, links, cursor }` — every row of both tables, tombstones
    included.
  - `?since=<cursor>`: `{ nodes, links, nodeIds, linkKeys, cursor }` — the
    changed rows (`updated_at > since`, a tombstone being an ordinary change)
    plus the **full key list of each table**. A malformed `since` is a 400.
- `GET /api/replica/status` — LIVE row counts (`nodes`, `links`, `pages` —
  tombstones and links into tombstoned nodes excluded, so these agree with the
  client's own counts), `schema_version`, `replica_cursor`.
- `POST /api/admin/import-do-corpus` (`worker/handlers/admin.ts`, owner-only)
  — the DO→D1 import for the owner and every id in `users`; `?merge=1` to
  LWW-merge into a non-empty partition, `?force=1` to re-run a marked tenant.
  Read-only on the DOs and idempotent. The same import also runs lazily,
  before a user's first post-deploy request is served, so a since-pull can
  never answer from the stale pre-DO snapshot and trigger client-side
  deletion. Full runbook: docs/multi-tenant-design.md §0.
- **Auth & tenancy:** every route is guarded by `requireSession`: the
  `gh_refresh` HttpOnly cookie (set by `/github-auth`, rotated by
  `/github-refresh`; its presence proves the browser holds a session this
  Worker created, and SameSite=Lax blocks cross-site sends) plus the GitHub
  access token as `Authorization: Bearer`, verified against
  `GET https://api.github.com/user`. The **verified** id is then resolved
  against the control plane (`worker/handlers/tenancy.ts`): a `users` row
  admits (unless `blocked`), and a missing row is a signup decision per
  `SIGNUP_MODE` (`allowlist`: the allowlist table or the `ALLOWED_GITHUB_ID`
  bootstrap; `open`: auto-provision; absent: bootstrap owner only —
  fail-closed, and also the fallback if the control-plane migration hasn't
  run). If the per-request GitHub round-trip ever matters, cache verification
  results in `caches.default` keyed by a token hash.
- **Tenant scoping (`worker/tenancy-db.ts`):** `forTenant(corpusDriver(env),
session)` is the only mint on the request path, and it takes the
  `VerifiedIdentity` only `requireSession` produces — no path segment, query
  param, header, or body field reaches it, so a client cannot name a tenant;
  it can only be one. The handle then binds `user_id` itself: statements name
  their tenant with a `:tenant` token that `TenantDb` rewrites to a positional
  placeholder and fills, so there is no parameter a caller could put a user id
  into. Any statement touching `nodes`/`link`/`meta` without `user_id` +
  `:tenant` throws before reaching the database, as does a read of
  `nodes`/`link` that says nothing about tombstones and any `DELETE` from
  them. The narrow, greppable opt-outs are `includingDeleted()` (replication,
  trash, audit), `-- tenant-exempt: <reason>`, and `controlPlaneDriver` for
  `users`/`allowlist`, which are not tenant data (the resolver has to look up
  an id that is not yet a tenant). `npm run check:queries` enforces the same
  rules over every SQL literal in `worker/**` and `src/data/**` in CI, and
  bans `env.DB` outside that module.

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
  also has a manual "Push full copy to the cloud now" action.
- **Known gap, accepted:** pending rows live only in memory, so a change made
  while the replica was unreachable can be lost remotely if the tab closes
  before the retry lands (the keepalive flush narrows this to actual network
  failure). The next since-pull then resurrects the stale rows locally —
  visible, correctable by editing again, and bounded by the push backoff
  window. A durable pending queue closes this properly if it ever bites.

## Mirroring (paste as link)

Within Ruminate, **paste means "put this block here"**. Copy embeds the
selected blocks' ids in the private clipboard payload (`rich-clipboard.ts` —
the visible `text/plain`/`text/html` flavors are unchanged), and a select-mode
paste of ids the corpus knows LINKS those nodes downstream of the target
instead of duplicating content: the target note's markdown gains the subtree
under its original `id::` lines, so the next save turns it into a second
inbound link on the same node. The node then genuinely lives in both places —
an edit in either reflects in both, which is just per-row LWW through the
store. Cut+paste is thereby a true move (the same ids travel).

The rules, per pasted root (`embeddedPasteFragment` in `block-editor.tsx`):

- **Link** (ids unknown in this doc, i.e. cross-note): insert with original
  ids, using the node's LIVE content resolved from the corpus
  (`resolve-blocks.ts`, wired by `BlockNoteEditor`; the open note's own file
  is excluded — it lags the editor by the autosave debounce). A node that no
  longer exists anywhere falls back to the clipboard-embedded content, still
  under its original ids — that fallback is what makes cut+paste a robust
  move regardless of autosave timing.
- **Same-doc** (an id already lives in this doc): duplicate with fresh ids —
  same-note mirroring is deliberately out of scope until the `((blk_x))`
  occurrence form (the markdown bridge re-mints a duplicate `id::` and would
  fork it).
- **Twin** (the id is already a direct child of the insertion parent): skip
  that block — no duplicate, no error, it's already there. The DB's
  `(source, destination, kind)` primary key backstops the invariant.
- **Cycle** (the live subtree contains the paste target or an ancestor):
  fall back to duplicating that block; the store's save-time cycle-drop
  remains the backstop.

Edit-mode (textarea) paste is unchanged — a caret splice is textual. On the
store side, `planNoteWrite` already had the required property (pinned in the
conformance suite): a save whose diff drops a node that is still linked from
another note only unlinks it — node rows and the other note's links survive.

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
