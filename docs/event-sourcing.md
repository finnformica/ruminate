# Event sourcing

Every change to a block, a link or a view is stored as an **event**, in one
append-only log per tenant. The log is the truth; `nodes`, `link` and `views`
are what folding it yields, kept current in the same transaction as every
append. The browser makes the events itself — each batch of the editor's ops
becomes the events it amounts to, kept in a log of the device's own and pushed
from there — and the replica takes them in as made. Code: `src/data/events.ts`
(the vocabulary, the fold, ops → events, the wire's validation),
`worker/handlers/event-log.ts` (append, reconcile, reading the past),
`src/data/sql-note-store.ts` (the device's log and its projection),
`src/data/replica-sync.ts` (the push), `src/data/hlc.ts` (the stamp),
`src/data/snapshot.ts` (snapshots of the fold),
`migrations/0023_events.sql`, `migrations/0024_event_hlc.sql`.

**Decided 2026-10-20: event-only sync** ([event-only-sync.md](./event-only-sync.md)).
The browser keeps only its log, folds the app from it, and saves a snapshot
every 1,000 events or 24 hours, keeping 2. Sync pushes and pulls events
only. Each event carries a hybrid logical clock stamp (`hlc`); conflicts
resolve per field by that stamp, and `seq` is only the sync cursor. The
server keeps its tables as projections for MCP, search and shares. The log
is strictly append-only: nothing is ever purged. The sections below describe
the app until then, with each change marked.

## Why

On 2026-09-19 a tester lost a heading and two bullets typed during a call.
Nothing was broken: fifteen seconds of ordinary edits (text cleared, markers
stripped, blocks unlinked) were pushed and accepted. The corpus tables were
written last-writer-wins, so a row held its final state and an overwrite
destroyed what it replaced. Two things followed:

- **Recovery** needed D1 Time Travel, which restores _in place_. Reading the
  lost text meant rolling production back for ten seconds.
- **Diagnosis** was inference from gaps in `seq`. There was no record of what
  changed, in what order, from which tab, running which build.

With the log both are a `SELECT`, and putting something back is an append. It
does **not** prevent the wipe — the events record it faithfully. That is the
editor's to fix, separately.

## The shape

`events` is authoritative and append-only. `nodes`, `link` and `views` are
**projections**: read models, written in exactly one place
(`planEventAppend`), inside the batch that appends the events they follow
from. Everything that reads the corpus — pulls, MCP, shares, search, the D1
console — reads the tables it always has, and a row's `seq` is the `seq` of
the last event that touched it, so **the since-cursor pull is unchanged**.

The property everything rests on, pinned by tests and checkable in production
(`GET /api/replica/verify`): **fold(events) == tables**.

`fold` is a left fold in `seq` order. A second fold, `foldByStamp`, resolves
each field by the event's hybrid logical clock stamp (`src/data/hlc.ts`,
docs/event-only-sync.md): every field of an entity, and its liveness, is a
last-writer-wins register. Its state does not depend on the order of the
events, and an event applied twice changes nothing. An event without a stamp
gets the derived one (`eventStamp`, below), the same as every other reader.
`toGraphSnapshot` and `toViewRows` read its state out. Nothing in the app
reads it yet: `stateAt`, a history and the calendar use the fold by `seq`.

### The projection resolves by stamp

The replica's projection resolves the same way (0025, `planEventAppend`).
Each row keeps the stamp of each of its registers in a `stamps` column:

| entity | registers                                                  |
| ------ | ---------------------------------------------------------- |
| block  | `type`, `text`, `props`, `notes_id`, `alive`               |
| link   | `sort_key`, `alive` (the key never changes)                |
| view   | `root_id`, `filter`, `sort`, `pinned`, `sort_key`, `alive` |

- An append sets a register only when its stamp is higher than the one the
  row holds. A run of events rolls up to the highest-stamp value of each
  register, so the tables do not depend on the order the events arrive in.
- A row takes the `at` of the event with the highest stamp as its
  `updated_at`, as `foldByStamp` does. Its `seq` is the last event that
  touched it, not the highest stamp: `seq` is the pull cursor. `foldByStamp`
  keeps the same `seq`, the highest it has applied.
- An event on an entity the replica does not hold is rejected unless it
  creates it, as the fold by `seq` does: an update cannot land before its
  create.
- **A row from before 0025** holds no `stamps`. Each of its registers
  resolves by the stamp its last event derives (`updated_at`, `seq`), and the
  first append that touches it writes them all, with `legacy`: the `seq` the
  old rule projected it up to. The tables are never rewritten for this.
- `verify` folds each row's log up to `legacy` by `seq`, as it was projected,
  and by stamp after (`projectLog`, `worker/handlers/event-log.ts`). It
  compares every field and every stamp. The SQL spells `eventStamp`'s
  derivation once (`derivedStamp`), because an event's `seq` is assigned in
  SQL; a test pins the two together.

### One event = one change to one entity

|           | `create`                                | `update`             | `delete`  | `restore`                                  |
| --------- | --------------------------------------- | -------------------- | --------- | ------------------------------------------ |
| **block** | type, text, props, notes_id             | any of those         | tombstone | fields to set back + `ref_seq`; live again |
| **link**  | source, destination, kind, sort_key     | sort_key (= reorder) | unlink    | sort_key + live again                      |
| **view**  | root_id, filter, sort, pinned, sort_key | any of those         | tombstone | fields + live again                        |

**Decided 2026-10-20.** A view event gains `stack`, the frames below a
View's top frame ([graph-walk.md](./graph-walk.md), "Views save stacks").
Every event gains `hlc`, the writer's hybrid logical clock stamp; an event
written before it has one derived at read time
([event-only-sync.md](./event-only-sync.md), "The stamp").

**Patches are absolute values, never relative diffs** — "text is now X", not
"insert X at 4". An event means the same thing wherever it is replayed, and a
run of events rolls up to one value per field — the last (`netChanges`, in
the browser's store) or the highest stamp (`stampedChanges`, at the replica)
— which is what lets an append of any size project in a fixed number of
statements.
The cost: two people typing in the _same block_ at once is last-writer-wins on
the whole text, as it is today. Real-time co-editing would be a CRDT project.

**Reordering is a `link` update, not a block update.** A block can sit under
several parents and has a position under each, so position is
`link.sort_key`, where it always lived. Reorder = `link.update`; move =
`link.delete` + `link.create`. A history UI can still _say_ "block moved".

**`restore` is an event, never a rewind.** It carries the fields to set and
the `seq` it returns to, so it replicates by the ordinary pull, shows in the
history, and can itself be undone. One action covers "undelete" and "revert".

### What is stored beside the change

| column        | why                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `seq`         | The tenant's total order. Assigned in SQL at append. The only thing that orders events.                                         |
| `received_at` | The **replica's** clock. "As of 11:06" is answered as the last event received by then. Indexed.                                 |
| `at`          | The writer's clock (the row's `updated_at`). Informational, and written back to the projection.                                 |
| `tz`          | The writer's UTC offset at `at`, minutes east. What **day** an edit was for the writer; null = unsaid.                          |
| `v`           | The shape the patch was written in, so a reader years on can upcast it. Events are never rewritten.                             |
| `actor`       | The verified user who wrote it — a share's grantee writes into the _owner's_ log.                                               |
| `origin`      | The door: `replica`, `mcp`, `share`, `system`.                                                                                  |
| `device`      | `<device>.<tab>` from `X-Ruminate-Device` (`src/data/writer-identity.ts`). Two tabs differ.                                     |
| `client`      | The build, from `X-Ruminate-Build` (the changelog version).                                                                     |
| `batch`       | One push. Groups the events that arrived together.                                                                              |
| `cause`       | The command, when a writer names one (`snapshot`, `restore`, `share:ensure-view`; a client may pass one through `useApplyOps`). |
| `base_seq`    | The entity's `seq` as the writer last saw it — what it believed it was changing (the cached row's `seq`, from its last pull).   |
| `ref_seq`     | On a restore: the moment being returned to.                                                                                     |
| `hlc`         | The writer's hybrid logical clock stamp (docs/event-only-sync.md). The projection resolves by it. Null before 0024: derived.    |
| `append`      | The request that appended it (idempotency of the projections).                                                                  |

