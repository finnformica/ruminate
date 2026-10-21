# Event-only sync

Status: **Decided 2026-10-20, not built.** Finn decided each rule in
"The decisions" below. The rest of this document is how the rules are kept,
and the plan that builds them (the end of this document).

Today the log is beside the tables (docs/event-sourcing.md): the browser
pushes events, but it still keeps `nodes`, `link` and `views` tables, pulls
rows to fill them, and pulls the log a second time for history. This
document retires the rows on the browser. The browser keeps the log only,
and the app is a fold of it.

## The decisions

1. **The client keeps only the event log.** What the app shows is a fold of
   the log. A **snapshot** of the fold is saved every 1,000 events or every
   24 hours, whichever comes first, and the last 2 snapshots are kept. The
   log is never compacted.
2. **Sync pushes and pulls events only.** There is no row pull and no row
   push from the browser.
3. **Each event carries a hybrid logical clock (HLC) stamp.** A conflict
   resolves by that stamp. The server's `seq` is only the sync cursor: it
   says what a device has pulled, not which write wins.
4. **The server keeps its projection** (`nodes`, `link`, `views`) for the
   MCP server, search and shares.
5. **The log is strictly append-only.** A delete and a restore are events.
   Nothing is ever purged.
6. **Concurrent writes by agents are out of scope for now.** An agent's
   write resolves by stamp like any other write. There is no lock, lease or
   merge for agents.
7. **The migration is a one-time fold from today's tables.**
8. **The client search index rebuilds from the fold.** Nothing about search
   is stored.

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
event when it arrives, without a reorder. A snapshot plus any events after
it, in any order, is the state. The server and every device reach the same
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

The browser's store (`src/data/sql-note-store.ts`, OPFS) holds three
tables:

| table       | what                                                                   |
| ----------- | ---------------------------------------------------------------------- |
| `events`    | The log: this device's events and every pulled event. Never compacted. |
| `snapshots` | The last 2 snapshots of the fold.                                      |
| `meta`      | The pull cursor, the owner, the device's last stamp.                   |

`nodes`, `link` and `views` go from the browser.

### Snapshots

A snapshot is the fold, every field with its stamp, and the **log
position** it covers: the highest local row id of the `events` table that
the fold includes.

- **When.** After a batch is applied, if 1,000 events have been added since
  the last snapshot, or 24 hours have passed. Also at boot, when the newest
  snapshot is over either bound.
- **Keep 2.** Write the new snapshot, then delete all but the 2 newest. A
  snapshot is a cache of the log, not history, so a delete of a snapshot is
  not a purge.
- **Boot.** Read the newest snapshot that parses. If it does not parse, read
  the one before. Then apply every event after its log position. With no
  snapshot, fold the whole log.
- **Cost.** A snapshot holds every live and dead entity: about the size of
  today's three tables. Two of them, plus the log (about 1.5 times the
  tables, docs/event-sourcing.md), is about 3.5 times today's tables.

### Write, push, pull

1. **Write.** A batch of the editor's ops becomes events (`opsToEvents`),
   each stamped. They append to `events` and apply to the in-memory fold in
   one step. The UI never waits.
2. **Push.** The push loop sends the unpushed tail (`seq IS NULL`) in the
   order made (`PUT /api/replica/events`) and stamps each event with the
   `seq` the server answers. A re-sent event gets the `seq` it already has.
3. **Pull.** The pull asks for the log past the device's cursor
   (`GET /api/replica/events?since=`, in pages). Each event appends to
   `events` and applies to the fold. The cursor moves to the highest `seq`
   received.
4. **A fresh device** pulls the whole log from `seq` 0, in pages, then
   writes its first snapshot.

There is no **full push** and no repair from rows. A device whose store
fails rebuilds its fold from the log (or from the last good snapshot), then
sends its unpushed tail.

### Search

The block index (`blockIndexAtom`) and the note list (`notesAtom`) derive
from `graphSnapshotAtom`, which the fold now feeds. At boot they build from
the fold once it is loaded. Nothing about search is stored, so there is
nothing to migrate or repair.

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

## Strictly append-only

The triggers on `events` refuse every `UPDATE` and every `DELETE`. The
`event_purges` door (`migrations/0023_events.sql`), which lets a tenant's
events be deleted to erase an account, closes. A delete and a restore are
events; a block that is deleted is a block whose `alive` field is false.

This has a consequence Finn has to know: an account cannot be erased from
the log. Erasure, if it is needed later, is a new design (for example, keys
per tenant that can be destroyed). It is not part of this one.

## Agents

An agent writes through the MCP server, which writes through `writeRows`.
Its events carry a server stamp and resolve per field like any other write.
When an agent and a person change the same field at the same time, the
higher stamp wins, and the loser's value stays in the log. There is no
lock, lease or merge for agents for now.

## The migration

A one-time fold from today's tables.

