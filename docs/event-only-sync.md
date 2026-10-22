# Event-only sync

Status: **Decided 2026-10-20, revised 2026-10-21, not yet all built.** Finn decided each rule in
"The decisions" below. The rest of this document is how the rules are kept,
and the plan that builds them (the end of this document).

Today the log is beside the tables (docs/event-sourcing.md): the browser
pushes events, but it still keeps `nodes`, `link` and `views` tables, pulls
rows to fill them, and pulls the log a second time for history. This
document retires the row sync. The log is the truth, and the browser's
tables become an indexed cache of its fold (revised 2026-10-21).

## The decisions

1. **The log is the truth; the client's tables are a cache of its fold.**
   The browser keeps `nodes` and `link` as an indexed per-entity cache,
   updated in the same transaction as each local batch and each pulled
   page. Reads are lazy index lookups: no fold on read and no merge of
   diffs at read time. The log is never compacted. (Revised 2026-10-21. It
   replaces "the client keeps only the log, with a snapshot every 1,000
   events or 24 hours".)
2. **Sync pushes and pulls events only.** There is no row pull and no row
   push from the browser.
3. **Each event carries a hybrid logical clock (HLC) stamp.** A conflict
   resolves by that stamp. The server's `seq` is only the sync cursor: it
   says what a device has pulled, not which write wins.
4. **The server keeps its projection** (`nodes`, `link`, `views`) for the
   MCP server, search and shares.
5. **The log is append-only by convention.** The app only appends: a
   delete and a restore are events, and the app never changes or removes
   one. No new database trigger enforces this, so Finn can still fix data
   by hand in the D1 console (revised 2026-10-21; ES-12 is dropped).
6. **Concurrent writes by agents are out of scope for now.** An agent's
   write resolves by stamp like any other write. There is no lock, lease or
   merge for agents.
7. **The migration is a one-time fold from today's tables.**
8. **Search reads the cache tables by index.** (Revised 2026-10-21. It
   replaces "the search index rebuilds from the fold".)

## The stamp

A stamp is a hybrid logical clock: the writer's wall clock in milliseconds,
a counter, and the writer's device.

| part      | what                                                                 | example           |
| --------- | -------------------------------------------------------------------- | ----------------- |
| `ms`      | Wall-clock ms, never less than the highest stamp the device has seen | `1792540800000`   |
| `counter` | Breaks a tie inside one ms                                           | `3`               |
| `device`  | `<device>.<tab>` (`src/data/writer-identity.ts`)                     | `8mteggg4.wulluf` |

- **Encoding.** One string, fixed width, so two stamps compare as strings:
  `ms` as 15 decimal digits, then `counter` as 4 hexadecimal digits, then
  the device, joined by `-`.
- **A local event** takes `ms = max(now, last.ms)`. The counter is
  `last.counter + 1` when `ms` equals `last.ms`, else 0.
- **A pulled event** moves the device's last stamp up to it when it is
  higher. So a device that has seen an edit always stamps after it, even
  when its own clock is behind.
- **Two stamps are never equal** across devices, because the device is part
  of the stamp. The same event applied twice has an equal stamp, and the
  second application changes nothing.
- **A clock that runs fast** wins every field it writes until the others
  catch up. The server records a stamp more than 5 minutes ahead of its own
  clock as a diagnostic. It does not refuse it: an event is the writer's
  account and is never rewritten.

`base_seq` (docs/event-sourcing.md) stays, as information only. The stamp
answers the question `base_seq` was kept for: an offline device's week-old
edit carries a week-old stamp, so it does not win over a newer one.

### Old events

Events are never rewritten, and the events already in the log have no
stamp. An event without one gets a stamp derived at read time, the same on
every reader: `ms` from its `at`, `counter` 0, and `seq:<seq>` in place of
the device, with `seq` padded to 15 digits (`seq:000000000000042`), so two
derived stamps in the same ms compare in `seq` order. One function,
`eventStamp`, gives an event's stamp, its own or derived. The client and
the Worker both call it (ES-2, ES-4), so they cannot disagree.

## The fold

The state of each entity is a set of **fields**, and each field is a
last-writer-wins register on the stamp. Liveness is a field as well.

| entity    | fields                                                              |
| --------- | ------------------------------------------------------------------- |
| **block** | `type`, `text`, `props`, `notes_id`, `alive`                        |
| **link**  | `sort_key`, `alive` (the key is `source`, `destination`, `kind`)    |
| **view**  | `root_id`, `filter`, `sort`, `pinned`, `sort_key`, `stack`, `alive` |

An event sets each field it names, when its stamp is higher than the
field's. A `create` and a `restore` set `alive` to true; a `delete` sets it
to false. A field the event does not name keeps its value and its stamp.

So the fold is:

- **order-free**: the events can apply in any order, and the result is the
  same;
- **idempotent**: an event applied twice is applied once;
- **per field**: two devices that change the text and the type of one block
  both keep their change. Two devices that change the same field: the higher
  stamp wins.

These properties are what make the rest simple. A device applies a pulled
event when it arrives, without a reorder. A cache row plus any events for
its entity after it, in any order, is the state. The server and every device reach the same
state from the same set of events.

The fold extends the one the calendar reads today (`fold`,
`src/data/events.ts`): it keeps the stamp of each field beside its value.
`stateAt` and the calendar's own order (`byPlace`) do not change: they read
the log by `seq` for history, which is a different question from "what is
the state now".

**A row's `seq`.** The fold by stamp (`foldByStamp`) keeps the highest
applied `seq` as the row's `seq`, whichever event won each field. That
`seq` is the pull cursor's measure, and it is what the server's projection
keeps for a row too, so the two agree (ES-5, commit `0b50d46`).

## The client

The browser's store (`src/data/sql-note-store.ts`, OPFS) holds:

| table                    | what                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| `events`                 | The log: this device's events and every pulled event. Never compacted. |
| `nodes`, `link`, `views` | The cache of the fold: one row per entity, with field stamps.          |
| `meta`                   | The pull cursor, the owner, the device's last stamp.                   |

### The cache

Revised 2026-10-21. The log stays the truth. The browser keeps `nodes` and
`link` (and `views`, the same way) as an **indexed per-entity cache of the
fold**: each row is the fold of one entity's events, every field with its
stamp (a `stamps` column, as on the server) and its `seq` (the highest
applied, `foldByStamp`). The snapshot blob goes: the cache tables replace
it.

- **Same transaction.** Each local batch of events and each pulled page
  appends to `events` and updates the cache rows of the entities it names,
  in one transaction. Each event is resolved against its one row, field by
  field, by stamp. No other row is read and nothing is folded again.
- **Lazy reads.** A read is an index lookup, never a fold, and never a
  merge of diffs at read time. To expand a block, read its `link` rows by
  source (`link_source`: `source_id`, `kind`, `sort_key`), then the child
  `nodes` rows by id (the primary key). An up pivot reads `link` by
  destination (`link_destination`). Only what is on screen is read, which
  keeps the walk lazy (docs/graph-walk.md).
- **The fold check** compares only the rows each batch touched: for each,
  the fold of that entity's events in the log against its cache row. The
  rework adds an index on `events (entity, entity_id)` for this. A full
  check of every row is a manual button in Settings → Storage diagnostics.
- **Boot** opens the store and reads. There is no load step: the cache is
  already the state.

**What it replaces.** The snapshot design (ES-5 to ES-7, #280, #284, #285)
loaded the whole fold at boot. Its measured cost (`node:sqlite`; OPFS is
slower), kept for comparison:

| events  | nodes  | first open | `loadFold` | read-out | check  | snapshot |
| ------- | ------ | ---------- | ---------- | -------- | ------ | -------- |
| 10,000  | 3,379  | 157 ms     | 27 ms      | 8 ms     | 70 ms  | 3.6 MB   |
| 50,000  | 16,892 | 811 ms     | 129 ms     | 50 ms    | 280 ms | 18 MB    |
| 100,000 | 33,784 | 1.7 s      | 328 ms     | 101 ms   | 777 ms | 36 MB    |
| 200,000 | 67,568 | 4.3 s      | 640 ms     | 223 ms   | 1.4 s  | 72 MB    |

Production held 3,711 rows, so it is near the first line.

### Write, push, pull

1. **Write.** A batch of the editor's ops becomes events (`opsToEvents`),
   each stamped. They append to `events` and update the cache rows in one
   transaction. The UI never waits.
2. **Push.** The push loop sends the unpushed tail (`seq IS NULL`) in the
   order made (`PUT /api/replica/events`) and stamps each event with the
   `seq` the server answers. A re-sent event gets the `seq` it already has.
3. **Pull.** The pull asks for the log past the device's cursor
   (`GET /api/replica/events?since=`, in pages). Each page appends to
   `events` and updates the cache rows in one transaction. The cursor moves
   to the highest `seq` received.
4. **A fresh device** pulls the whole log from `seq` 0, in pages. Each page
   fills the cache as it lands.

There is no **full push** and no repair from rows. A device whose cache
fails a check rebuilds the cache from the log, then sends its unpushed
tail.

### Search

Search reads the same cache tables by index: the note list by type
(`nodes_type`), and a block's text and place by id and by link. Nothing
about search is stored apart from the cache, so there is nothing else to
migrate or repair. (Revised 2026-10-21.)

## The server

The server keeps the log and its projection:

- **The log** is the truth. `seq` orders it for the cursor. `received_at`,
  `at`, `tz`, `actor`, `origin`, `device`, `client`, `batch` and `cause`
  stay as they are. A new `hlc` column holds the stamp.
- **The projection** (`nodes`, `link`, `views`) is for the MCP server,
  search and shares. It resolves by stamp, per field, exactly as the client
  fold does: each row keeps the stamp of each field (a `stamps` column).
  `planEventAppend` (`worker/handlers/event-log.ts`) sets a field only when
  the event's stamp is higher. **fold(events) == tables** still holds, and
  `GET /api/replica/verify` still checks it.
- **No Worker rollback past migration 0025** (ES-3). From `0025` on, the
  projection resolves by the `stamps` column. A Worker from before it does
  not write that column, so the stamps go out of step with the rows it
  writes. Once `0025` is applied, roll the Worker forward only.
- **The row door** (`writeRows`) stays for the writers that cannot speak
  events: the MCP server and shares. The events it derives carry a server
  stamp: the server's clock, a counter for the position in the append, and
  `server:<origin>` as the device.
- **The browser's row endpoints** (`PUT` and `GET /api/replica/notes`)
  retire once no browser uses them: `REPLICA_PROTOCOL` becomes 3 for the
  event-only client, and `MIN_REPLICA_PROTOCOL` rises to 3 when the old
  bundles are gone.

## Append-only by convention

Revised 2026-10-21: Finn closed ES-12 (#273), so no new trigger is added.

- **The app** only appends to `events`. A delete and a restore are events;
  a block that is deleted is a block whose `alive` field is false. No code
  path changes or removes an event.
- **The database** keeps the triggers `migrations/0023_events.sql` made, as
  they are: `events_no_update` refuses an `UPDATE` on `events`, and
  `events_no_delete` refuses a `DELETE` unless the tenant is named in
  `event_purges`. Nothing stricter is added.
- **`event_purges`** stays as it is. The app does not use it.
- **A fix by hand** in the D1 console stays possible. The projection tables
  (`nodes`, `link`, `views`) have no trigger. To remove a tenant's events,
  name the tenant in `event_purges` first. After a fix by hand,
  `GET /api/replica/verify` shows whether fold(events) still equals the
  tables.

## Agents

An agent writes through the MCP server, which writes through `writeRows`.
Its events carry a server stamp and resolve per field like any other write.
When an agent and a person change the same field at the same time, the
higher stamp wins, and the loser's value stays in the log. There is no
lock, lease or merge for agents for now.

## The migration

A one-time fold from today's tables.

- **On the browser.** Today's `nodes`, `link` and `views` tables become the
  cache. A one-time step fills each row's `stamps` by the `eventStamp` rule
  for an old event: the row's `updated_at`, counter 0 and `seq:<seq>`. That
  is the stamp the row's own last event derives, so that event applied
  again changes nothing. A `meta` flag records that the step has run, and
  it alone decides whether to run it. (Revised 2026-10-21. Snapshot 0,
  `snapshotZero` in ES-6, did the same fold into a blob.)
- **On the server.** No data moves. The new `hlc` and `stamps` columns start
  empty. An empty `hlc` derives its stamp at read time (above). An empty
  `stamps` derives each field's stamp from the row's `updated_at`.

## What does not change

- The event vocabulary, other than the stamp and the view's `stack` field
  (docs/graph-walk.md, "Views save stacks").
- Patches are absolute values.
- History, the calendar and restore read the log as they do now.
- The server's tables, and every reader of them.

## Implementation plan

Small stacked PRs, in order. Each is one worker's job. Each PR updates the
docs its change makes wrong (this one, docs/event-sourcing.md,
docs/graph-storage.md, `CLAUDE.md`). Each runs only the test files it
touches, plus the pre-push gate. A PR that a reader can see adds a
changelog file.

1. **ES-1 The stamp.**
   - Scope: a pure HLC module: stamp, encode, decode, compare, `tick`,
     `receive`.
   - Files: `src/data/hlc.ts`, `src/data/hlc.test.ts`.
   - Tests: a clock that goes back still gives rising stamps; `receive`
     moves the stamp up; string order equals stamp order; encode and decode
     round-trip.
   - Depends on: nothing.
2. **ES-2 Events carry the stamp.**
   - Scope: each new event gets `hlc`. The wire accepts it. The server and
     the client store it. An event without one derives it at read time.
     Resolution does not change yet.
   - Files: `src/data/events.ts` (the type, `opsToEvents`,
     `viewChangeToEvent`, `parseEventsPayload`, the upcast),
     `src/data/database-mode.ts` (the device's last stamp, `receive` on
     pulled events), `src/data/corpus-schema.ts` (the client's `events.hlc`),
     `migrations/0024_event_hlc.sql`, `worker/handlers/event-log.ts`.
   - Tests: `events.test.ts` (stamped events; the derived stamp of an old
     event), `event-log.test.ts` (the column is stored; a null derives),
     `corpus-schema.test.ts`.
   - Depends on: ES-1.
3. **ES-3 The server resolves by stamp.**
   - Scope: a `stamps` column on `nodes`, `link` and `views`.
     `planEventAppend` sets a field only under a higher stamp.
     `appendClientEvents` drops a stale event by stamp, not by `at`.
     `writeRows` stamps the events it derives. `verify` compares stamps.
   - Files: `migrations/0025_projection_stamps.sql`,
     `worker/handlers/event-log.ts`, `worker/handlers/replica-corpus.ts`.
   - Tests: `event-log.test.ts`: the same events in two orders give the
     same tables; a re-sent event changes nothing; two fields of one block
     from two devices both stay; every plan is still pinned with
     `EXPLAIN QUERY PLAN` and keeps a fixed number of statements.
   - Depends on: ES-2.
4. **ES-4 The client fold resolves by stamp.**
   - Scope: `fold` keeps each field's stamp and applies by stamp, in any
     order. `toGraphSnapshot` and `toViewRows` read it out.
   - Files: `src/data/events.ts`, `src/data/events.test.ts`.
   - Tests: a property test (shuffled and doubled events give one state);
     for an in-order log, the fold equals the store's tables on the
     existing fixtures; `stateAt` still answers by `seq`.
   - Depends on: ES-1.
5. **ES-5 to ES-7 (rework) Indexed fold cache with lazy reads.** One item
   (revised 2026-10-21). It reworks #280, #284 and #285, which built a
   snapshot blob and a whole fold at boot.
   - Scope: drop the `snapshots` table and `loadFold`. Add `stamps` to the
     client's `nodes`, `link` and `views`. Each local batch and each pulled
     page updates the cache rows it names, per field by stamp, in the same
     transaction as its append to `events`. Fill the stamps of today's rows
     once, by the `eventStamp` rule, under a `meta` flag. The walk reads
     through the store by index: `link` by source, then `nodes` by id, and
     `link` by destination for an up pivot. Add an index on `events
(entity, entity_id)`. The fold check compares only the rows a batch
     touched; a full check is a button in Settings → Storage diagnostics.
   - Files: `src/data/corpus-schema.ts`, `src/data/sql-note-store.ts`,
     `src/data/note-store.ts`, `src/data/database-mode.ts`,
     `src/data/graph.ts` (the walk's reads), `src/data/fold-check.ts`,
     `src/data/snapshot.ts` (removed), the Settings storage card.
   - Tests: a batch updates exactly the rows it names, and a failure rolls
     back the append and the rows together; a page out of order gives the
     same rows; a re-sent event changes nothing; expanding a block reads
     only its links and its children; an up pivot reads by destination;
     the stamp fill runs once; the per-batch check finds a planted
     difference in a touched row and reads no other row; the full check
     finds one anywhere.
   - Depends on: ES-2, ES-4.
6. **ES-8 Search reads the cache.**
   - Scope: the note list and the block index read the cache tables by
     index, not a whole-graph snapshot.
   - Files: `src/global-state.ts`, `src/data/note-meta.ts`,
     `src/utils/block-search.ts`, their tests.
   - Tests: the existing search tests give the same results; a search
     reads by index (no scan of every row).
   - Depends on: the ES-5 to ES-7 rework.
7. **ES-9 Pull events only.**
   - Scope: boot and the since-pull stop pulling rows. A fresh device
     pulls the whole log in pages. `REPLICA_PROTOCOL` becomes 3.
   - Files: `src/data/database-mode.ts`, `src/data/d1-note-source.ts`,
     `worker/handlers/replica-payload.ts`, `worker/handlers/replica.ts`.
   - Tests: a fresh device boots from events alone; a quiet pull is one
     request; a version 2 client is still served.
   - Depends on: ES-3, the ES-5 to ES-7 rework. Soak the rework for a week
     with no fold difference first.
8. **ES-10 Push events only.**
   - Scope: the row push, the full push and the "Push full copy" action
     go. A repair rebuilds the cache from the log and re-sends the
     unpushed tail.
   - Files: `src/data/replica-sync.ts`, `src/data/database-mode.ts`, the
     Settings storage card in `src/components/settings/`.
   - Tests: `replica-sync.test.ts`: no row request is made; a repair
     sends only unpushed events.
   - Depends on: ES-9.
9. **ES-11 No client tables.** **Dropped** (2026-10-21). The client keeps
   `nodes`, `link` and `views` as the cache of the fold.
10. **ES-12 Strictly append-only.** **Dropped** (2026-10-21: Finn closed
    #273, not merged). No trigger and no migration are added, and
    `event_purges` stays. See "Append-only by convention".
11. **ES-13 Retire the browser's row endpoints.**
    - Scope: raise `MIN_REPLICA_PROTOCOL` to 3 (a dashboard step first,
      as docs/graph-storage.md describes), then remove the browser's use
      of `PUT` and `GET /api/replica/notes`. `writeRows` stays for MCP and
      shares.
    - Files: `worker/handlers/replica.ts`, `worker/handlers/replica-corpus.ts`.
    - Tests: a version 2 client is refused with the update notice; MCP and
      share writes still land.
    - Depends on: ES-10, and the old bundles gone from use.

### Built so far

| plan item    | PR                                   |
| ------------ | ------------------------------------ |
| ES-1         | #271                                 |
| ES-2         | #276                                 |
| ES-3         | #281                                 |
| ES-4         | #275                                 |
| ES-5 to ES-7 | #280, #284, #285: to rework into one |
| ES-8         | in progress                          |
| ES-11        | dropped                              |
| ES-12        | dropped                              |

The PRs are stacked, and merge in this order: ES-1, ES-2, ES-4, ES-3, the
ES-5 to ES-7 rework, then GW-19 (#286, the view's `stack` field,
docs/graph-walk.md) and ES-8. ES-11 and ES-12 are dropped; #273 was closed,
not merged.