Nothing else needs storing for a past moment to be viewable. Block content is
entirely in `type`/`text`/`props`; images live in R2 under ids held in
`props` and are **never deleted**, so an image block of last month still
resolves. Two things a past view does _not_ contain, by design: another
tenant's nodes reached through a share (their past is theirs), and link-card
previews (`/api/unfurl` is a cache of the live web).

## Two doors, one log

A current browser pushes **events** — its own account of what it did
(`PUT /api/replica/events`, `appendClientEvents`). Everything else hands over
**rows** — a share's grantee, an MCP tool, every cached bundle of the app
still in the wild, and the browser's own full push after a repair — and lands
in `writeRows`:

1. read the rows the write names (three primary-key lookups),
2. derive the events the difference amounts to (`rowsToEvents`),
3. reconcile + append + project, in one atomic batch.

### The client speaks events

**Decided 2026-10-20.** The pull of rows goes: the events pull below becomes
the only pull, and the device's log becomes the only thing the device keeps
([event-only-sync.md](./event-only-sync.md), "Write, push, pull").

The browser is the one writer that knows what it did, so it says so. In the
database runtime (`src/data/database-mode.ts`) each batch of the editor's ops
is applied to the graph atom and, against the graph it was planned on,
translated to events (`opsToEvents`; a view row becomes its one event with
`viewChangeToEvent`). The batch's events share a `batch` id, the tab's
`device` (`src/data/writer-identity.ts`), the writer's clock and `tz`, a
`cause` when the caller names one, and each carries the cached row's `seq` as
its `base_seq`. Each event also takes its own **stamp** (`hlc`,
`src/data/hlc.ts`): the next after the device's last, which the runtime keeps
in `meta` (`hlc_last`) and moves up to every stamp it pulls. An event without
one (made before stamps, or derived at the replica from rows) gets one derived
when it is read: `ms` from its `at`, counter 0, `seq:<seq>` as the device,
with the `seq` zero-padded to 15 digits so that two such events in one ms keep
their `seq` order (`eventStamp`, the one place this rule lives). The replica's
projection and `foldByStamp` resolve by the stamp; `seq` still orders `fold`
and the browser's own rows. A typing run coalesces to its last event before it lands
(`coalesceTyping`): once in the runtime, over the ops still coalescing, and
again in the store against the unpushed tail of its log — never into an event
a push already holds (`inFlightEventIds`).