- **On the browser.** The first boot of the new build, with no snapshot,
  writes snapshot 0 from its `nodes`, `link` and `views` rows. Each field
  takes a stamp derived from the row's `updated_at` (`ms`), counter 0, and
  `migration` as the device. Its log position is the highest row id in
  `events` at that moment. A `meta` flag records that snapshot 0 is
  written, and it alone decides whether to write it, so the fold from the
  tables runs once (ES-6). From then on the fold is the state. The tables
  stay, written and compared, until a later step removes them.
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
5. **ES-5 Snapshots.**
   - Scope: the `snapshots` table; write after 1,000 events or 24 hours;
     keep 2; read the newest that parses at boot, then the tail.
   - Files: `src/data/corpus-schema.ts`, `src/data/sql-note-store.ts`,
     `src/data/snapshot.ts`, `src/data/snapshot.test.ts`.
   - Tests: a snapshot round-trips; the 1,000-event and 24-hour bounds;
     only 2 remain; a corrupt newest snapshot falls back to the one before;
     no snapshot folds the whole log.
   - Depends on: ES-4.
6. **ES-6 Snapshot 0 from the tables.**
   - Scope: the one-time fold of today's tables into the first snapshot,
     with derived stamps, run once (a `meta` flag).
   - Files: `src/data/snapshot.ts`, `src/data/sql-note-store.ts`.
   - Tests: snapshot 0 equals `getGraph()` of the tables; it runs once; a
     reload keeps it.
   - Depends on: ES-5.
7. **ES-7 The app reads the fold.**
   - Scope: the database runtime feeds `databaseGraphAtom` from the
     snapshot and the log. The tables are still written. After each batch
     a check compares the fold with the tables and records a difference
     in Settings → Storage diagnostics.
   - Files: `src/data/database-mode.ts`, `src/data/note-store.ts`,
     `src/data/sql-note-store.ts`.
   - Tests: `database-mode.test.ts`: boot from a snapshot and a tail; an
     edit; a pulled event; the check finds a planted difference.
   - Depends on: ES-2, ES-6.
8. **ES-8 Search from the fold.**
   - Scope: confirm and pin that the block index and the note list build
     from the fold at boot, with nothing stored.
   - Files: `src/global-state.ts` (only if a change is needed), the block
     index tests.
   - Tests: the index after a boot from a snapshot equals the index after
     a full fold.
   - Depends on: ES-7.
9. **ES-9 Pull events only.**
   - Scope: boot and the since-pull stop pulling rows. A fresh device
     pulls the whole log in pages. `REPLICA_PROTOCOL` becomes 3.
   - Files: `src/data/database-mode.ts`, `src/data/d1-note-source.ts`,
     `worker/handlers/replica-payload.ts`, `worker/handlers/replica.ts`.
   - Tests: a fresh device boots from events alone; a quiet pull is one
     request; a version 2 client is still served.
   - Depends on: ES-3, ES-7. Soak ES-7 for a week with no fold difference
     first.
10. **ES-10 Push events only.**
    - Scope: the row push, the full push and the "Push full copy" action
      go. A repair rebuilds the fold from the log and re-sends the
      unpushed tail.
    - Files: `src/data/replica-sync.ts`, `src/data/database-mode.ts`, the
      Settings storage card in `src/components/settings/`.
    - Tests: `replica-sync.test.ts`: no row request is made; a repair
      sends only unpushed events.
    - Depends on: ES-9.
11. **ES-11 No client tables.**
    - Scope: stop writing `nodes`, `link` and `views` on the browser and
      drop them from the client's schema ladder. `NoteStore` loses
      `getAllRows` and `applyPull`. Update `CLAUDE.md` (the store's
      methods) and docs/graph-storage.md.
    - Files: `src/data/note-store.ts`, `src/data/sql-note-store.ts`,
      `src/data/corpus-schema.ts`, `src/data/database-mode.ts`
      (`CACHE_GENERATION`), `CLAUDE.md`.
    - Tests: `sql-note-store.test.ts`, `corpus-schema.test.ts`: the ladder
      drops the tables; a store from the old shape boots from snapshot 0.
    - Depends on: ES-10.
12. **ES-12 Strictly append-only.**
    - Scope: the trigger on `events` refuses every `DELETE`; drop
      `event_purges`.
    - Files: `migrations/0026_events_no_purge.sql`,
      `worker/handlers/event-log.test.ts`.
    - Tests: a `DELETE` is refused for every tenant; the old purge test
      becomes a refusal test.
    - Depends on: nothing. Confirm the erasure consequence with Finn
      before merge.
13. **ES-13 Retire the browser's row endpoints.**
    - Scope: raise `MIN_REPLICA_PROTOCOL` to 3 (a dashboard step first,
      as docs/graph-storage.md describes), then remove the browser's use
      of `PUT` and `GET /api/replica/notes`. `writeRows` stays for MCP and
      shares.
    - Files: `worker/handlers/replica.ts`, `worker/handlers/replica-corpus.ts`.
    - Tests: a version 2 client is refused with the update notice; MCP and
      share writes still land.
    - Depends on: ES-11, and the old bundles gone from use.
