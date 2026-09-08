# Event sourcing design

A decision-ready design for adding an event log to Ruminate's
database-authoritative storage — what it would buy, what it would cost, and
the concrete shapes (event vocabulary, DDL, sync protocol, migration path) to
implement from. This extends [graph-storage.md](./graph-storage.md) (the
D1-authoritative cutover) and [architecture-notes.md](./architecture-notes.md);
nothing here is built — graph-storage.md reserves it explicitly ("No event
sourcing — reserved").

**Recommended shape, up front:** not textbook event sourcing. The
recommendation is a **hybrid op log**: an append-only `events` table becomes
the sync substrate and the history substrate, while `notes.content` remains an
authoritative per-save checkpoint and the existing state tables
(`blocks`/`links`/`view_state`) remain projections rebuilt from content — as
they already are today (`docToRows` in `src/data/doc-to-rows.ts`). State is
never derived _exclusively_ by replaying events, so a lost or corrupt log
degrades to exactly today's model instead of to nothing. This mirrors what
[Figma](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
and [Linear](https://github.com/wzhudev/reverse-linear-sync-engine) actually
run: server-ordered operations over authoritative state, not purist ES.

## 1. What events would buy here — and what actually needs them

The cutover traded git's history for D1's simplicity. The dormant-features
list in graph-storage.md ("Features dormant in database mode") is the honest
gap inventory:

| Gap                                                                                                           | Needs full ES? | Needs an op log? | Needs less?                            |
| ------------------------------------------------------------------------------------------------------------- | -------------- | ---------------- | -------------------------------------- |
| **Note version history** (git mode: `src/utils/note-history.ts`; hidden in database mode)                     | No             | No               | Yes — per-save snapshots suffice       |
| **Day-activity** (git mode: boundary-commit diff in `src/data/history.ts`; placeholder in database mode)      | No             | No               | Yes — snapshots + timestamps           |
| **Cross-device merge better than LWW** ("the later push wins wholesale; losing content unrecoverable")        | No             | **Yes**          | No — needs operations to interleave    |
| **Cross-device undo**                                                                                         | No             | **Yes**          | No — needs attributed operations       |
| **Audit / "what changed when, from where"**                                                                   | No             | **Yes**          | Partially (snapshots lack attribution) |
| **Exact incremental sync** (today: `updated_at` heuristic + 10-min skew window, `src/data/d1-note-source.ts`) | No             | **Yes**          | No — needs a server-ordered cursor     |

Two conclusions fall out:

1. **Nothing needs full event sourcing** (state derived only by replay,
   [Fowler](https://martinfowler.com/eaaDev/EventSourcing.html)). If version
   history were the only goal, a `note_versions` snapshot table appended on
   save would close it in an afternoon — see §7. Using audit alone to justify
   ES is a known anti-pattern
   ([event-driven.io](https://event-driven.io/en/audit_log_event_sourcing/)).
2. **The sync upgrades genuinely need an op log.** LWW-at-note-granularity is
   the current model's real ceiling (graph-storage.md "Conflict semantics"),
   and the since-pull's clock-skew window and null-`updated_at` blind spot
   (graph-storage.md "Since-pull fidelity") are artifacts of syncing _state_
   instead of _changes_. (Deletion-by-absence was the third; tombstones
   retired it in 2026-09.) A server-sequenced event log fixes the rest at once — exactly the fix Linear's
   `lastSyncId` delta protocol embodies
   ([reverse-engineered writeup](https://github.com/wzhudev/reverse-linear-sync-engine),
   [Linear's own delta-sync post](https://linear.app/now/rebuilding-delta-sync-read-path)).

So the decision is really: **op log for sync + history, with checkpoints** —
and the rest of this document designs that.

## 2. Event vocabulary

The editor already speaks in operations. The command layer
(`src/blocks/commands.ts`) is a closed set of pure intents whose results are
tagged with a `BlockOp` (`src/blocks/history.ts:17` —
`{ type: "text"; blockId } | { type: "structural" }`), and every structural
command bottoms out in a handful of tree primitives (`src/blocks/ops.ts`):
`insertAfter`/`insertFirstChild`, `indentBlock`, `outdentBlock`, `moveBlock`,
`removeBlock`, `duplicateBlocks`, `updateContent`. The event vocabulary is
that taxonomy, made durable, using the existing stable `blk_` TEXT ids
(`src/blocks/id.ts`) as-is:

| Type            | Payload (JSON)                                     | Emitted by                                                                                                              |
| --------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `note.created`  | `{ noteId, content }`                              | new-note flows                                                                                                          |
| `note.renamed`  | `{ fromId, toId }`                                 | rename (note ids are filenames-minus-`.md`, graph-storage.md "Schema")                                                  |
| `note.deleted`  | `{ noteId }`                                       | delete flows — this is the **tombstone** the current sync lacks                                                         |
| `note.snapshot` | `{ noteId, content, updatedAt }`                   | every editor save (checkpoint; also the genesis event, §6)                                                              |
| `block.created` | `{ noteId, blockId, parentId, position, content }` | split (`splitAtCaret`), `insertBelow`, `insertSiblingBelow`, duplicate                                                  |
| `block.edited`  | `{ noteId, blockId, content }`                     | `updateContent` paths — coalesced per block per burst, same rule as undo (`record` in `src/blocks/history.ts:39`)       |
| `block.moved`   | `{ noteId, blockId, parentId, position }`          | `indent`, `outdent`, `moveBlockUp/Down` — all are reparent+reposition                                                   |
| `block.deleted` | `{ noteId, blockId }`                              | `deleteBlock`, `backspaceEmpty`; the subtree rides along (replay consults the projection tree, mirroring `removeBlock`) |
| `view.folded`   | `{ noteId, collapsed: [blockId...] }`              | collapse toggles — whole-set LWW, matching today's canonical sorted set (`view_state` semantics)                        |

Notes on the shape:

- **`note.snapshot` is load-bearing, not optional.** Saves today are
  whole-note (`useSaveNote` serializes the `BlockDoc` back to markdown); the
  snapshot event keeps that contract, gives replay a bounded starting point,
  and is the event LWW survives in (§4). Block events between snapshots are
  the fine-grained record for merge/undo/history detail.
- **`view.folded` is deliberately coarse** (the whole collapsed set, not
  per-block toggles). Folds are UI state (architecture-notes.md "View
  state"); per-toggle events would dominate the log for zero merge value.
  Whether it belongs in the log at all is an open decision (§8).
- **Versioning strategy:** every event row carries an integer `v` (per-type
  schema version). Rules, per
  [Greg Young's versioning guidance](https://leanpub.com/esversioning) and
  [event-driven.io](https://event-driven.io/en/how_to_do_event_versioning/):
  stored events are never mutated; additive optional fields don't bump `v`;
  shape changes bump `v` and are handled by **upcasters** at read time (pure
  `(payload, v) → latestPayload` functions, unit-tested like
  `parseReplicaPayload`); a change in _meaning_ gets a new type name, never a
  reinterpreted old one. Unknown types/versions are skipped with a diagnostic,
  never fatal — the checkpoint events guarantee the projection still lands
  somewhere sane.

## 3. Storage design

One new table pair, in the shared SQLite/D1 dialect (same discipline as
`migrations/0001_init.sql` — plain DDL, one file, both engines):

```sql
CREATE TABLE events (
  -- Total order. AUTOINCREMENT is required, not decoration: compaction (§3)
  -- deletes old rows, and without AUTOINCREMENT SQLite may reuse a deleted
  -- rowid — which would corrupt every stored cursor pointing past it.
  -- (https://sqlite.org/autoinc.html)
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Client-minted idempotency key: `evt_` + random, same alphabet as blk_ ids.
  -- INSERT OR IGNORE on this makes push retries (replica-sync's backoff loop
  -- re-sends whole batches) exactly-once at the log.
  event_id   TEXT NOT NULL UNIQUE,
  -- Attribution: a per-install random id (localStorage), and a per-tab id.
  device_id  TEXT NOT NULL,
  session_id TEXT,
  note_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  v          INTEGER NOT NULL DEFAULT 1,
  payload    TEXT NOT NULL,             -- JSON
  client_ts  INTEGER NOT NULL,          -- ms epoch on the emitting device
  server_ts  INTEGER                    -- set at D1 ingest; NULL locally
);

CREATE INDEX events_note ON events (note_id, seq);
CREATE INDEX events_device ON events (device_id, seq);

CREATE TABLE note_snapshots (
  note_id    TEXT NOT NULL,
  seq        INTEGER NOT NULL,          -- the note.snapshot event's seq
  content    TEXT NOT NULL,
  updated_at INTEGER,
  PRIMARY KEY (note_id, seq)
);
```

- **Sequence safety on D1.** The server `seq` is assigned by insertion order
  at D1, which is [single-threaded per database and processes queries
  sequentially](https://developers.cloudflare.com/d1/platform/limits/), so
  AUTOINCREMENT assignment cannot race. Client-side (wa-sqlite) the same DDL
  yields a _local_ seq that is provisional only — the server seq is the one
  that means anything across devices (§4), the same split Linear makes between
  optimistic local transactions and the authoritative `lastSyncId`.
- **State tables become projections.** `blocks`/`links`/`view_state` already
  are projections of `notes.content` (rebuilt wholesale per note by
  `planReplicaPut` in `worker/handlers/replica-payload.ts:196` and by the
  local ingest in `src/data/sql-note-store.ts`). The only change of status is
  `notes` itself: its row becomes "the projection of the note's event
  sub-stream", rebuilt as _latest `note.snapshot` ≤ target seq, then replay
  the block events after it_. Nothing above `src/data` notices.
- **Rebuild cost model, at realistic sizes.** The corpus ceiling is ~4 MB of
  markdown (architecture-notes.md "Scale limits"). A heavy day is a few
  hundred coalesced events; call it 100k–500k events/year, ~300 bytes each →
  30–150 MB/year of log, comfortably inside D1's 10 GB paid cap for a decade
  ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)).
  Per-note rebuild replays only since that note's last snapshot — and a
  snapshot is emitted _every save_, so ordinary rebuild replays **zero to a
  handful** of events. Full-log replay is never on any hot path; it exists
  only as the repair story.
- **Compaction** is therefore optional and cheap when wanted: delete block
  events older than the note's oldest snapshot you still care about, keep
  `note.snapshot` and `note.deleted` rows forever (they _are_ the history and
  the tombstones). This is Automerge's snapshot+incremental-chunk economics
  ([Automerge storage docs](https://automerge.org/docs/reference/under-the-hood/storage/))
  transplanted to SQL rows. Run deletes in bounded batches per D1 guidance.

## 4. Sync redesign: shipping events instead of state

The replica protocol (`worker/handlers/replica.ts`, `src/data/replica-sync.ts`,
`src/data/d1-note-source.ts`) keeps its skeleton — write-behind push queue,
backoff, since-cursor pull, same auth — but the payload changes from note rows
to event batches:

- **Push:** `POST /api/events` with `{ events: [...] }` in emission order.
  The Worker validates (a `parseEventBatch` sibling of `parseReplicaPayload`,
  shared module, same no-drift discipline), inserts with `INSERT OR IGNORE`
  on `event_id`, applies each accepted event to the D1 projections in the same
  `db.batch()` (atomic, as today), and responds with the assigned seq range.
  The existing queue mechanics survive verbatim: coalescing, chunking,
  backoff, `pendingNoteIds` (`replica-sync.ts:419`).
- **Pull:** `GET /api/events?after=<seq>` returns `{ events, seq }` — exact,
  ordered, complete. This **deletes the two remaining workarounds at once**:
  the 10-minute `SINCE_OVERLAP_MS` clock-skew window (`d1-note-source.ts`) and
  the null-`updated_at` blind spot. (The third, the full-`ids`-list
  deletion-by-absence hack, is already gone — tombstones replaced it.) Cursors
  compare server-assigned integers, never device clocks.
- **Ordering and causality.** For a single-user, few-devices app, the
  pragmatic answer is the one Figma and Linear both chose: **the server
  sequence is the total order**; no vector clocks, no per-object version
  vectors
  ([Figma: "the server can define the order of events rather than requiring
  timestamps"](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)).
  Causality per device is preserved automatically because each device pushes
  its own events in order and batches are applied atomically. Cross-device
  causality gaps (device B edits a block it hasn't yet seen device A delete)
  are resolved by deterministic per-type rules at apply time, not by metadata:
  - `block.edited` on a missing block → materialize it at its note's root
    (edit outlives delete — the data-preserving choice).
  - `block.moved` under a missing parent → reparent to root, position last.
  - `block.*` on a missing note → drop, diagnostic (the note's tombstone won).
  - Two `block.edited` on the same block → later server seq wins. **This is
    where LWW survives** — demoted from whole-note granularity to per-block,
    which is the actual upgrade: two devices editing _different blocks_ of the
    same note now both keep their edits, where today one device's entire note
    is discarded (graph-storage.md "Conflict semantics").
  - `note.snapshot` racing foreign block events: a snapshot supersedes _that
    device's_ prior block events (it embeds them) but foreign block events
    with higher seq re-apply on top of it. Rare in practice; deterministic
    always.
- **Optimistic local apply + rebase.** A device applies its own events to the
  local projections immediately (today's "the UI never waits",
  graph-storage.md "Boot, saves, and sync"). On pull, foreign events apply in
  server order; local unpushed events for the same note logically re-apply on
  top (their conflict rules make this deterministic). The existing
  `pendingNoteIds` guard generalizes cleanly: it stops being "never touch a
  pending note" and becomes "apply foreign events, then replay pending local
  events over them".
- **Unchanged:** auth (`requireSession`, owner-scoped, fail-closed —
  `worker/handlers/replica.ts:50`), every-tab-pushes in database mode,
  online/visibility pull triggers, the Settings diagnostics surface.

## 5. Rebirth of the dormant features

- **Version history.** The per-note timeline is
  `SELECT * FROM events WHERE note_id = ? ORDER BY seq DESC` — snapshots are
  the version entries (restorable content, like git-mode's blob versions),
  block events between them are a finer change log the git version never had.
  Content at any seq = latest snapshot ≤ seq, replay forward. The UI
  (`note-history-dialog.tsx`) keeps its contract: restore stays a normal
  forward save (now: a new `note.snapshot` event), exactly the forward-only
  discipline architecture-notes.md establishes; the `mergeSide` badge
  ("merged from another device") becomes a `device_id != this device` badge —
  strictly better attribution than git's merge-parent inference.
- **Day-activity.** Git mode computes a day's net change from boundary
  commits (`fetchDayActivity` in `src/data/history.ts`). The event-log
  version is the same trick on cheaper data: notes with events in
  `[dayStart, dayEnd)` (by `server_ts`/`client_ts`), diffing content
  reconstructed at the two boundaries — local, offline, no GitHub API.
- **Cross-device undo.** Undo history today is in-memory per editor session
  and collapsed on save (`src/blocks/history.ts` — "undo never reaches behind
  a committed state"). The log extends undo _behind_ saves and across
  devices: undo = find this `device_id`'s latest not-yet-undone event and
  append a **compensating event** (`block.edited` with prior content,
  `block.created` for a delete, a prior `note.snapshot` re-emitted). Nothing
  is ever removed from the log; undo is itself history. Scope it per-device
  (undo _my_ last change, even if another device wrote since) — Figma's
  multiplayer-undo behavior, and the only non-surprising choice with two
  devices. The in-session snapshot undo stack stays as-is; the log picks up
  where it collapses.

## 6. Migration path

Mirror the trial→cutover discipline that shipped graph storage
(graph-storage.md "What each phase shipped" — contract first, shadow-validate,
then cut over):

1. **Schema (migration `0002`).** Add `events` + `note_snapshots` untouched
   alongside the state tables. Local stores treat a `schema_version` bump as
   reset-and-reingest, which is already the rule (`openSqlNoteStore`,
   `src/data/sql-note-store.ts:58`).
2. **Genesis.** One `note.snapshot` event per existing note, seeded from the
   `notes` table in seq order (a bounded batch job). The log is born already
   able to answer "current state" — no special empty-log cases anywhere.
3. **Dual-write trial.** Clients emit events into the local table and push
   them to `POST /api/events` best-effort, while `PUT /api/replica/notes`
   state replication remains authoritative and untouched. Verification: build
   the projection from the log and diff it against the state tables — the
   same shadow-read pattern `storage-mirror.ts` used to validate the SQL
   store against git. Divergence is a diagnostic, never user-visible.
4. **Read cutover.** Boot/sync pulls switch to `GET /api/events?after=` with
   the state pull retained as fallback (flag-gated, like `ruminate_storage`).
   History and day-activity UIs light up here — they only need the log to
   exist, and shipping them first gives the trial real usage.
5. **Write cutover.** The event push becomes the mechanism that updates D1
   projections (server applies events transactionally); the state `PUT` is
   demoted to the full-push repair path ("Push full copy to D1 now" already
   exists in Settings for exactly this role). Checkpoint to proceed: zero
   projection-diff diagnostics over a real multi-device period.
6. **Rollback at every step** is "stop reading the log" — the state tables
   never stopped being maintained. That property is the payoff of the hybrid
   shape and should be preserved permanently, not just during migration.

## 7. Costs, and the honest alternatives

The costs are real even in the hybrid shape: a second wire format to
version forever (upcasters are a permanent tax —
[Young](https://leanpub.com/esversioning)); conflict rules that must be
deterministic and tested per event type; a log that grows without an attention
ceiling; migration months where two sync protocols coexist. Sized against a
single user with 2–3 devices and rare genuine concurrency:

- **Do nothing but snapshots** (`note_versions(note_id, saved_at, content)`
  appended on save, capped/pruned): closes version history and day-activity —
  the two features users actually lost in the cutover — with no new protocol,
  no conflict rules, ~a day of work. It does nothing for LWW data loss, exact
  sync, or cross-device undo. This is the strongest cheap rival, and the right
  choice if sync pain stays theoretical. ("CRUD + change log" is the
  documented sweet spot for lightweight needs —
  [event-driven.io](https://event-driven.io/en/audit_log_event_sourcing/).)
- **CRDTs (Automerge/Yjs) instead:** genuinely automatic merging, and
  op-based CRDT sync overlaps heavily with an op log — but a CRDT is not an
  event log: its ops are internal metadata for convergence, not a readable
  domain history ([Automerge](https://automerge.org/docs/reference/under-the-hood/storage/)).
  Adopting one means handing document ownership to an opaque binary format,
  which collides with Ruminate's byte-preserving markdown round-trip
  (`src/blocks/parse.ts` / `serialize.ts`, frontmatter-verbatim contract in
  `src/blocks/types.ts`) and per-block LWW would still be roughly the merge
  quality achieved for outline structure. Teams have walked this back for
  exactly these reasons
  ([Cinapse/PowerSync](https://powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync)).
  Wrong tool for a single-user tool; the door stays open per-document later.
- **Full event sourcing** (projections only, no authoritative content
  column): maximum purity, and the rebuild/versioning burden lands on every
  read path forever. Snapshot-averse purism isn't even orthodox — snapshots
  are routinely judged not worth their cost _in ES systems_
  ([Young via CodeOpinion](https://codeopinion.com/greg-young-answers-your-event-sourcing-questions/));
  here the snapshot column already exists and is battle-tested. No feature in
  §1 needs this. Rejected.

**Recommendation:** if the LWW ceiling or cross-device undo matters in
practice, build §2–§6; if not, build the snapshot table and stop. Both paths
keep `notes.content` authoritative, so the second is a strict prefix of the
first — snapshots-first is not a dead end, it is step 1–2 of the migration.

## 8. Open decisions (deliberately left to the owner)

1. **Snapshots-only first, or straight to the log?** §7's fork — the one real
   decision; everything else is downstream.
2. **`view.folded` in or out of the log** (out = folds stay pure LWW state,
   log stays signal-dense; in = folds sync exactly and appear in history).
3. **Coalescing window for `block.edited`** — reuse the undo rule (per block,
   broken by structural ops) or debounce-based like the push queue.
4. **Undo scope** — per-device (recommended above) vs global last-event.
5. **Snapshot cadence** — every save (simplest, recommended) vs every N
   events, and the compaction/retention policy (keep forever vs prune block
   events older than N months).
6. **Transport** — extend the existing replica push loop to carry events, or
   a separate queue; and whether the pull needs a push channel later
   (WebSocket/DO) or stays timer+visibility triggered.
7. **`updated_at` frontmatter stamping** — once event seq drives sync, does
   the frontmatter timestamp remain user-facing metadata only, or keep
   double-duty as a fallback sync signal during migration?

## Sources

- Martin Fowler, [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- Greg Young, [Versioning in an Event Sourced System](https://leanpub.com/esversioning);
  [Q&A summary](https://codeopinion.com/greg-young-answers-your-event-sourcing-questions/)
- Oskar Dudycz, [How to (not) do event versioning](https://event-driven.io/en/how_to_do_event_versioning/);
  [Is the audit log a proper driver for Event Sourcing?](https://event-driven.io/en/audit_log_event_sourcing/)
- Microsoft, [Event Sourcing pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- Figma, [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- Linear, [Rebuilding delta sync's read path](https://linear.app/now/rebuilding-delta-sync-read-path);
  wzhudev, [reverse-engineered Linear sync engine](https://github.com/wzhudev/reverse-linear-sync-engine)
- Automerge, [Storage internals (snapshot + incremental chunks, compaction)](https://automerge.org/docs/reference/under-the-hood/storage/)
- Ink & Switch, [Local-first software](https://www.inkandswitch.com/local-first/)
- PowerSync, [Why Cinapse moved away from CRDTs for sync](https://powersync.com/blog/why-cinapse-moved-away-from-crdts-for-sync)
- Cloudflare, [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- SQLite, [AUTOINCREMENT (rowid reuse semantics)](https://sqlite.org/autoinc.html)