The store (`src/data/sql-note-store.ts`) then lands the events twice in one
transaction: appended to its own `events` table — the **device's log**, and
the push queue — and applied to its rows as the replica applied the same
events to its before stamps (0025): a create inserts or revives, an update
sets what its patch names, a delete tombstones, a restore revives, each row
taking the event's `at` as its `updated_at`. The device's log is not the
tenant's: it holds what this device did. Other devices' changes still arrive
as rows, by the pull, as they always have.

The device's log also holds **everyone's** events, by the events pull: after
each pull of rows the runtime asks for the log past its events cursor
(`GET /api/replica/events?since=`, in pages) and files what comes back as
placed (`applyPulledEvents`) — this device's own among them, which is also how
an event whose push was taken but never answered is placed. Only the log is
written by it; the rows still arrive by the pull of rows. The log is for
history: the calendar folds a day from it (below).

The push loop (`src/data/replica-sync.ts`) reads the log's unpushed tail
(`seq IS NULL`), sends it in the order made, and stamps each event — and the
row it changed — with the `seq` the replica answers. The queue is therefore
durable: a reload no longer loses what had not pushed, and a previous
session's leftovers go first. The replica (`appendClientEvents`) answers a
re-sent event with the seq it already has, drops a **stale** event, and
appends the rest, reconcile first. An event is stale when it would set no
register: every field it names, and its liveness for a create, delete or
restore, already holds a stamp at least as high. So an offline device's old
edit to the text is dropped, and its old edit to the type of the same block
lands when the type is older still. An event without a stamp derives one
after every placed event, so for it the rule is the old one: older than the
row's `updated_at` is stale.

The row door stays for the writers that cannot speak events, and because the
full push is the repair path: after a SQL failure the store is rebuilt from
the atom and every row goes out through it.

The rule a row lands by is the one the row planner always applied — per-row
last-writer-wins on the writer's `updated_at`:

| held    | pushed | events                                              |
| ------- | ------ | --------------------------------------------------- |
| nothing | any    | `create` (carrying `deleted_at` if it arrives dead) |
| newer   | any    | none — stale, exactly as it used to write no row    |
| live    | live   | `update` of the fields that differ; none = no event |
| live    | dead   | `update` of what differs, then `delete`             |
| dead    | live   | `restore`, setting what differs                     |
| dead    | dead   | `update` of what differs, under the tombstone       |

The events the row door derives carry a **server stamp**: the replica's clock,
a counter for the place in the append, and `server:<origin>` as the device
(`server:mcp`, `server:share`, `server:replica`). The clock first moves up to
the highest stamp the rows it read hold, so a row that passes the check above
always lands, even when a writer's clock ran ahead of the replica's. A
restore stamps its events the same way, after the highest stamp in the log.

