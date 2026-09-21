# Event sourcing (spike)

**Status: spike, not wired in.** Branch `spike/event-sourcing`. The log, its
fold, the server append and its projections exist and are tested; the client
still pushes rows. This document is the design, what the spike proved, and the
decisions still open.

## Why

On 2026-09-19 a tester lost a heading and two bullets typed during a call.
Nothing was broken: fifteen seconds of ordinary edits (text cleared, markers
stripped, blocks unlinked) were pushed and accepted. The corpus tables are
written last-writer-wins, so a row holds its final state and an overwrite
destroys what it replaces. Two things followed:

- **Recovery** needed D1 Time Travel, which restores _in place_. Reading the
  lost text meant rolling production back for ten seconds.
- **Diagnosis** was inference from gaps in `seq`. There is no record of which
  command ran, from which tab, believing what about the row.

An event log answers both with a `SELECT`, and turns restore into an append.
It does **not** prevent the wipe — the events would have recorded it
faithfully. That needs an editor fix, separately.

## The decision: the log is the truth

`events` is append-only and authoritative. `nodes`, `link` and `views` become
**projections**: the value of folding the log, kept current by applying each
append to them _in the same transaction_. Everything that reads the corpus —
pulls, MCP, shares, search, the D1 console — goes on reading the tables it
always has. This is the standard shape (Fowler's _Event Sourcing_; CQRS read
models; LiveStore's "materializers" are the same idea on the same stack).

The test that pins it: **fold(events) == tables**, after every append, and
after genesis on a copy of the production corpus (3,711 rows, four tenants,
exact match).

## The model

One event = one change to one entity.

|           | `create`                                | `update`                   | `delete`  | `restore`                                  |
| --------- | --------------------------------------- | -------------------------- | --------- | ------------------------------------------ |
| **block** | type, text, props, notes_id             | any of type / text / props | tombstone | fields to set back + `ref_seq`; live again |
| **link**  | source, destination, kind, sort_key     | sort_key (= reorder)       | unlink    | sort_key + live again                      |
| **view**  | root_id, filter, sort, pinned, sort_key | any of those               | tombstone | fields + live again                        |

Envelope: `id` (writer-minted, idempotency key), `seq` (replica-assigned total
order per tenant), `batch` (one gesture), `device`, `cause` (the command:
`backspaceEmpty`, `undo`, `mcp:append_block`), `actor` (verified user — not
always the owner, since shares), `base_seq` (the entity's seq as the writer
last saw it), `ref_seq` (restore only), `at` (writer's clock, informational),
`received_at`, `v` (event schema version).

### Three decisions inside that table

**Patches are absolute values, never relative diffs.** "text is now X", not
"insert X at 4". This is what makes everything else cheap: an event means the
same thing wherever it is replayed; a run of events rolls up by "last value of
each field wins"; a typing run coalesces to its last event. The cost is that
two people typing in the _same block_ at once is last-writer-wins on the whole
text — which is what the app does today, and the right trade until real-time
co-editing is a goal (that is a CRDT/OT project, and a different one).

**Reordering is a `link` update, not a block update.** A block can sit under
several parents (multi-homing) and has a position under each, so position is
`link.sort_key`, where it already lives. Reorder = `link.update`; move =
`link.delete` + `link.create`. A block update is type, text or props. The UI
can still _present_ a move as "block moved" — that is a rendering of the
history, not the shape of the log.

**`restore` is an event, never a rewind.** It carries the fields to set and
the `seq` it returns to. So a restore replicates by the ordinary pull, shows
in the history, and can itself be undone. One action covers both "undelete"
and "revert to the version of 11:06".

## "Rolling up" means four different things

1. **The fold** (`fold`, `stateAt`, `historyOf`) — log → state. `stateAt` is
   time travel; `historyOf` is a block's version history.
2. **Net change per append** (`netChanges`) — many events → one change per
   entity, so an append projects in a fixed number of statements.
3. **Typing coalescing** (`coalesceTyping`) — on the client, before push:
   consecutive text-only edits to one block from one device within 30s become
   the last one. Without it the log grows a row per 150ms of typing.
4. **Compaction** — _not built._ Old typing runs thinned further, or a
   snapshot event replacing a long prefix. Needed eventually; see Open.

## The write path

`planEventAppend` (worker/handlers/event-log.ts) returns **seven statements
for any number of events**, run as one `TenantDb.batch`:

1. `INSERT INTO events … SELECT … FROM json_each(?1) … ON CONFLICT DO NOTHING`
   — `seq = MAX(seq) + position`.
   2–7. Per table, an insert for what the append creates and an `UPDATE … FROM
json_each(?1)` for what it changes. Absent key = keep the column; JSON
   `null` = clear it (`json_type` tells them apart). Each row takes the `seq`
   of its last event, so **the existing since-cursor pull keeps working**.

Set-based because D1's free plan allows 50 queries per invocation and a paste
can create hundreds of blocks.

**Idempotent.** A retried push (the `pagehide` keepalive flush does this)
inserts nothing, and projections apply a change only if its last event was
inserted _by this append_ — so an old change can never be laid over newer rows.

**Append-only, structurally.** Triggers refuse `UPDATE`, and refuse `DELETE`
unless the tenant is named in `event_purges` — the door for account erasure.

## Ordering and conflicts

Order is **arrival order at the replica** (`seq`), not client clocks — the
model Linear and Replicache use. This quietly fixes something: today's LWW
compares client-stamped `updated_at`, so a device with a wrong clock wins or
loses forever. Under the log, conflict resolution becomes **per field by seq**
instead of per row by clock: one device retyping a block while another edits
its text no longer clobber each other.

`base_seq` records what the writer believed it was changing. The spike
**records but does not enforce** it. Enforcing (reject or flag when
`base_seq` is stale for that field) is how an offline device's week-old edit
stops silently overwriting newer work. Decide before the client ships.

## Genesis

`events_genesis.sql` seeds the log with one `create` per existing row, **under the seq the
row already holds**, so no cursor moves and the next event lands at MAX+1.
Tombstoned rows become a `create` carrying `deleted_at` — the only place that
is allowed: they have a final state and no history.

Running it on production's export found a real bug: **4 of 7 `views` rows have
`seq = 0`** (0015's backfill used the column default). A `seq > cursor` pull
can never deliver them, and they collide in the log's primary key. `events_genesis.sql`
numbers them first. Worth fixing on `main` regardless of this work.

## Cost, measured

- Genesis took the production export from 0.98 MB to 2.48 MB. Expect the log
  to be the larger part of the database from then on. Limits: 500 MB (free),
  10 GB (paid) per database.
- D1 bills rows written _including index entries_: today's 8-row restore
  reported 48 rows written. An event is ~4 (row, primary key, two indexes) on
  top of the projection write it causes. Free tier is 100k rows written/day.
  Coalescing is what keeps this sane.

## What the spike contains

- `migrations-spike/events.sql`, `events_genesis.sql` — outside `migrations/` on purpose: a
  merge to main runs `migrate:remote`, and they take real numbers only at cutover
- `src/data/events.ts` — types, `opsToEvents`, `viewChangeToEvent`, `fold`,
  `stateAt`, `historyOf`, `projectRows`, `netChanges`, `coalesceTyping`,
  `planRestore`, `planRestoreSubtree`, `upcast`
- `worker/handlers/event-log.ts` — `parseEvent`, `planEventAppend`,
  `appendEvents`, `readEventsSince`, `readEntityHistory`
- Tests, including the 19 September incident replayed: the wipe is appended,
  the block's history shows each step with its cause, and
  `planRestoreSubtree` puts the section back by appending `restore` events.

## Not built — the path to production

1. **Client write path.** `database-mode.ts` turns each op batch into events
   (`opsToEvents`), keeps an **outbox table** in the local store (durable
   across reloads — today's pending queue is in memory), coalesces, pushes to
   `PUT /api/replica/events`. Protocol bump to 3.
2. **`cause` plumbing.** Commands must pass their name down to `applyOps`.
   This is most of the diagnostic value and touches the editor.
3. **Every writer goes through the log.** MCP tools, shares' grantee writes,
   admin fixes. A row written around the log makes fold ≠ tables. Make
   `planReplicaPut` unreachable once cut over, and add `events` to the
   tenancy guard's table list.
4. **Cutover order.** Deploy Worker that appends → run the genesis migration → raise
   `MIN_REPLICA_PROTOCOL`. Rows written between genesis and the new Worker
   would be missing from the log, so the window must be closed (brief
   read-only, or dual-write first).
5. **Pull.** Rows-since-cursor keeps working and is the cheaper way to catch
   up. An event-shaped pull is only needed for history UI — fetch on demand.
6. **A verifier.** A scheduled job that folds each tenant's log and compares
   with the tables. Drift is the failure mode of this architecture; find it
   before a user does.
7. **History / restore UI.** The user-facing point of all this.

## Open decisions

- **Schema evolution.** Events are forever; this repo has shipped 17
  migrations in three weeks. Rule: never rewrite events, add an `upcast` case
  per shape change, keep every old shape readable. Field renames get
  expensive — this is the real long-term tax (Greg Young, _Versioning in an
  Event Sourced System_).
- **Erasure.** "Delete for good" and GDPR erasure vs an immutable log.
  Tenant-level purge is built. Per-block erasure is not: options are
  crypto-shredding (per-block key, delete the key) or a redaction event plus a
  compaction that drops the payloads. Images in R2 need the same answer.
- **Retention / compaction.** Keep everything forever, or thin typing runs
  older than N days and snapshot long prefixes? Decide before the log is big.
- **`base_seq` enforcement** (above).
- **Restore semantics.** `planRestoreSubtree` brings back what was there and
  leaves later links alone, so a block moved since can end up in two places.
  Alternative: restore also removes links created since. Pick per UI intent.
- **Undo.** The editor's undo is in-memory doc snapshots. It could become
  inverse events — durable across reloads, and the same machinery as restore.
- **Sequencer.** `MAX(seq)+n` inside a D1 batch is correct because D1
  serialises writes per database. A Durable Object per tenant is the natural
  sequencer (and gives websockets for live sync) — LiveStore's Cloudflare
  provider does exactly this — but it was deliberately reversed here for D1
  console visibility. The log design does not depend on the choice.
- **Build vs adopt.** LiveStore is this architecture as a library (SQLite in
  OPFS, event log, materializers, Cloudflare sync). Adopting it means
  rewriting the store and sync layers around its model; building means owning
  the hard parts above. Worth an afternoon's evaluation before step 1.

## Prior art

- Martin Fowler, [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- [LiveStore: event sourcing](https://docs.livestore.dev/evaluation/event-sourcing/) and its
  [Cloudflare sync provider](https://docs.livestore.dev/sync-providers/cloudflare/)
- [Reverse engineering Linear's sync engine](https://github.com/wzhudev/reverse-linear-sync-engine)
  — monotonically increasing sync ids, server order, LWW; no CRDTs
- Figma, [How multiplayer works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
  — property-level last-writer-wins, server as the ordering authority
- Greg Young, [Versioning in an Event Sourced System](https://leanpub.com/esversioning)
- Cloudflare D1 [limits](https://developers.cloudflare.com/d1/platform/limits/) and
  [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
