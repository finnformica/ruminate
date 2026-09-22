# Event sourcing

Every change to a block, a link or a view is stored as an **event**, in one
append-only log per tenant. The log is the truth; `nodes`, `link` and `views`
are what folding it yields, kept current in the same transaction as every
append. Code: `src/data/events.ts` (the vocabulary and the fold),
`worker/handlers/event-log.ts` (append, reconcile, reading the past),
`migrations/0018_events.sql`.

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
the last event applied to it, so **the since-cursor pull is unchanged**.

The property everything rests on, pinned by tests and checkable in production
(`GET /api/replica/verify`): **fold(events) == tables**.

### One event = one change to one entity

|           | `create`                                | `update`             | `delete`  | `restore`                                  |
| --------- | --------------------------------------- | -------------------- | --------- | ------------------------------------------ |
| **block** | type, text, props, notes_id             | any of those         | tombstone | fields to set back + `ref_seq`; live again |
| **link**  | source, destination, kind, sort_key     | sort_key (= reorder) | unlink    | sort_key + live again                      |
| **view**  | root_id, filter, sort, pinned, sort_key | any of those         | tombstone | fields + live again                        |

**Patches are absolute values, never relative diffs** — "text is now X", not
"insert X at 4". An event means the same thing wherever it is replayed, and a
run of events rolls up to "the last value of each field" (`netChanges`), which
is what lets an append of any size project in a fixed number of statements.
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

| column        | why                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `seq`         | The tenant's total order. Assigned in SQL at append. The only thing that orders events.             |
| `received_at` | The **replica's** clock. "As of 11:06" is answered as the last event received by then. Indexed.     |
| `at`          | The writer's clock (the row's `updated_at`). Informational, and written back to the projection.     |
| `v`           | The shape the patch was written in, so a reader years on can upcast it. Events are never rewritten. |
| `actor`       | The verified user who wrote it — a share's grantee writes into the _owner's_ log.                   |
| `origin`      | The door: `replica`, `mcp`, `share`, `system`.                                                      |
| `device`      | `<device>.<tab>` from `X-Ruminate-Device` (`src/data/writer-identity.ts`). Two tabs differ.         |
| `client`      | The build, from `X-Ruminate-Build` (the changelog version).                                         |
| `batch`       | One push. Groups the events that arrived together.                                                  |
| `cause`       | The command, when a writer names one (`snapshot`, `restore`, `share:ensure-view` today).            |
| `base_seq`    | The entity's `seq` as the writer last saw it — what it believed it was changing.                    |
| `ref_seq`     | On a restore: the moment being returned to.                                                         |
| `append`      | The request that appended it (idempotency of the projections).                                      |

Nothing else needs storing for a past moment to be viewable. Block content is
entirely in `type`/`text`/`props`; images live in R2 under ids held in
`props` and are **never deleted**, so an image block of last month still
resolves. Two things a past view does _not_ contain, by design: another
tenant's nodes reached through a share (their past is theirs), and link-card
previews (`/api/unfurl` is a cache of the live web).

## One door: rows in, events appended

Every writer hands over **rows** — the browser's push, a share's grantee, an
MCP tool, and every cached bundle of the app still in the wild. They all land
in `writeRows`:

1. read the rows the write names (three primary-key lookups),
2. derive the events the difference amounts to (`rowsToEvents`),
3. reconcile + append + project, in one atomic batch.

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

Deriving events **at the replica** is deliberate. It makes "every change is an
event" a property of the one place all writers pass, rather than a promise
each writer keeps — so there was no protocol bump, no client that must update
before its edits are recorded, and no way to write around the log: nothing
else in the Worker holds an `INSERT` or `UPDATE` against those tables. The
price is granularity: an event is "what one push changed in one row" (the
client flushes ~2s after a change), not "what one keystroke or command did".
A client that speaks events itself (`opsToEvents`, already written) can be
let in beside this later to carry a `cause` per command; the log does not
change when it is.

One difference from the row planner, inside one window: rows are read _before_
the batch (D1 has no interactive transactions), so two writers racing on one
row both derive against the same held row and the later **append** wins,
where the later `updated_at` used to. The fold and the tables agree either
way.

### Cost, by construction

- **A fixed number of statements**: 1 reconcile + 7 per append (one insert
  over `json_each`, then insert-created / update-changed per table), however
  many events. D1's free plan allows 50 queries per invocation.
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
- What it cannot see is a row changed _without_ taking a new `seq`. That is
  what `verify` is for.

History therefore begins at each tenant's snapshot. Earlier states were never
recorded; a moment before it is answered as the snapshot, and the response
says so (`earliest`).

`0018` also renumbers the views that 0015/0017 deliberately left at `seq = 0`:
reconcile finds rows by `seq`, so a row at 0 would never enter the log. Each
device pulls those few rows once.

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

## Append-only, structurally

Triggers refuse `UPDATE` on `events`, and refuse `DELETE` unless the tenant is
named in `event_purges` — the one door, for erasing an account.

## Rolling back

Safe in both directions. The table is additive, so the previous Worker runs
beside it untouched; whatever it writes meanwhile goes around the log, and the
first write after this Worker returns reconciles it. Nothing needs undoing.

## Open

- **A history / restore UI**, and `cause` per command (the client speaking
  events) — the user-facing point of all this.
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