Deriving events **at the replica** for the row door is deliberate. It makes
"every change is an event" a property of the one place those writers pass,
rather than a promise each keeps — so there was no protocol bump, no client
that had to update before its edits were recorded, and no way to write around
the log: nothing else in the Worker holds an `INSERT` or `UPDATE` against
those tables. Its price is granularity: an event is "what one push changed in
one row", not "what one command did" — which is why the browser now speaks
events itself, and why the two doors write the same log.

One difference from the row planner, inside one window: rows are read _before_
the batch (D1 has no interactive transactions), so two writers racing on one
row both derive against the same held row and the higher **stamp** wins each
field, where the later `updated_at` used to. The fold and the tables agree
either way.

### Snapshots

The store keeps snapshots of the fold by stamp (`src/data/snapshot.ts`,
docs/event-only-sync.md, item 5) in its `snapshots` table (schema v12). A
snapshot is the encoded `StampedState`, every field with its stamp and
tombstones too, and the **log position** it covers.

- **Position.** `events.position` is the log's append order. Every event
  takes the next position: one this device makes, and one it pulls. An event
  the replica places (`markEventsPushed`, or a pull that brings back one of
  this device's own) moves to the next position. So the tail past a snapshot
  that took an event unpushed holds it again, with its `seq`.
- **When.** After each batch (`applyEvents`, `applyPulledEvents`) and at
  open, the store writes a snapshot when 1,000 events are past the newest one,
  or when the newest is 24 hours old and any event is past it. With no
  snapshot, the first event writes one.
- **Keep 2.** One write adds the new snapshot and deletes all but the 2
  newest. A snapshot is a cache of the log, so this is not a purge. A
  snapshot that fails to write does not fail the batch: the next batch tries
  again.
- **Read.** `loadFold` reads the newest snapshot that parses, then applies
  every event past its position. When the newest does not parse, it reads the
  one before. With none that parses, it folds the whole log. The fold does
  not depend on order and applies an event twice as once, so the result is
  the fold of the whole log.
- **Snapshot 0** (`snapshotZero`, docs/event-only-sync.md, item 6). The first
  open of this build folds the `nodes`, `link` and `views` rows, tombstones
  too, into a snapshot at the last position in `events`. So the fold holds
  every row the tables hold, also one whose events this device never had.
  Each row is the `create` it amounts to (`rowsToEvents`), with no stamp, the
  row's `updated_at` as `at` and the row's `seq`. So each field takes the
  stamp `eventStamp` derives for an old event: `updated_at`, counter 0,
  `seq:<seq>`. It runs once: the same write sets the `snapshot_zero` flag in
  `meta`. A snapshot of the log can be there already, so "no snapshot" does
  not say it has run. A store with no row sets the flag and writes nothing.
  `clear` keeps the flag: the pull after it brings the whole log again.

Nothing in the app reads the fold yet (item 7 of docs/event-only-sync.md).
`clear` deletes the snapshots with the log.

### Cost, by construction

- **A fixed number of statements**: 4 reconcile (one insert, after one
  statement per table that clears the stamps of the rows it snapshots) + 7
  per append (one insert over `json_each`, then insert-created /
  update-changed per table), however many events. D1's free plan allows 50
  queries per invocation.
- **Reads what it touches.** `UPDATE t … FROM json_each(?) WHERE t.id = …`
  _looks_ like a lookup and is a walk of every row the tenant has; hinting the
  key fixes that and leaves each row re-scanning the JSON for its values (n²
  — D1 flagged 92,100 rows read for a 300-block push). The changes are
  materialised as a table and the statement is driven _from_ it: one seek per
  change. A row the append's own INSERT just wrote is not updated again.
  `event-log.test.ts` pins every plan with `EXPLAIN QUERY PLAN`, because the
  slow forms return exactly the same rows and nothing else would notice.
- **Under D1's 2 MB bound-value cap**: an append is cut into runs of ≤750 KB,
  all in the one batch, sequence contiguous across them.
- **Idempotent**: re-sent rows equal held rows, so they derive no events.
  Re-sent _events_ insert nothing (`id` is unique) and project nothing (a
  change applies only if its last event was inserted by this append).
- Measured locally on a copy of production (3,711 rows): genesis ≈10 ms for the
  largest tenant; the log roughly 1.5× the size of the tables it describes.
  D1 bills index entries as rows written — an event is ~5 (row + 4 indexes).

## Reconcile: no backfill, and the log heals itself

A projection row's `seq` names the event it came from, so a row the log does
not know is recognisable: it holds a `seq` above anything in the log.
`planReconcile` runs **first in every write's batch** and records each such
row as a snapshot `create` under the `seq` it already holds (no cursor moves).

- **Genesis is just the first reconcile.** There is no backfill migration,
  because `npm run deploy` applies migrations _before_ uploading the Worker:
  rows the old Worker wrote in between would be missing from a log seeded by
  SQL. A tenant's first write — or first read of its log — seeds it instead.
- **A write around the log is repaired by the next write**, not left to
  drift: the old Worker during a rollout, a statement run in the console.
  The rows it snapshots also lose their `stamps`, which named values the row
  no longer holds: each then resolves by the stamp its snapshot derives.
- **A Worker from before 0025 does not keep `stamps`.** After a rollback to
  one, a row it changed through the log keeps stamps for values it no longer
  holds, and `verify` reports it as drift. Do not roll back past 0025.
- What it cannot see is a row changed _without_ taking a new `seq`. That is
  what `verify` is for.

History therefore begins at each tenant's snapshot. Earlier states were never
recorded; a moment before it is answered as the snapshot, and the response
says so (`earliest`).

`0023` also renumbers the views that 0015/0017 deliberately left at `seq = 0`
and 0021 did not reach (the ones rooted at blocks): reconcile finds rows by
`seq`, so a row at 0 would never enter the log. Each device pulls those few
rows once.

## Reading the past

All under `/api/replica/*`, session-guarded and tenant-scoped like the rest:

- `GET /events?since=<seq>&limit=<n>` — the log, oldest first.
  `&entity=block&entity_id=<id>` — one entity's version history.
- `GET /at?seq=<seq>` or `?at=<ms>` — the corpus as it stood: the pull's shape
  (`nodes`, `links`, `views`), folded from the log. Read-only.
- `POST /restore` `{ "block": "<id>", "seq": <n> }` — put a block, everything
  beneath it and its place under its parents back the way they were, by
  appending `restore` events. Links made since are left alone (a restore
  brings things back; it does not take later work away), so a block moved
  since can end up in both places.
- `GET /verify` — does folding the log still yield the tables? Reads
  everything; a diagnostic.

There is no UI for these yet. With a token in hand:

```sh
curl -s "$ORIGIN/api/replica/events?entity=block&entity_id=blk_…" \
  -H "Authorization: Bearer $TOKEN" -H "Cookie: gh_refresh=…" -H "X-Replica-Protocol: 2"
```

## A day on the calendar

A day (or a week) of the calendar is a page of its own (`/calendar/<day>`,
`/calendar/<week>`; `src/routes/_appRoot.calendar.$.tsx`) that shows what was
written on it (`src/data/day-changes.ts`, `src/components/day-changes.tsx`):
every note changed on it, laid out as its own page is — the name, which
stays at the top while the outline scrolls under it, then the outline in the
block editor's read-only mode — with what the day did to each row marked
(`BlockEditor.diff`, `block-item.tsx`): a row added or removed sits on its
tint with a `+` or `−` at the editor's edge, and a reworded row shows the
words that went and came. A row whose type changed — a task ticked, a line
made a heading — is drawn as a line diff draws it, since a key has no words
to diff: the row as it was goes out in red with its old key, and the row as it
is comes in in green just below. A row the day moved — a picture given another
value on a board, a row dragged under a different heading — is compared by
where it is held: it goes out in red where it stood and comes in in green where
it landed, and a row still held where it was and held somewhere new as well is
marked only in the new place. The outline folds as the note's own view folds (the
reader's folds over the depth setting, `useFoldRule`), except that a row with
a change beneath it starts open whatever the depth setting says, so everything
the day did shows; the reader folds it like any other row. Then it is
cut down the way a pull request shows a file (`foldContext`): a changed row,
a row of context on either side, and the unchanged rows between folded behind
"n rows above" / "n rows below", each click giving back a few more.
"Before" is the fold of everything placed ahead of the day's first event;
"after" is that fold with the day's events — and only the day's — applied on
top, so what shows is what the day's edits did, whatever landed around them
from another device or another day. Two readings, kept as a display setting
(`calendarChangesViewAtom`): **by note**, each note once with the whole
period's changes, and **in order**, sitting by sitting — a sitting being one
device's run of edits with no pause over half an hour (`sittingsIn`), labelled
with the writer's clock and, where it is not the reader's, the writer's zone.

**Before history began.** The log was seeded from the rows the replica held
(the reconcile above): one snapshot `create` per row, stamped with the row's
last save. The calendar reads a snapshot as the row written on that day —
the last save before the log is the nearest thing to a date it has — so a
note's rows show as added on the days they were last saved, and history
begins on the earliest. A tombstone's snapshot is skipped, and so is a
note's own row (its stamp is the note's last save, not a day anything was
written; the note is placed at the very beginning of history so its rows are
found on their own days). A snapshot's `seq` is the row's old one and says
nothing about when it was saved, so the calendar reads the log as the notes'
snapshots first, then the other snapshots by the day they were saved, then
the edits by `seq` (`byPlace`); every edit after the seed is exact against
the rows it found.

There are no daily or weekly notes: a day is not a note and nothing is written
on the calendar page itself. A note that was kept under a date-shaped id
before is an ordinary note now, still at `/views/<id>`; such an id with no
note behind it goes on to `/calendar/<id>`.

**Whose day.** An edit belongs to the day it was for the person making it,
read from `at` in the writer's own `tz`; a line typed at 23:30 in London is
Friday's wherever it is read from later. An event without a zone (one the
replica derived from pushed rows) is read in the viewer's. The calendar itself
is drawn in the viewer's zone: today is today where the reader is.

A day before the log began is not an empty day but one history cannot answer,
and the page says so (`earliest`).

## Append-only, structurally

**Decided 2026-10-20: strictly append-only.** The `event_purges` door closes:
the triggers refuse every `DELETE`, for every tenant. A delete and a restore
are events, and nothing is ever purged. An account can then not be erased
from the log; erasure, if it is needed, is a new design
([event-only-sync.md](./event-only-sync.md), "Strictly append-only").

Triggers refuse `UPDATE` on `events`, and refuse `DELETE` unless the tenant is
named in `event_purges` — the one door, for erasing an account.

## Rolling back

Safe in both directions. The table is additive, so the previous Worker runs
beside it untouched; whatever it writes meanwhile goes around the log, and the
first write after this Worker returns reconciles it. Nothing needs undoing.

## Open

**Decided 2026-10-20** for four of the items below
([event-only-sync.md](./event-only-sync.md)): **two pulls** become one, the
events pull; **per-block erasure** is not done, because nothing is purged;
**compaction** is not done, and snapshots bound the cost of a fold instead;
and the hybrid logical clock stamp answers what **`base_seq`** was kept for,
so an offline device's old edit does not win over a newer one.

- **A restore UI**, and a note's own history. The calendar is the first
  reader of the log; a block's version history and "put this back" from a
  past day are the next, on the same fold (`planRestoreSubtree` is written).
- **Two pulls.** The rows and the log are pulled separately; once every
  device holds the log, the rows can be folded from it and the pull of rows
  retired.
- **`cause` per command.** The wire carries it; no caller of `useApplyOps`
  names one yet.
- **Schema evolution.** Events are forever and this repo migrates weekly.
  Rule: never rewrite an event; add an `upcast` case per shape change.
- **Per-block erasure.** Tenant purge exists. "Delete this block for good"
  against an immutable log needs crypto-shredding or a redaction event plus
  compaction.
- **Compaction / retention.** Each push that touches a note also re-stamps the
  note row (`props.updated_at`), so typing yields two events per push. Fine at
  today's scale; thin old typing runs before the log is large. Folding a whole
  log for `/at` is O(events) — checkpoints when that starts to matter.
- **`base_seq` is recorded, not enforced.** Enforcing it is how an offline
  device's week-old edit would be flagged rather than win.
- **Undo** could become inverse events — durable across reloads, and the same
  machinery as restore.

## Prior art

- Martin Fowler, [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- [LiveStore](https://docs.livestore.dev/evaluation/event-sourcing/) — the same
  architecture as a library (SQLite, event log, materializers, a
  [Cloudflare sync provider](https://docs.livestore.dev/sync-providers/cloudflare/))
- [Reverse engineering Linear's sync engine](https://github.com/wzhudev/reverse-linear-sync-engine)
  — monotonically increasing sync ids, server order, last-writer-wins; no CRDTs
- Greg Young, [Versioning in an Event Sourced System](https://leanpub.com/esversioning)
- Cloudflare D1 [limits](https://developers.cloudflare.com/d1/platform/limits/) and
  [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
