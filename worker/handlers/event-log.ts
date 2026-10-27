// The event log: the one way anything is written to the corpus, and the ways
// a past moment is read back out of it (docs/event-sourcing.md,
// migrations/0023).
//
// `events` is the truth. `nodes`, `link` and `views` are its PROJECTIONS —
// what folding the log yields — and they are written in exactly one place,
// `planEventAppend`, inside the same atomic batch that appends the events they
// follow from. So the projections are never ahead of the log nor behind it,
// and everything that reads the corpus (pulls, MCP, shares, search, the D1
// console) goes on reading the tables it always has.
//
// ## One door
//
// Every writer hands over ROWS — the browser's push, a share's grantee, an
// MCP tool, and every cached bundle of the app still in the wild. `writeRows`
// is where all of them land: it reads the rows the write names, derives the
// events the difference amounts to (`rowsToEvents`, last-writer-wins exactly
// as the row planner had it), and appends. No writer has to speak events for
// its change to be one, and none can write around the log, because nothing
// else in the Worker holds an INSERT or UPDATE against those tables.
//
// ## A fixed number of statements
//
// D1 allows 50 queries per Worker invocation on the free plan, and a paste
// can create two hundred blocks. So nothing here is per-event: the events
// travel as one JSON parameter and are inserted by one statement over
// `json_each`; their net effect per entity (`netChanges` — patches are
// absolute, so a run rolls up to "last value of each field") travels as one
// JSON parameter per table and lands in two statements each. Every lookup in
// them is a primary-key seek driven FROM the JSON (`changesAs`), never a walk
// of the tenant's rows nor of the JSON per row: a push reads what it touches.
//
// ## By stamp
//
// Each field of a row, and its liveness, is a last-writer-wins register on
// the stamp of the event that set it (`eventStamp`, src/data/hlc.ts;
// docs/event-only-sync.md). The row keeps those stamps (`stamps`, 0025), and
// an append sets a field only under a higher stamp than the one it holds. So
// the tables do not depend on the order the events arrive in, and two devices
// that change two fields of one block both keep their change. A row from
// before 0025 holds no stamps: each of its fields resolves by the stamp
// derived from its `updated_at` and `seq`, and the first append that touches
// it writes them all, with the `seq` the old rule projected it up to.
//
// ## Sequence
//
// `seq` is assigned in SQL, as MAX(seq) + position. SQLite materialises an
// INSERT … SELECT that reads its own table before writing, so the MAX is read
// once, before any row of this append exists, and positions are contiguous. A
// projection row takes the `seq` of the last event that touched it — which
// keeps the since-cursor pull exact, as 0005 made it, and gives the log an
// invariant worth having: **a row's `seq` names the event it came from.**
//
// ## Reconcile: the log heals itself
//
// That invariant is also how a row the log does not know is recognised: it
// holds a `seq` above anything in the log. `planReconcile` runs first in
// every write's batch and records each such row as a snapshot `create`. On a
// tenant's first write after 0023 that is its whole corpus — genesis, with no
// backfill migration and therefore no window between a migration and the
// Worker that honours it. Ever after it is a no-op that reads nothing, unless
// something wrote around the log, in which case the next write repairs it.

import {
  eventStamp,
  fold,
  linkEntityId,
  planRestoreSubtree,
  projectRows,
  rowsToEvents,
  type CurrentRows,
  type Entity,
  type RowWrite,
  type RuminateEvent,
} from "../../src/data/events"
import { parseProps } from "../../src/data/graph"
import { decodeHlc, encodeHlc, tickHlc, type Hlc } from "../../src/data/hlc"
import {
  assembleLogState,
  canonicalJson,
  collapseKeyEvents,
  derivedProps,
  expandEvent,
  foldKeys,
  isPropsRegister,
  keyEventStamp,
  keyStateAt,
  parseStoredKeyEvent,
  propNameOf,
  type KeyEvent,
  type LoggedKeyEvent,
} from "../../src/data/key-events"
import type { SqlStatement, SqlValue } from "../../src/data/sql-driver"
import type { TenantDb } from "../tenancy-db"
import {
  toLinkRow,
  toNodeRow,
  toViewRow,
  type LinkRow,
  type NodeRow,
  type ViewRow,
} from "./replica-payload"

/** The door a write came through. */
export type EventOrigin = "replica" | "mcp" | "share" | "system"

export interface WriteContext {
  /** The verified user writing — the tenant, or a grantee writing through a share. */
  actor: number
  origin: EventOrigin
  /** The tab, device or agent; a writer that does not say is `unknown`. */
  device?: string
  /** The build that wrote it. */
  client?: string | null
  cause?: string
  now?: number
  /** Names this request. Injectable for tests. */
  appendId?: string
}

interface AppendContext {
  actor: number
  origin: EventOrigin
  client: string | null
  now: number
  appendId: string
}

/**
 * Which log the rollup reads (docs/event-sourcing.md, "Per-key events"):
 * `new`, the per-key `events_log`, projects each block's props key by key
 * and derives `nodes.props` from `block_values`; `old` projects the old
 * `events` as before. Both logs are written either way, so a revert is a
 * flip of `EVENT_LOG_ROLLUP` in the dashboard, no deploy. The Worker sets
 * it from the environment on every request (`setEventLogRollup`,
 * worker/index.ts); the default is the new log.
 */
export type Rollup = "new" | "old"
let rollup: Rollup = "new"
export function setEventLogRollup(value: Rollup): void {
  rollup = value
}
export const rollupOf = (env: { EVENT_LOG_ROLLUP?: string }): Rollup =>
  env.EVENT_LOG_ROLLUP === "old" ? "old" : "new"

/** What a writer may say about itself: short, plain, and never trusted for
 * anything but the record. Anything else is dropped rather than stored. */
const SAYABLE = /^[\w.:+-]{1,64}$/
/** May this be stored as a writer's word about itself (a device, a build)? */
export const sayable = (word: string): boolean => SAYABLE.test(word)

/** The device and build a request names (src/data/writer-identity.ts). Header
 * names are spelled out here rather than imported: that module touches
 * `localStorage`, and the Worker has none. */
export function writerOf(request: Request): { device?: string; client: string | null } {
  const device = request.headers.get("X-Ruminate-Device")
  const build = request.headers.get("X-Ruminate-Build")
  return {
    ...(device !== null && SAYABLE.test(device) ? { device } : {}),
    client: build !== null && SAYABLE.test(build) ? build : null,
  }
}

const mintAppendId = () =>
  `apd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

const appendContext = (ctx: WriteContext): AppendContext => ({
  actor: ctx.actor,
  origin: ctx.origin,
  client: ctx.client ?? null,
  now: ctx.now ?? Date.now(),
  appendId: ctx.appendId ?? mintAppendId(),
})

// -----------------------------------------------------------------------------
// Reconcile
// -----------------------------------------------------------------------------

/**
 * Record every row the log does not know as a snapshot `create`, under the
 * `seq` the row already holds — so no cursor moves and nothing is re-pulled.
 *
 * ONE insert, deliberately. Each arm asks for rows above the log's MAX;
 * three inserts would let the first arm's rows raise that MAX under the
 * other two, and rows between would be skipped. As one INSERT … SELECT the
 * MAX is read once, before anything is written.
 *
 * Before it, the same rows lose their `stamps`: a write around the log left
 * them naming values the row no longer holds. With none, the row resolves by
 * the stamp its snapshot derives, as a row from before 0025 does, and `verify`
 * folds its log up to the snapshot by `seq`. These three change no event, so
 * the MAX they read is the one the insert reads.
 */
export function planReconcile(ctx: { now: number; appendId: string }): SqlStatement[] {
  const columns =
    "user_id, seq, id, entity, entity_id, action, patch, v, batch, origin, device, client, " +
    "cause, actor, base_seq, ref_seq, at, tz, received_at, append"
  const tail = "1, 'snapshot', 'system', 'replica', NULL, 'snapshot', :tenant, NULL, NULL"
  const above = "seq > (SELECT COALESCE(MAX(e.seq), 0) FROM events e WHERE e.user_id = :tenant)"
  const unstamp = (table: string): SqlStatement => ({
    sql:
      `UPDATE ${table} SET stamps = NULL WHERE user_id = :tenant AND ${above} ` +
      "AND stamps IS NOT NULL /* includes-deleted: a tombstone written around the log too */",
  })
  return [
    unstamp("nodes"),
    unstamp("link"),
    unstamp("views"),
    {
      sql:
        `INSERT INTO events (${columns}) ` +
        "SELECT :tenant, seq, 'snap_block_' || id || '_' || seq, 'block', id, 'create', " +
        "json_object('type', type, 'text', text, 'props', props, 'notes_id', notes_id, " +
        `'deleted_at', deleted_at), ${tail}, updated_at, NULL, ?1, ?2 ` +
        `FROM nodes WHERE user_id = :tenant AND ${above} ` +
        "UNION ALL " +
        "SELECT :tenant, seq, " +
        "'snap_link_' || source_id || '|' || destination_id || '|' || kind || '_' || seq, " +
        "'link', source_id || '|' || destination_id || '|' || kind, 'create', " +
        "json_object('source_id', source_id, 'destination_id', destination_id, 'kind', kind, " +
        `'sort_key', sort_key, 'deleted_at', deleted_at), ${tail}, updated_at, NULL, ?1, ?2 ` +
        `FROM link WHERE user_id = :tenant AND ${above} ` +
        "UNION ALL " +
        "SELECT :tenant, seq, 'snap_view_' || id || '_' || seq, 'view', id, 'create', " +
        "json_object('root_id', root_id, 'filter', filter, 'sort', sort, " +
        "'pinned', json(CASE pinned WHEN 1 THEN 'true' ELSE 'false' END), " +
        `'sort_key', sort_key, 'stack', stack, 'deleted_at', deleted_at), ${tail}, ` +
        `updated_at, NULL, ?1, ?2 FROM views WHERE user_id = :tenant AND ${above} ` +
        "ON CONFLICT DO NOTHING " +
        "/* includes-deleted: a snapshot records tombstones as it finds them */",
      params: [ctx.now, ctx.appendId],
    },
  ]
}

/** Reconcile on its own — for a read of the log by a tenant who has not
 * written since 0023, whose log would otherwise be empty. */
export async function reconcileLog(tenant: TenantDb, now: number = Date.now()): Promise<void> {
  const ctx = { now, appendId: mintAppendId() }
  await tenant.includingDeleted().batch([...planReconcile(ctx), ...planLogFill(ctx)])
}

// -----------------------------------------------------------------------------
// Append
// -----------------------------------------------------------------------------

/** The seq of a change's last event — the projection row's `seq`. */
const SEQ_OF_LAST_EVENT =
  "(SELECT e.seq FROM events e WHERE e.user_id = :tenant " +
  "AND e.id = json_extract(j.value, '$.last_event'))"
/**
 * True only for a change this very append inserted. An event id is unique and
 * the insert is ON CONFLICT DO NOTHING, so a re-sent append adds nothing to
 * the log — and must add nothing to the projections either.
 */
const INSERTED_BY_THIS_APPEND =
  "EXISTS (SELECT 1 FROM events e WHERE e.user_id = :tenant " +
  "AND e.id = json_extract(j.value, '$.last_event') AND e.append = ?2)"

/** The fields each entity resolves by stamp, as its row holds them. A link's
 * key (source, destination, kind) never changes, so it is not one. Each row
 * also resolves its liveness (`alive`: `deleted_at`) by stamp. */
const RESOLVED: Record<Entity, readonly string[]> = {
  block: ["type", "text", "props", "notes_id"],
  link: ["sort_key"],
  view: ["root_id", "filter", "sort", "pinned", "sort_key", "stack"],
}
const registersOf = (entity: Entity) => [...RESOLVED[entity], "alive"]

/** The largest `ms` a stamp can hold (`encodeHlc`). */
const MAX_STAMP_MS = 10 ** 15 - 1
/**
 * `eventStamp`'s derivation (src/data/events.ts), in SQL: `ms` from `at`,
 * counter 0, and `seq:` with the `seq` padded to 15 digits. The SQL needs its
 * own spelling only because an event's `seq` is assigned in SQL; the test
 * suite pins it to `eventStamp`, so the two cannot drift apart.
 */
const derivedStamp = (at: string, seq: string) =>
  `printf('%015d-0000-seq:%015d', MIN(MAX(${at}, 0), ${MAX_STAMP_MS}), ${seq})`
/** The stamp an event in the log resolves by, found by its id (one seek). */
const stampOf = (eventId: string) =>
  `(SELECT COALESCE(e.hlc, ${derivedStamp("e.at", "e.seq")}) FROM events e ` +
  `WHERE e.user_id = :tenant AND e.id = ${eventId})`
/** The stamp a row holds for a register: its own, or — on a row no append
 * has touched since 0025 — the one derived from its last event. A row with
 * stamps that has none for a register holds the empty stamp, which any event
 * that names it beats: a field added since the row was created (`stack`,
 * 0027) that no event has set. `heldStampOf` is the same rule in TypeScript. */
const heldStamp = (table: string, name: string) =>
  `CASE WHEN ${table}.stamps IS NULL ` +
  `THEN ${derivedStamp(`${table}.updated_at`, `${table}.seq`)} ` +
  `ELSE COALESCE(json_extract(${table}.stamps, '$.${name}'), '') END`
/** Does the change's stamp for a register beat the row's? False when the
 * change does not name it (its stamp is NULL). */
const wins = (table: string, name: string) => `j.s_${name} > ${heldStamp(table, name)}`

/** A field the change wins, else the row's own value. A JSON null is a value
 * the change sets ("clear props"); a field it does not name has no stamp. */
const field = (table: string, name: string) =>
  `${name} = CASE WHEN ${wins(table, name)} ` +
  `THEN json_extract(j.value, '$.set.${name}.value') ELSE ${table}.${name} END`
const tombstone = (table: string) =>
  `deleted_at = CASE WHEN ${wins(table, "alive")} ` +
  `THEN json_extract(j.value, '$.alive.deleted_at') ELSE ${table}.deleted_at END`
/** Every register's stamp after the change, and — the first time a row from
 * before 0025 is touched — the last `seq` the old rule projected it to. */
const stampsAfter = (table: string, entity: Entity) =>
  "stamps = json_object(" +
  registersOf(entity)
    .map(
      (name) =>
        `'${name}', NULLIF(CASE WHEN ${wins(table, name)} THEN j.s_${name} ` +
        `ELSE ${heldStamp(table, name)} END, '')`,
    )
    .join(", ") +
  `, 'legacy', CASE WHEN ${table}.stamps IS NULL THEN ${table}.seq ` +
  `ELSE json_extract(${table}.stamps, '$.legacy') END)`

/** The run's highest stamp beats every stamp the row holds: the row takes
 * that event's `at`, as the fold by stamp does. */
const updatedAt = (table: string, entity: Entity) =>
  `updated_at = CASE WHEN j.s_top > MAX(` +
  registersOf(entity)
    .map((name) => heldStamp(table, name))
    .join(", ") +
  `) THEN json_extract(j.value, '$.top.at') ELSE ${table}.updated_at END`

/** What a created row holds: each field's winner from the create on. */
const createdField = (name: string) => `json_extract(j.value, '$.created.fields.${name}.value')`
const createdStamps = (entity: Entity) =>
  "json_object(" +
  RESOLVED[entity]
    .map(
      (name) => `'${name}', ${stampOf(`json_extract(j.value, '$.created.fields.${name}.event')`)}`,
    )
    .join(", ") +
  `, 'alive', ${stampOf("json_extract(j.value, '$.created.alive.event')")})`

/**
 * The changes an UPDATE applies, as a materialised table `j` that the planner
 * drives the statement FROM, with the stamp of each register the change wins
 * (`s_<name>`) looked up once per change.
 *
 * `UPDATE t … FROM json_each(?1) AS j WHERE t.id = json_extract(j.value, …)`
 * reads as a lookup and is not one. SQLite makes the updated table the outer
 * loop, finds only `user_id = ?` to seek on, and walks every row the tenant
 * has — 1,125 rows read to change one, on a copy of production. Hinting the
 * key with an `IN` list fixes that and leaves the other half: each row found
 * then scans the whole JSON array for its values, n² reads for n changes,
 * which D1 itself flagged (`d1_expensive_query`, 92,100 rows read for 300
 * blocks). Materialised with its key as a column, `j` becomes the OUTER loop
 * and each change is one primary-key seek: n reads for n changes.
 * `event-log.test.ts` pins the plans, because nothing else would notice — the
 * slow forms return exactly the same rows.
 */
const changesAs = (entity: Entity, ...keys: string[]) =>
  "WITH j AS MATERIALIZED (SELECT c.value AS value" +
  keys.map((key) => `, json_extract(c.value, '$.${key}') AS ${key}`).join("") +
  registersOf(entity)
    .map((name) => {
      const path = name === "alive" ? "$.alive.event" : `$.set.${name}.event`
      return `, ${stampOf(`json_extract(c.value, '${path}')`)} AS s_${name}`
    })
    .join("") +
  `, ${stampOf("json_extract(c.value, '$.top.event')")} AS s_top` +
  " FROM json_each(?1) AS c) "
/**
 * Not the row this append's own INSERT just wrote. A created row already
 * holds everything its change says, and its `seq`; updating it again would
 * write the row and each of its indexes a second time for nothing. When the
 * INSERT found the row already there (a create over a tombstone: a re-linked
 * pair), the `seq` differs and the UPDATE is what lands the change.
 */
const notJustInserted = (table: string) => `${table}.seq IS NOT ${SEQ_OF_LAST_EVENT}`

/** A seq above any the log holds: what an event not yet placed derives its
 * stamp from, in its place in the append (`rank`), so a derived stamp ranks
 * after every placed one, as it will once the event is placed. */
const UNPLACED_SEQ = 10 ** 14
const unplacedStamp = (event: RuminateEvent, rank = 0) =>
  eventStamp({ ...event, seq: UNPLACED_SEQ + rank })
/** The stamp a row with no `stamps` resolves each register by: the one its
 * last event derives (`eventStamp`). */
const rowStamp = (at: number, seq: number | undefined) =>
  eventStamp({ at, seq } as unknown as RuminateEvent)

/** `heldStamp` in TypeScript: the stamp a held row has for a register. */
const heldStampOf = (
  stamps: Record<string, string> | null,
  name: string,
  row: { updated_at: number; seq?: number },
) => (stamps === null ? rowStamp(row.updated_at, row.seq) : (stamps[name] ?? ""))

/** The value a register ends a run with, and the event that set it. */
interface Winner {
  value: unknown
  event: string
  stamp: string
}
interface AliveWinner {
  alive: boolean
  /** The tombstone's stamp when it ends deleted; null when live. */
  deleted_at: number | null
  event: string
  stamp: string
}

/** The net effect of a run of events on one entity, by stamp. */
interface StampedChange {
  entity: Entity
  entity_id: string
  /** When the run creates the entity: each register's winner from the first
   * create on — the row an INSERT writes when none is held. */
  created: { fields: Record<string, Winner>; alive: AliveWinner; top: Top } | null
  /** Each field's winner over the whole run: what an UPDATE of a held row
   * compares with the stamps the row holds. */
  set: Record<string, Winner>
  alive: AliveWinner | null
  /** The event of the run with the highest stamp: the row takes its `at` as
   * `updated_at` when it is higher than every stamp the row holds. */
  top: Top
  /** The last event of the run: whose `seq` the row takes, so a pull past
   * the cursor finds every row an append touched. */
  last_event: string
}
interface Top {
  event: string
  at: number
  stamp: string
}

/**
 * Roll a run of events up to one change per entity, in first-touched order:
 * the value of each register with the highest stamp in the run. Patches are
 * absolute, so no event needs the state it was written against, and an
 * append of any size projects in a fixed number of statements. An event the
 * replica has not placed derives its stamp from its place in the run
 * (`unplacedStamp`), in the order the SQL will derive it.
 */
function stampedChanges(events: readonly RuminateEvent[]): StampedChange[] {
  const net = new Map<string, StampedChange>()
  events.forEach((event, rank) => {
    const stamp = unplacedStamp(event, rank)
    const key = `${event.entity}\x1f${event.entity_id}`
    let change = net.get(key)
    if (!change) {
      change = {
        entity: event.entity,
        entity_id: event.entity_id,
        created: null,
        set: {},
        alive: null,
        top: { event: event.id, at: event.at, stamp },
        last_event: event.id,
      }
      net.set(key, change)
    }
    change.last_event = event.id
    const top = { event: event.id, at: event.at, stamp }
    if (stamp > change.top.stamp) change.top = top
    const { deleted_at, ...patch } = event.patch as Record<string, unknown>
    // A create and a restore make it live, a delete dead; a create may arrive
    // already tombstoned (`CreatePatch`).
    const alive =
      event.action === "update"
        ? null
        : event.action === "delete"
          ? false
          : event.action === "restore" || typeof deleted_at !== "number"
    const aliveWinner: AliveWinner | null =
      alive === null
        ? null
        : {
            alive,
            deleted_at: alive ? null : typeof deleted_at === "number" ? deleted_at : event.at,
            event: event.id,
            stamp,
          }
    if (event.action === "create" && change.created === null) {
      change.created = { fields: {}, alive: aliveWinner!, top }
    }
    const created = change.created
    if (created && stamp > created.top.stamp) created.top = top
    for (const [name, value] of Object.entries(patch)) {
      if (value === undefined) continue
      const winner = { value, event: event.id, stamp }
      if (stamp > (change.set[name]?.stamp ?? "")) change.set[name] = winner
      if (created && stamp > (created.fields[name]?.stamp ?? "")) created.fields[name] = winner
    }
    if (aliveWinner) {
      if (stamp > (change.alive?.stamp ?? "")) change.alive = aliveWinner
      if (created && stamp > created.alive.stamp) created.alive = aliveWinner
    }
  })
  return [...net.values()]
}

/** A link's change, with its key split back out so the projection can seek
 * the primary key rather than compare a concatenation row by row. */
const withLinkKey = (change: StampedChange) => {
  const [source_id, destination_id, kind] = change.entity_id.split("|")
  return { ...change, source_id, destination_id, kind }
}

const changesFor = (changes: StampedChange[], entity: Entity) =>
  JSON.stringify(
    changes
      .filter((change) => change.entity === entity)
      .map((change) => (entity === "link" ? withLinkKey(change) : change)),
  )

/**
 * Plan one append: the statements that add `events` to the log and apply
 * them to the projections. Run them as ONE batch — the atomicity is the
 * design. `?1` is always the JSON; `:tenant` is bound by `TenantDb` and by
 * nothing else.
 */
export function planEventAppend(
  events: readonly RuminateEvent[],
  ctx: { actor: number; origin: EventOrigin; client: string | null; now: number; appendId: string },
  maxBytes: number = MAX_PARAM_BYTES,
): SqlStatement[] {
  const chunks = chunksBySize(events, maxBytes)
  return chunks.flatMap((chunk) => planChunk(chunk, ctx))
}

/**
 * D1 refuses a bound value over 2 MB, and a push's events travel as ONE. A
 * browser push is capped at 500 rows (`CHUNK_ROWS`, replica-sync.ts), which
 * is far under that for ordinary notes and not for 500 long code blocks — and
 * a push that fails on size fails every retry, forever. So the events are cut
 * into runs that fit, each planned on its own and all run in the one batch:
 * each run's MAX(seq) sees the runs before it, so the sequence stays
 * contiguous and the order of events is the order they were derived in.
 */
const MAX_PARAM_BYTES = 750_000

function chunksBySize(events: readonly RuminateEvent[], maxBytes: number): RuminateEvent[][] {
  const chunks: RuminateEvent[][] = []
  let size = 0
  for (const event of events) {
    const bytes = JSON.stringify(event).length
    if (chunks.length === 0 || size + bytes > maxBytes) {
      chunks.push([])
      size = 0
    }
    chunks[chunks.length - 1].push(event)
    size += bytes
  }
  return chunks
}

/** The one statement that appends old-shaped events to `events`. */
function insertEventsStatement(events: readonly RuminateEvent[], ctx: AppendContext): SqlStatement {
  return {
    sql:
      "INSERT INTO events (user_id, seq, id, entity, entity_id, action, patch, v, batch, " +
      "origin, device, client, cause, actor, base_seq, ref_seq, at, tz, hlc, received_at, " +
      "append) SELECT :tenant, " +
      "(SELECT COALESCE(MAX(seq), 0) FROM events WHERE user_id = :tenant) + j.key + 1, " +
      "json_extract(j.value, '$.id'), json_extract(j.value, '$.entity'), " +
      "json_extract(j.value, '$.entity_id'), json_extract(j.value, '$.action'), " +
      "json_extract(j.value, '$.patch'), json_extract(j.value, '$.v'), " +
      "json_extract(j.value, '$.batch'), ?5, json_extract(j.value, '$.device'), ?6, " +
      "json_extract(j.value, '$.cause'), ?4, json_extract(j.value, '$.base_seq'), " +
      "json_extract(j.value, '$.ref_seq'), json_extract(j.value, '$.at'), " +
      "json_extract(j.value, '$.tz'), json_extract(j.value, '$.hlc'), ?2, ?3 " +
      "FROM json_each(?1) AS j WHERE true " +
      "ON CONFLICT (user_id, id) DO NOTHING",
    params: [JSON.stringify(events), ctx.now, ctx.appendId, ctx.actor, ctx.origin, ctx.client],
  }
}

/** The old rollup's projection of a chunk of old-shaped events (the
 * `events` insert comes first, from `insertEventsStatement`). */
function planChunk(
  events: readonly RuminateEvent[],
  ctx: { actor: number; origin: EventOrigin; client: string | null; now: number; appendId: string },
): SqlStatement[] {
  const changes = stampedChanges(events)
  const params = (json: string): SqlValue[] => [json, ctx.appendId]
  const fields = (table: string, entity: Entity) =>
    RESOLVED[entity].map((name) => field(table, name)).join(", ")
  const created = "json_type(j.value, '$.created') = 'object'"

  return [
    insertEventsStatement(events, ctx),

    // Blocks → nodes
    {
      sql:
        "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at, notes_id, " +
        "seq, stamps) SELECT :tenant, json_extract(j.value, '$.entity_id'), " +
        `${createdField("type")}, ${createdField("text")}, ${createdField("props")}, ` +
        "json_extract(j.value, '$.created.top.at'), " +
        "json_extract(j.value, '$.created.alive.deleted_at'), " +
        `${createdField("notes_id")}, ${SEQ_OF_LAST_EVENT}, ${createdStamps("block")} ` +
        "FROM json_each(?1) AS j " +
        `WHERE ${created} AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, id) DO NOTHING",
      params: params(changesFor(changes, "block")),
    },
    {
      sql:
        changesAs("block", "entity_id") +
        `UPDATE nodes SET ${fields("nodes", "block")}, ${tombstone("nodes")}, ` +
        `${stampsAfter("nodes", "block")}, ${updatedAt("nodes", "block")}, ` +
        `seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM j WHERE nodes.user_id = :tenant AND nodes.id = j.entity_id " +
        `AND ${INSERTED_BY_THIS_APPEND} AND ${notJustInserted("nodes")} ` +
        "/* includes-deleted: an event may edit or restore a tombstoned block */",
      params: params(changesFor(changes, "block")),
    },

    // Links → link
    {
      sql:
        "INSERT INTO link (user_id, source_id, destination_id, kind, sort_key, updated_at, " +
        "deleted_at, seq, stamps) SELECT :tenant, json_extract(j.value, '$.source_id'), " +
        "json_extract(j.value, '$.destination_id'), json_extract(j.value, '$.kind'), " +
        `${createdField("sort_key")}, json_extract(j.value, '$.created.top.at'), ` +
        "json_extract(j.value, '$.created.alive.deleted_at'), " +
        `${SEQ_OF_LAST_EVENT}, ${createdStamps("link")} FROM json_each(?1) AS j ` +
        `WHERE ${created} AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, source_id, destination_id, kind) DO NOTHING",
      params: params(changesFor(changes, "link")),
    },
    {
      sql:
        changesAs("link", "source_id", "destination_id", "kind") +
        `UPDATE link SET ${fields("link", "link")}, ${tombstone("link")}, ` +
        `${stampsAfter("link", "link")}, ${updatedAt("link", "link")}, ` +
        `seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM j WHERE link.user_id = :tenant AND link.source_id = j.source_id " +
        "AND link.destination_id = j.destination_id AND link.kind = j.kind " +
        `AND ${INSERTED_BY_THIS_APPEND} AND ${notJustInserted("link")} ` +
        "/* includes-deleted: re-linking a pair revives its tombstoned row */",
      params: params(changesFor(changes, "link")),
    },

    // Views → views
    {
      sql:
        "INSERT INTO views (user_id, id, root_id, filter, sort, pinned, sort_key, stack, " +
        "updated_at, deleted_at, seq, stamps) SELECT :tenant, " +
        "json_extract(j.value, '$.entity_id'), " +
        `${createdField("root_id")}, ${createdField("filter")}, ${createdField("sort")}, ` +
        `COALESCE(${createdField("pinned")}, 0), ${createdField("sort_key")}, ` +
        `${createdField("stack")}, ` +
        "json_extract(j.value, '$.created.top.at'), " +
        "json_extract(j.value, '$.created.alive.deleted_at'), " +
        `${SEQ_OF_LAST_EVENT}, ${createdStamps("view")} FROM json_each(?1) AS j ` +
        `WHERE ${created} AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, id) DO NOTHING",
      params: params(changesFor(changes, "view")),
    },
    {
      sql:
        changesAs("view", "entity_id") +
        `UPDATE views SET ${fields("views", "view")}, ${tombstone("views")}, ` +
        `${stampsAfter("views", "view")}, ${updatedAt("views", "view")}, ` +
        `seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM j WHERE views.user_id = :tenant AND views.id = j.entity_id " +
        `AND ${INSERTED_BY_THIS_APPEND} AND ${notJustInserted("views")}`,
      params: params(changesFor(changes, "view")),
    },
  ]
}

/** Append events a caller already holds (a restore, a client's push).
 * Reconciles first, like every write; `extra` rides in the same transaction. */
export async function appendEvents(
  tenant: TenantDb,
  events: readonly RuminateEvent[],
  ctx: WriteContext,
  extra: SqlStatement[] = [],
  current?: HeldRows,
): Promise<void> {
  const held = current ?? (await readCurrent(tenant, writeNaming(events)))
  const keys = expandAgainst(events, held)
  // An event that reads as no change per key (a props patch that only
  // reorders keys) is still an event the writer sent: it is recorded in the
  // old log, with no key rows, so its push is answered.
  const mirrored = new Set(keys.map((key) => key.event))
  const eventless = events.filter((event) => !mirrored.has(event.id))
  await appendKeyEvents(tenant, keys, ctx, extra, held, eventless)
}

/** The rows a run of old-shaped events names, as a `RowWrite` for `readCurrent`. */
function writeNaming(events: readonly { entity: Entity; entity_id: string }[]): RowWrite {
  const nodeIds = new Set<string>()
  const linkKeys = new Set<string>()
  const viewIds = new Set<string>()
  for (const event of events) {
    if (event.entity === "block") nodeIds.add(event.entity_id)
    else if (event.entity === "link") linkKeys.add(event.entity_id)
    else viewIds.add(event.entity_id)
  }
  return {
    nodes: [],
    links: [],
    deleteNodes: [...nodeIds],
    deleteLinks: [...linkKeys].map((key) => key.split("|") as [string, string, string]),
    views: [...viewIds].map((id) => ({ id }) as ViewRow),
  }
}

/** A held row's live props as a map, or null. */
const propsMapOfRow = (row: NodeRow | undefined): Record<string, unknown> | null =>
  row === undefined ? null : parseProps(row.props)

/**
 * The per-key reading of old-shaped events against the rows the replica
 * holds (`expandEvent`): each block's props before an event are the held
 * row's, then what the events before it in the run left. The rows carry
 * the old event's stamp, so they resolve exactly as it would have.
 */
function expandAgainst(events: readonly RuminateEvent[], held: HeldRows): KeyEvent[] {
  const prior = new Map<string, Record<string, unknown> | null>()
  const out: KeyEvent[] = []
  for (const event of events) {
    const before = prior.has(event.entity_id)
      ? prior.get(event.entity_id)!
      : propsMapOfRow(held.nodes.get(event.entity_id))
    out.push(...expandEvent(event, before))
    if (event.entity === "block") {
      const props = (event.patch as { props?: string | null }).props
      if (props !== undefined) prior.set(event.entity_id, parseProps(props))
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// The other door: events in, as the client made them
// -----------------------------------------------------------------------------

/**
 * Which of a client's events a push of them lands, by stamp: an event that
 * would set no register — every field it names, and its liveness for a
 * create, delete or restore, already holds a stamp at least as high — is
 * stale, and is dropped: a device that was offline for a week pushing over a
 * week of edits made elsewhere. The projection would ignore it anyway; this
 * keeps it out of the log as well. An entity the replica does not hold is
 * never stale. An event with no stamp of its own derives one after every
 * placed event (`unplacedStamp`), so for it this is the old rule: older than
 * the row's `updated_at` is stale.
 */
function staleEvents(current: HeldRows, events: readonly RuminateEvent[]): Set<RuminateEvent> {
  const stale = new Set<RuminateEvent>()
  for (const event of events) {
    const row =
      event.entity === "block"
        ? current.nodes.get(event.entity_id)
        : event.entity === "link"
          ? current.links.get(event.entity_id)
          : current.views.get(event.entity_id)
    if (row === undefined) continue
    const stamps = current.stamps.get(`${event.entity}\x1f${event.entity_id}`) ?? null
    const held = (name: string) => heldStampOf(stamps, name, row)
    const patch = event.patch as Record<string, unknown>
    const named = RESOLVED[event.entity].filter((name) => patch[name] !== undefined)
    if (event.action !== "update") named.push("alive")
    const stamp = unplacedStamp(event)
    if (named.every((name) => stamp <= held(name))) stale.add(event)
  }
  return stale
}

/**
 * Land a push of EVENTS — the door a client of this build uses (`opsToEvents`
 * on its side; docs/event-sourcing.md). The events are the writer's own
 * account of what it did, so they carry a `cause`, a `base_seq` and the
 * writer's clock, zone and stamp; the replica records who, through which door,
 * and when it arrived. Stale events are dropped (`staleEvents`); the rest are
 * appended and projected in one batch, reconcile first, and the push is
 * idempotent: an event already in the log (by `id`) is not appended again and
 * projects nothing, so a retry after a lost response is harmless.
 *
 * Returns each pushed event's `seq` so the client can stamp its own copy.
 */
export async function appendClientEvents(
  tenant: TenantDb,
  events: readonly RuminateEvent[],
  ctx: WriteContext,
  extra: SqlStatement[] = [],
): Promise<{ appended: number; stale: number; seqs: [string, number][] }> {
  const current = await readCurrent(tenant, writeNaming(events))
  // An event the log already holds (a retry after a lost answer) is neither
  // stale nor new, whatever has happened to its row since: it is answered
  // with the seq it has.
  const held = await heldSeqs(tenant, "events", events)
  const unknown = events.filter((event) => !held.has(event.id))
  const stale = staleEvents(current, unknown)
  const fresh = unknown.filter((event) => !stale.has(event))
  await appendEvents(tenant, fresh, ctx, extra, current)
  const after = await heldSeqs(tenant, "events", events)
  return { appended: fresh.length, stale: stale.size, seqs: [...after.entries()] }
}

/** The `seq` the log holds each of these events at, by id — absent when not
 * (yet) appended. One primary-key seek per id, driven from the JSON. */
async function heldSeqs(
  tenant: TenantDb,
  table: "events" | "events_log",
  events: readonly { id: string }[],
): Promise<Map<string, number>> {
  if (events.length === 0) return new Map()
  const rows = await tenant.exec(
    `SELECT e.id, e.seq FROM json_each(?1) AS j JOIN ${table} e ` +
      "ON e.user_id = :tenant AND e.id = j.value",
    [JSON.stringify(events.map((event) => event.id))],
  )
  return new Map(rows.map((row) => [String(row.id), Number(row.seq)]))
}

// -----------------------------------------------------------------------------
// The one door: rows in, events appended
// -----------------------------------------------------------------------------

/** The rows a write names, as the replica holds them, with each row's stamps
 * (`stamps`, by `<entity>\x1f<id>`; null on a row from before 0025). */
interface HeldRows extends CurrentRows {
  stamps: Map<string, Record<string, string> | null>
  /** The stamp `block_values` holds for each (block, key) the write names,
   * by `<block id>\x1f<key>`: what a per-key event is stale against. */
  keyStamps: Map<string, string>
}

const parseStamps = (value: SqlValue | undefined): Record<string, string> | null =>
  typeof value === "string" ? (JSON.parse(value) as Record<string, string>) : null

/** The rows a write names, as the replica holds them now — three primary-key
 * lookups driven from the JSON, however large the corpus. */
async function readCurrent(tenant: TenantDb, write: RowWrite): Promise<HeldRows> {
  const all = tenant.includingDeleted()
  const nodeIds = [
    ...new Set([...write.nodes.map((node) => node.id), ...(write.deleteNodes ?? [])]),
  ]
  const linkKeys = [
    ...write.links.map((link) => [link.source_id, link.destination_id, link.kind]),
    ...(write.deleteLinks ?? []).map((key) => [...key]),
  ]
  const viewIds = (write.views ?? []).map((view) => view.id)

  const stamps = new Map<string, Record<string, string> | null>()
  const keyStamps = new Map<string, string>()
  const nodes = new Map<string, NodeRow>()
  if (nodeIds.length > 0) {
    const rows = await all.exec(
      "SELECT n.id, n.type, n.text, n.props, n.updated_at, n.deleted_at, n.notes_id, n.seq, " +
        "n.stamps " +
        "FROM json_each(?1) AS j JOIN nodes n ON n.user_id = :tenant AND n.id = j.value " +
        "/* includes-deleted: a write is diffed against the row as it stands, tombstone or not */",
      [JSON.stringify(nodeIds)],
    )
    for (const raw of rows) {
      const row = toNodeRow(raw)
      nodes.set(row.id, row)
      stamps.set(`block\x1f${row.id}`, parseStamps(raw.stamps))
    }
    const keyRows = await all.exec(
      "SELECT b.block_id, b.key, b.hlc FROM json_each(?1) AS j " +
        "JOIN block_values b ON b.user_id = :tenant AND b.block_id = j.value",
      [JSON.stringify(nodeIds)],
    )
    for (const raw of keyRows) {
      keyStamps.set(`${String(raw.block_id)}\x1f${String(raw.key)}`, String(raw.hlc))
    }
  }
  const links = new Map<string, LinkRow>()
  if (linkKeys.length > 0) {
    const rows = await all.exec(
      "SELECT l.source_id, l.destination_id, l.kind, l.sort_key, l.updated_at, l.deleted_at, " +
        "l.seq, l.stamps FROM json_each(?1) AS j JOIN link l ON l.user_id = :tenant " +
        "AND l.source_id = json_extract(j.value, '$[0]') " +
        "AND l.destination_id = json_extract(j.value, '$[1]') " +
        "AND l.kind = json_extract(j.value, '$[2]') " +
        "/* includes-deleted: a write is diffed against the row as it stands, tombstone or not */",
      [JSON.stringify(linkKeys)],
    )
    for (const raw of rows) {
      const row = toLinkRow(raw)
      const key = linkEntityId(row.source_id, row.destination_id, row.kind)
      links.set(key, row)
      stamps.set(`link\x1f${key}`, parseStamps(raw.stamps))
    }
  }
  const views = new Map<string, ViewRow>()
  if (viewIds.length > 0) {
    const rows = await all.exec(
      "SELECT v.id, v.root_id, v.filter, v.sort, v.pinned, v.sort_key, v.stack, " +
        "v.updated_at, v.deleted_at, v.seq, v.stamps " +
        "FROM json_each(?1) AS j JOIN views v ON v.user_id = :tenant AND v.id = j.value",
      [JSON.stringify(viewIds)],
    )
    for (const raw of rows) {
      const row = toViewRow(raw)
      views.set(row.id, row)
      stamps.set(`view\x1f${row.id}`, parseStamps(raw.stamps))
    }
  }
  return { nodes, links, views, stamps, keyStamps }
}

/**
 * Stamps for the events the replica derives itself (docs/event-only-sync.md,
 * The server): its own clock, a counter for the place in the append, and
 * `server:<origin>` as the device. Each call gives the next. Like any clock
 * of the kind, it first moves up to `seen`, the highest stamp the write read:
 * so a write lands over what it was derived against, even inside the ms of
 * the write before it, or when a writer's clock ran ahead of the replica's.
 */
function serverStamps(now: number, origin: EventOrigin, seen: string | null): () => string {
  let last: Hlc | null = seen === null ? null : decodeHlc(seen)
  return () => encodeHlc((last = tickHlc(last, now, `server:${origin}`)))
}

/** The highest stamp any register of these rows holds. */
function highestHeld(current: HeldRows): string | null {
  let highest: string | null = null
  const see = (key: string, row: { updated_at: number; seq?: number }, entity: Entity) => {
    const stamps = current.stamps.get(key) ?? null
    for (const name of registersOf(entity)) {
      const stamp = heldStampOf(stamps, name, row)
      if (stamp !== "" && (highest === null || stamp > highest)) highest = stamp
    }
  }
  for (const [id, row] of current.nodes) see(`block\x1f${id}`, row, "block")
  for (const [key, row] of current.links) see(`link\x1f${key}`, row, "link")
  for (const [id, row] of current.views) see(`view\x1f${id}`, row, "view")
  return highest
}

/**
 * Land a write of rows: derive its events, append them, project them — one
 * atomic batch, reconcile first. `extra` rides in the same transaction (the
 * browser's `replica_cursor` stamp).
 *
 * The derived events carry a server stamp (`serverStamps`): a row says when
 * it was written, not what its writer had seen, so the replica's clock is
 * the best account there is.
 *
 * The rows are read BEFORE the batch, outside its transaction — D1 has no
 * interactive transactions. Two writers racing on one row therefore both
 * derive against the same held row, and the higher stamp wins each field,
 * where the row planner would have let the later `updated_at` win. The fold
 * and the tables agree either way; only which of two same-instant writes
 * survives differs, and only inside that window.
 */
export async function writeRows(
  tenant: TenantDb,
  write: RowWrite,
  ctx: WriteContext,
  extra: SqlStatement[] = [],
): Promise<{ events: number }> {
  const append = appendContext(ctx)
  const current = await readCurrent(tenant, write)
  const stamp = serverStamps(append.now, append.origin, highestHeld(current))
  const events = rowsToEvents(current, write, {
    batch: append.appendId,
    device: ctx.device ?? "unknown",
    cause: ctx.cause,
    now: append.now,
  }).map((event) => ({ ...event, hlc: stamp() }))
  await appendKeyEvents(
    tenant,
    expandAgainst(events, current),
    { ...ctx, ...append },
    extra,
    current,
  )
  return { events: events.length }
}

// -----------------------------------------------------------------------------
// Reading the log
// -----------------------------------------------------------------------------

const EVENT_COLUMNS =
  "id, seq, entity, entity_id, action, patch, v, batch, origin, device, client, cause, actor, " +
  "base_seq, ref_seq, at, tz, hlc, received_at"

/** An event as the log holds it: the envelope plus what the replica stamped. */
export type StoredEvent = RuminateEvent & {
  seq: number
  origin: EventOrigin
  client: string | null
  actor: number
  received_at: number
}

const toEvent = (row: Record<string, SqlValue>): StoredEvent =>
  ({
    id: row.id,
    seq: Number(row.seq),
    entity: row.entity,
    entity_id: row.entity_id,
    action: row.action,
    patch: JSON.parse(String(row.patch)),
    v: Number(row.v),
    batch: row.batch,
    origin: row.origin,
    device: row.device,
    client: row.client,
    ...(row.cause === null ? {} : { cause: row.cause }),
    actor: Number(row.actor),
    base_seq: row.base_seq === null ? null : Number(row.base_seq),
    ref_seq: row.ref_seq === null ? null : Number(row.ref_seq),
    at: Number(row.at),
    tz: row.tz === null ? null : Number(row.tz),
    // Null on an event written before stamps (0024): served without one, and
    // the reader derives it (`eventStamp`).
    ...(row.hlc === null ? {} : { hlc: String(row.hlc) }),
    received_at: Number(row.received_at),
  }) as StoredEvent

/** The log after `since`, oldest first, optionally one entity's — its history. */
export async function readEvents(
  tenant: TenantDb,
  options: {
    since?: number
    upTo?: number
    limit?: number
    entity?: string
    entityId?: string
  } = {},
): Promise<StoredEvent[]> {
  const { since = 0, upTo = Number.MAX_SAFE_INTEGER, limit = 1000, entity, entityId } = options
  const rows =
    entity !== undefined && entityId !== undefined
      ? await tenant.exec(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE user_id = :tenant AND entity = ?1 ` +
            "AND entity_id = ?2 AND seq > ?3 AND seq <= ?4 ORDER BY seq LIMIT ?5",
          [entity, entityId, since, upTo, limit],
        )
      : await tenant.exec(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE user_id = :tenant AND seq > ?1 ` +
            "AND seq <= ?2 ORDER BY seq LIMIT ?3",
          [since, upTo, limit],
        )
  return rows.map(toEvent)
}

/** How many events one read asks for while walking a whole log. */
const PAGE = 5000

/** The whole log up to `upTo`, paged — what a fold needs. */
async function readLog(tenant: TenantDb, upTo = Number.MAX_SAFE_INTEGER): Promise<StoredEvent[]> {
  const log: StoredEvent[] = []
  for (;;) {
    const page = await readEvents(tenant, { since: log.at(-1)?.seq ?? 0, upTo, limit: PAGE })
    log.push(...page)
    if (page.length < PAGE) return log
  }
}

interface LogBounds {
  /** The first moment that CAN be served — the end of the tenant's snapshot.
   * Rows that existed before it appear as they stood then; their earlier
   * history was never recorded. Null while the log is empty. */
  earliest: { seq: number; received_at: number } | null
  latest: number
}

async function logBounds(tenant: TenantDb): Promise<LogBounds> {
  const [row] = await tenant.exec(
    "SELECT MIN(received_at) AS received_at, MAX(seq) AS latest, " +
      "(SELECT MAX(seq) FROM events WHERE user_id = :tenant AND received_at = " +
      "(SELECT MIN(received_at) FROM events WHERE user_id = :tenant)) AS seq " +
      "FROM events WHERE user_id = :tenant",
  )
  if (!row || row.latest === null) return { earliest: null, latest: 0 }
  return {
    earliest: { seq: Number(row.seq), received_at: Number(row.received_at) },
    latest: Number(row.latest),
  }
}

export interface CorpusAt extends LogBounds {
  /** The moment served: every event up to and including this `seq`. */
  seq: number
  nodes: NodeRow[]
  links: LinkRow[]
  views: ViewRow[]
}

/**
 * The corpus as it stood at a moment — by `seq`, or by a time, which is
 * answered as the last event the replica had RECEIVED by then (its own clock;
 * a writer's is never trusted to order anything).
 *
 * A moment before the log begins is answered as the beginning: the snapshot
 * is the earliest state there is, and `earliest` tells the caller so.
 */
export async function corpusAt(
  tenant: TenantDb,
  moment: { seq: number } | { at: number },
): Promise<CorpusAt> {
  await reconcileLog(tenant)
  const bounds = await logBounds(tenant)
  let seq: number
  if ("seq" in moment) {
    seq = moment.seq
  } else {
    const [row] = await tenant.exec(
      "SELECT MAX(seq) AS seq FROM events WHERE user_id = :tenant AND received_at <= ?1",
      [moment.at],
    )
    seq = row === undefined || row.seq === null ? 0 : Number(row.seq)
  }
  seq = Math.min(Math.max(seq, bounds.earliest?.seq ?? 0), bounds.latest)
  const state =
    rollup === "new"
      ? assembleLogState(keyStateAt(await readKeyLog(tenant, seq), seq))
      : fold(await readLog(tenant, seq))
  return { seq, ...projectRows(state), ...bounds }
}

/**
 * Return a block, what it held and where it sat to the state of `seq`, by
 * appending `restore` events. Returns how many it took (0 = already there).
 */
export async function restoreSubtree(
  tenant: TenantDb,
  blockId: string,
  seq: number,
  ctx: WriteContext,
): Promise<{ events: number }> {
  await reconcileLog(tenant)
  const append = appendContext(ctx)
  let n = 0
  const log = await readLog(tenant)
  const seen = log.reduce<string | null>((highest, event) => {
    const stamp = eventStamp(event)
    return highest === null || stamp > highest ? stamp : highest
  }, null)
  const events = planRestoreSubtree(log, blockId, seq, {
    batch: append.appendId,
    device: ctx.device ?? "unknown",
    cause: ctx.cause ?? "restore",
    at: append.now,
    mintId: () => `${append.appendId}:${(n += 1)}`,
    stamp: serverStamps(append.now, append.origin, seen),
  })
  if (events.length > 0) await appendEvents(tenant, events, { ...ctx, ...append })
  return { events: events.length }
}

// -----------------------------------------------------------------------------
// Verify
// -----------------------------------------------------------------------------

export interface LogVerdict {
  ok: boolean
  /** Which log the rollup read, and the tables were checked against. */
  rollup: Rollup
  events: number
  keyEvents: number
  rows: { nodes: number; links: number; views: number; blockValues: number }
  /** Rows the fold of the log in force and the tables disagree about, by
   * table. A healthy log has none. */
  drift: { nodes: string[]; links: string[]; views: string[] }
  /** `block_values` against the per-key fold: the (block, key) pairs that
   * differ, as `<block id> <key>`. */
  blockValues: string[]
  /**
   * The two logs against each other, each folded by seq: the entities whose
   * rows differ. By design the per-key log can keep a key the old log's
   * whole-props patch would have lost; such an entity is listed here and
   * does not fail `ok`.
   */
  logs: string[]
  rejected: number
}

/** One entity as the projection holds it: a row, and its stamps (null while
 * the old rule still projects it). */
interface Projection {
  fields: Record<string, unknown>
  deleted: boolean
  deleted_at: number | null
  seq: number
  at: number
  stamps: Record<string, string> | null
}

/**
 * The tables the log projects to, by the rules `planEventAppend` keeps — the
 * fold the projection is checked against. In `seq` order, each event:
 *
 * - on an entity the projection does not hold, and not a create, is rejected
 *   (an UPDATE finds no row);
 * - up to the seq the row was projected to by the old rule (`legacyOf`: its
 *   `legacy` stamp, or its own `seq` when it holds no stamps) applies by that
 *   rule, as `fold` does;
 * - after it sets each register only under a higher stamp. A row from before
 *   0025 starts from the stamp its last event derives, for every register.
 *
 * Either way the row takes the event's `seq`. It takes the event's `at` by
 * the old rule, or when the stamp beats every stamp the row holds.
 */
function projectLog(
  log: readonly StoredEvent[],
  legacyOf: (entity: Entity, id: string) => number,
): { tables: Record<Entity, Map<string, Projection>>; rejected: number } {
  const tables: Record<Entity, Map<string, Projection>> = {
    block: new Map(),
    link: new Map(),
    view: new Map(),
  }
  let rejected = 0
  for (const event of [...log].sort((a, b) => a.seq - b.seq)) {
    const table = tables[event.entity]
    const held = table.get(event.entity_id)
    if (held === undefined && event.action !== "create") {
      rejected += 1
      continue
    }
    const row = held ?? {
      fields: {},
      deleted: false,
      deleted_at: null,
      seq: 0,
      at: 0,
      stamps: event.seq <= legacyOf(event.entity, event.entity_id) ? null : {},
    }
    const { deleted_at, ...patch } = event.patch as Record<string, unknown>
    const tombstone = typeof deleted_at === "number" ? deleted_at : null
    const alive =
      event.action === "update"
        ? null
        : event.action === "delete"
          ? false
          : event.action === "restore" || tombstone === null
    const deletedAt = alive ? null : (tombstone ?? event.at)

    if (event.seq <= legacyOf(event.entity, event.entity_id)) {
      row.at = event.at
      Object.assign(row.fields, patch)
      if (alive !== null) {
        row.deleted = !alive
        row.deleted_at = deletedAt
      }
    } else {
      const stamps =
        row.stamps ??
        Object.fromEntries(
          registersOf(event.entity).map((name) => [name, rowStamp(row.at, row.seq)]),
        )
      const stamp = eventStamp(event)
      const top = Object.values(stamps).reduce((a, b) => (b > a ? b : a), "")
      for (const [name, value] of Object.entries(patch)) {
        if (value === undefined) continue
        if (!RESOLVED[event.entity].includes(name)) {
          // A link's key: set by its create, never changed.
          if (!(name in row.fields)) row.fields[name] = value
        } else if (stamp > (stamps[name] ?? "")) {
          row.fields[name] = value
          stamps[name] = stamp
        }
      }
      if (alive !== null && stamp > (stamps.alive ?? "")) {
        row.deleted = !alive
        row.deleted_at = deletedAt
        stamps.alive = stamp
      }
      if (stamp > top) row.at = event.at
      row.stamps = stamps
    }
    row.seq = event.seq
    table.set(event.entity_id, row)
  }
  return { tables, rejected }
}

/** A row's stamps as compared: every register's stamp, keys in order. */
const canonStamps = (stamps: Record<string, string> | null) =>
  stamps === null
    ? null
    : Object.entries(stamps)
        .filter(([name, stamp]) => name !== "legacy" && stamp !== null)
        .sort(([a], [b]) => (a < b ? -1 : 1))

/**
 * Does folding the log still yield the tables — every field, every stamp?
 * Drift is this architecture's failure mode — a row written around the log,
 * a projection statement that disagrees with the fold — and it is silent, so
 * it is checked rather than assumed. Reads both logs and the whole corpus:
 * a diagnostic, never something a request does on its way past.
 *
 * Three checks (docs/event-sourcing.md, "Per-key events"): the tables
 * against the fold of the log the rollup reads (`drift`, which decides
 * `ok`); `block_values` against the per-key fold (`blockValues`, also in
 * `ok`); and the two logs against each other, by seq (`logs`, reported
 * only). A block's `props` is compared as a value, not as a string: the two
 * folds spell the same keys in different orders. Under the new rollup the
 * `props` stamp is not compared — a row from the old rollup holds the
 * stamp of its last whole-props event, where the key rows hold their own.
 */
export async function verifyLog(tenant: TenantDb): Promise<LogVerdict> {
  await reconcileLog(tenant)
  const seedCtx = appendContext({ actor: tenant.userId, origin: "system" })
  await seedBlockValues(tenant, seedCtx)
  const all = tenant.includingDeleted()
  const log = await readLog(tenant)
  const keyLog = await readKeyLog(tenant)
  const legacy = await legacyReader(tenant)
  const { nodes, links, views } = legacy.rows
  const { stamps } = legacy
  const linkKey = (row: LinkRow) => linkEntityId(row.source_id, row.destination_id, row.kind)
  const valueRows = await all.exec(
    "SELECT block_id, key, value, hlc FROM block_values WHERE user_id = :tenant",
  )

  const byKeys = projectKeyLog(keyLog, legacy.of)
  const bySeq = projectLog(log, legacy.of)
  const active = rollup === "new" ? assembleProjection(byKeys.tables) : bySeq.tables
  const folded = projectRows({
    blocks: active.block,
    links: active.link,
    views: active.view,
  } as unknown as Parameters<typeof projectRows>[0])

  const skipProps = rollup === "new"
  const canon = (row: object, held: Record<string, string> | null | undefined) =>
    JSON.stringify([
      Object.entries(row)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) =>
          key === "props" ? [key, canonicalJson(parseProps(String(value)) ?? {})] : [key, value],
        )
        .sort(([a], [b]) => (a < b ? -1 : 1)),
      canonStamps(held ?? null)?.filter(([name]) => !(skipProps && name === "props")) ?? null,
    ])
  const compare = <T extends object>(
    entity: Entity,
    held: T[],
    want: T[],
    keyOf: (row: T) => string,
  ) => {
    const wanted = new Map(
      want.map((row) => [keyOf(row), canon(row, active[entity].get(keyOf(row))?.stamps)]),
    )
    const drift: string[] = []
    for (const row of held) {
      const key = keyOf(row)
      if (wanted.get(key) !== canon(row, stamps.get(`${entity}\x1f${key}`))) drift.push(key)
      wanted.delete(key)
    }
    return [...drift, ...wanted.keys()]
  }
  const drift = {
    nodes: compare("block", nodes, folded.nodes, (row) => row.id),
    links: compare("link", links, folded.links, linkKey),
    views: compare("view", views, folded.views, (row) => row.id),
  }

  // block_values against the per-key fold: every created block's keys.
  const wantedValues = new Map<string, string>()
  for (const [id, block] of byKeys.tables.block) {
    for (const [register, stamp] of Object.entries(block.stamps ?? {})) {
      if (!isPropsRegister(register)) continue
      const value = block.fields[register]
      wantedValues.set(
        `${id} ${propNameOf(register)}`,
        `${value === null || value === undefined ? "" : canonicalJson(value)}@${stamp}`,
      )
    }
  }
  const blockValues: string[] = []
  for (const raw of valueRows) {
    const key = `${String(raw.block_id)} ${String(raw.key)}`
    const value = raw.value === null ? "" : canonicalJson(JSON.parse(String(raw.value)))
    if (wantedValues.get(key) !== `${value}@${String(raw.hlc)}`) blockValues.push(key)
    wantedValues.delete(key)
  }
  blockValues.push(...wantedValues.keys())

  // The two logs against each other, by seq.
  const oldRows = projectRows(fold(log))
  const keyRows = projectRows(assembleLogState(foldKeys(keyLog)))
  const logs: string[] = []
  const rowCanon = (row: object) =>
    JSON.stringify(
      Object.entries(row)
        .filter(([key, value]) => value !== undefined && value !== null && key !== "updated_at")
        .map(([key, value]) =>
          key === "props" ? [key, canonicalJson(parseProps(String(value)) ?? {})] : [key, value],
        )
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    )
  const compareLogs = <T extends object>(
    name: Entity,
    a: T[],
    b: T[],
    keyOf: (row: T) => string,
  ) => {
    const other = new Map(b.map((row) => [keyOf(row), rowCanon(row)]))
    for (const row of a) {
      const key = keyOf(row)
      if (other.get(key) !== rowCanon(row)) logs.push(`${name} ${key}`)
      other.delete(key)
    }
    for (const key of other.keys()) logs.push(`${name} ${key}`)
  }
  compareLogs("block", oldRows.nodes, keyRows.nodes, (row) => row.id)
  compareLogs("link", oldRows.links, keyRows.links, linkKey)
  compareLogs("view", oldRows.views, keyRows.views, (row) => row.id)

  return {
    ok:
      drift.nodes.length + drift.links.length + drift.views.length === 0 &&
      blockValues.length === 0,
    rollup,
    events: log.length,
    keyEvents: keyLog.length,
    rows: {
      nodes: nodes.length,
      links: links.length,
      views: views.length,
      blockValues: valueRows.length,
    },
    drift,
    blockValues,
    logs,
    rejected: rollup === "new" ? byKeys.rejected : bySeq.rejected,
  }
}

// -----------------------------------------------------------------------------
// The per-key log (docs/event-sourcing.md, "Per-key events"; migrations/0028)
// -----------------------------------------------------------------------------

/** The GLOB pair that is `KEY_PATTERN` (src/data/key-events.ts) in SQL. */
const KEY_GLOB = "GLOB '[A-Za-z_]*' AND {k} NOT GLOB '*[^A-Za-z0-9_.:-]*' AND length({k}) <= 128"
const keyGlob = (k: string) => `${k} ${KEY_GLOB.replaceAll("{k}", k)}`

/**
 * The fill: every `events` row of the tenant that `events_log` does not
 * mirror yet, read per key — the migration's backfill, scoped to one tenant
 * and run in every write's batch after the reconcile, so a snapshot and a
 * straggler the old Worker appended during a rollout are both read per key
 * before anything projects. `expandEvent` is the same reading in TypeScript;
 * `event-log.test.ts` pins the two together. Then `block_values` takes the
 * filled props keys by stamp, so a block's keys are current whichever door
 * its events came through.
 */
export function planLogFill(ctx: { now: number; appendId: string }): SqlStatement[] {
  return [
    {
      sql:
        "INSERT INTO events_log (user_id, seq, id, entity, entity_id, action, key, value, v, " +
        "batch, origin, device, client, cause, actor, base_seq, ref_seq, at, tz, hlc, " +
        "received_at, append, event_id, event_seq) " +
        "WITH pending AS (SELECT e.*, " +
        "CASE WHEN e.entity = 'block' AND json_type(e.patch, '$.props') = 'text' " +
        "AND json_valid(json_extract(e.patch, '$.props')) " +
        "THEN json_extract(e.patch, '$.props') END AS props_new, " +
        "CASE WHEN e.entity = 'block' AND json_type(e.patch, '$.props') IS NOT NULL " +
        "THEN 1 ELSE 0 END AS names_props, " +
        "(SELECT CASE WHEN json_type(p.patch, '$.props') = 'text' " +
        "AND json_valid(json_extract(p.patch, '$.props')) " +
        "THEN json_extract(p.patch, '$.props') END FROM events p " +
        "WHERE p.user_id = :tenant AND p.entity = 'block' AND p.entity_id = e.entity_id " +
        "AND p.seq < e.seq AND json_type(p.patch, '$.props') IS NOT NULL " +
        "ORDER BY p.seq DESC LIMIT 1) AS props_prior " +
        "FROM events e WHERE e.user_id = :tenant AND NOT EXISTS " +
        "(SELECT 1 FROM events_log l WHERE l.user_id = :tenant AND l.event_id = e.id)), " +
        "columns AS (SELECT 'block' AS entity, 'type' AS name, 1 AS ordinal " +
        "UNION ALL SELECT 'block', 'text', 2 UNION ALL SELECT 'block', 'notes_id', 3 " +
        "UNION ALL SELECT 'link', 'source_id', 1 UNION ALL SELECT 'link', 'destination_id', 2 " +
        "UNION ALL SELECT 'link', 'kind', 3 UNION ALL SELECT 'link', 'sort_key', 4 " +
        "UNION ALL SELECT 'view', 'root_id', 1 UNION ALL SELECT 'view', 'filter', 2 " +
        "UNION ALL SELECT 'view', 'sort', 3 UNION ALL SELECT 'view', 'pinned', 4 " +
        "UNION ALL SELECT 'view', 'sort_key', 5 UNION ALL SELECT 'view', 'stack', 6), " +
        "expanded AS (" +
        "SELECT p.*, 0 AS ordinal, p.action AS k_action, '' AS k, " +
        "CASE WHEN json_type(p.patch, '$.deleted_at') = 'integer' " +
        "THEN json_extract(p.patch, '$.deleted_at') ELSE 'null' END AS val " +
        "FROM pending p WHERE p.action <> 'update' " +
        "UNION ALL SELECT p.*, c.ordinal, 'set', c.name, p.patch -> ('$.' || c.name) " +
        "FROM pending p JOIN columns c ON c.entity = p.entity " +
        "WHERE json_type(p.patch, '$.' || c.name) IS NOT NULL " +
        "UNION ALL SELECT p.*, 10, 'set', 'props.' || n.key, p.props_new -> n.fullkey " +
        "FROM pending p, json_each(p.props_new) AS n " +
        `WHERE p.names_props AND n.type <> 'null' AND ${keyGlob("n.key")} ` +
        "AND (p.props_prior IS NULL OR (p.props_prior -> n.fullkey) IS NULL " +
        "OR (p.props_prior -> n.fullkey) = 'null' " +
        "OR (p.props_prior -> n.fullkey) <> (p.props_new -> n.fullkey)) " +
        "UNION ALL SELECT p.*, 11, 'unset', 'props.' || o.key, 'null' " +
        "FROM pending p, json_each(p.props_prior) AS o " +
        `WHERE p.names_props AND o.type <> 'null' AND ${keyGlob("o.key")} ` +
        "AND (p.props_new IS NULL OR (p.props_new -> o.fullkey) IS NULL " +
        "OR (p.props_new -> o.fullkey) = 'null')) " +
        "SELECT :tenant, " +
        "(SELECT COALESCE(MAX(l.seq), 0) FROM events_log l WHERE l.user_id = :tenant) " +
        "+ ROW_NUMBER() OVER (ORDER BY r.seq, r.ordinal, r.k), " +
        "r.id || '#' || (ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY r.ordinal, r.k) - 1), " +
        "r.entity, r.entity_id, r.k_action, r.k, r.val, 2, r.batch, r.origin, r.device, " +
        "r.client, r.cause, r.actor, r.base_seq, r.ref_seq, r.at, r.tz, r.hlc, r.received_at, " +
        "?1, r.id, r.seq FROM expanded r WHERE true ON CONFLICT DO NOTHING",
      params: [ctx.appendId],
    },
    {
      // The filled props keys, into the read model by stamp, in seq order so
      // two fills of one key in this batch land the later one.
      sql: filledKeysUpsert("l.batch <> 'snapshot'", "WHERE excluded.hlc > block_values.hlc"),
      params: [ctx.appendId],
    },
    {
      // A snapshot's keys land whatever the row held: the row was written
      // around the log and its stamps went with it (`planReconcile`), so its
      // keys read as the snapshot says, as the row's other registers do.
      sql: filledKeysUpsert("l.batch = 'snapshot'", ""),
      params: [ctx.appendId],
    },
  ]
}

/** The upsert of the props keys the fill of this append read, by stamp or
 * unconditionally (`when`), for the rows `only` selects. */
const filledKeysUpsert = (only: string, when: string) =>
  "INSERT INTO block_values (user_id, block_id, key, value, hlc, seq, updated_at) " +
  "SELECT :tenant, l.entity_id, substr(l.key, 7), " +
  "CASE WHEN l.action = 'set' THEN l.value END, " +
  `COALESCE(l.hlc, ${derivedStamp("l.at", "COALESCE(l.event_seq, 0)")}), ` +
  "COALESCE(l.event_seq, 0), l.at FROM events_log l " +
  `WHERE l.user_id = :tenant AND l.append = ?1 AND l.entity = 'block' AND ${only} ` +
  "AND l.key GLOB 'props.*' ORDER BY l.seq " +
  "ON CONFLICT (user_id, block_id, key) DO UPDATE SET value = excluded.value, " +
  `hlc = excluded.hlc, seq = excluded.seq, updated_at = excluded.updated_at ${when}`.trimEnd()

/** The stamp a key event not yet placed resolves by, in its place in the
 * append (`unplacedStamp`). Every key event a client pushes carries one. */
const unplacedKeyStamp = (event: KeyEvent, rank = 0) =>
  event.hlc ?? eventStamp({ at: event.at, seq: UNPLACED_SEQ + rank } as RuminateEvent)

/** One (block, key) a run sets, with its winner. `hlc` is the row's own
 * stamp, null when it has none: the SQL then derives one from the event it
 * mirrors (`stampOf`), as `keyEventStamp` derives it. */
interface KeyWinner {
  block: string
  key: string
  /** The value as JSON text; null for an unset. */
  value: string | null
  stamp: string
  hlc: string | null
  event: string
  at: number
}

/** The net effect of a run of key events on one entity, by stamp: as
 * `StampedChange`, with a block's props as one winner per key. */
interface KeyChange extends StampedChange {
  keys: KeyWinner[]
}

/**
 * `stampedChanges` for key events: each column register's winner, each
 * block's props key's winner, and liveness, by stamp. `eventOf` names the
 * old-shaped event each key event was folded into (`collapseKeyEvents`):
 * the row takes that event's `seq`, and the projection applies a change
 * only when that event was inserted by this append.
 */
function stampedKeyChanges(
  events: readonly KeyEvent[],
  eventOf: ReadonlyMap<string, string>,
): KeyChange[] {
  const net = new Map<string, KeyChange>()
  events.forEach((event, rank) => {
    const stamp = unplacedKeyStamp(event, rank)
    const old = eventOf.get(event.id) ?? event.id
    const key = `${event.entity}\x1f${event.entity_id}`
    let change = net.get(key)
    if (!change) {
      change = {
        entity: event.entity,
        entity_id: event.entity_id,
        created: null,
        set: {},
        keys: [],
        alive: null,
        top: { event: old, at: event.at, stamp },
        last_event: old,
      }
      net.set(key, change)
    }
    change.last_event = old
    const hlc = event.hlc ?? null
    const top = { event: old, at: event.at, stamp, hlc }
    if (stamp > change.top.stamp) change.top = top
    if (change.created && stamp > change.created.top.stamp) change.created.top = top
    if (event.action === "set" || event.action === "unset") {
      if (isPropsRegister(event.key)) {
        const name = propNameOf(event.key)
        const held = change.keys.find((winner) => winner.key === name)
        const value = event.action === "set" ? JSON.stringify(event.value) : null
        const winner = {
          block: event.entity_id,
          key: name,
          value,
          stamp,
          hlc,
          event: old,
          at: event.at,
        }
        if (!held) change.keys.push(winner)
        else if (stamp > held.stamp) Object.assign(held, winner)
      } else {
        const winner = { value: event.value, event: old, stamp, hlc }
        if (stamp > (change.set[event.key]?.stamp ?? "")) change.set[event.key] = winner
        if (change.created && stamp > (change.created.fields[event.key]?.stamp ?? "")) {
          change.created.fields[event.key] = winner
        }
      }
      return
    }
    const tombstone = typeof event.value === "number" ? event.value : null
    const alive = event.action === "restore" || (event.action === "create" && tombstone === null)
    const aliveWinner: AliveWinner & { hlc: string | null } = {
      alive,
      deleted_at: alive ? null : (tombstone ?? event.at),
      event: old,
      stamp,
      hlc,
    }
    if (event.action === "create" && change.created === null) {
      change.created = { fields: {}, alive: aliveWinner, top }
    }
    if (stamp > (change.alive?.stamp ?? "")) change.alive = aliveWinner
    if (change.created && stamp > change.created.alive.stamp) change.created.alive = aliveWinner
  })
  return [...net.values()]
}

/** The stamp a winner resolves by: the key row's own (`hlc`), or — for a
 * row read out of an event without one — the one that event derives, found
 * by its id (`stampOf`), as `keyEventStamp` derives it on every reader. */
const winnerStamp = (source: string, path: string) =>
  `COALESCE(json_extract(${source}, '${path}.hlc'), ` +
  `${stampOf(`json_extract(${source}, '${path}.event')`)})`

/** `changesAs` for key changes: the stamps of a run's winners resolve from
 * the key rows themselves (`winnerStamp`), not from the old event alone. */
const keyChangesAs = (entity: Entity, ...keys: string[]) =>
  "WITH j AS MATERIALIZED (SELECT c.value AS value" +
  keys.map((key) => `, json_extract(c.value, '$.${key}') AS ${key}`).join("") +
  registersOf(entity)
    .filter((name) => entity !== "block" || name !== "props")
    .map((name) => {
      const path = name === "alive" ? "$.alive" : `$.set.${name}`
      return `, ${winnerStamp("c.value", path)} AS s_${name}`
    })
    .join("") +
  `, ${winnerStamp("c.value", "$.top")} AS s_top` +
  ", json_type(c.value, '$.keys') = 'array' AND json_array_length(c.value, '$.keys') > 0 AS touches_keys" +
  " FROM json_each(?1) AS c) "

/** A created row's register stamps, from the change itself. */
const createdKeyStamps = (entity: Entity) =>
  "json_object(" +
  RESOLVED[entity]
    .filter((name) => entity !== "block" || name !== "props")
    .map((name) => `'${name}', ${winnerStamp("j.value", `$.created.fields.${name}`)}`)
    .join(", ") +
  `, 'alive', ${winnerStamp("j.value", "$.created.alive")})`

/** A block's `props` as its key rows say: the live keys in sorted order, or
 * NULL for none — `derivedProps` in SQL. */
const propsFromKeys = (blockId: string) =>
  "(SELECT NULLIF(json_group_object(b.key, json(b.value)), '{}') FROM (SELECT key, value " +
  `FROM block_values WHERE user_id = :tenant AND block_id = ${blockId} AND value IS NOT NULL ` +
  "ORDER BY key) AS b)"
/** The stamp of a block's props register: the highest of its keys'. */
const propsStampFromKeys = (blockId: string) =>
  `(SELECT MAX(hlc) FROM block_values WHERE user_id = :tenant AND block_id = ${blockId})`

/** The upsert of a run's key winners (`KeyWinner[]` as `?1`) into
 * `block_values`, by stamp, for the events this append inserted. */
const KEY_WINNERS_UPSERT =
  "INSERT INTO block_values (user_id, block_id, key, value, hlc, seq, updated_at) " +
  "SELECT :tenant, json_extract(j.value, '$.block'), json_extract(j.value, '$.key'), " +
  `json_extract(j.value, '$.value'), ${winnerStamp("j.value", "$")}, ` +
  "(SELECT e.seq FROM events e WHERE e.user_id = :tenant " +
  "AND e.id = json_extract(j.value, '$.event')), json_extract(j.value, '$.at') " +
  "FROM json_each(?1) AS j WHERE EXISTS (SELECT 1 FROM events e WHERE e.user_id = :tenant " +
  "AND e.id = json_extract(j.value, '$.event') AND e.append = ?2) " +
  "ON CONFLICT (user_id, block_id, key) DO UPDATE SET value = excluded.value, " +
  "hlc = excluded.hlc, seq = excluded.seq, updated_at = excluded.updated_at " +
  "WHERE excluded.hlc > block_values.hlc"

/** The block registers that resolve from the row itself under the new rollup. */
const BLOCK_COLUMNS = ["type", "text", "notes_id"] as const

/**
 * The new rollup's projection of a chunk of key events: both logs appended,
 * `block_values` upserted key by key by stamp, then the rows — a block's
 * `props` derived from its key rows, its other registers by stamp as before.
 */
function planKeyChunk(
  events: readonly KeyEvent[],
  old: readonly RuminateEvent[],
  eventOf: ReadonlyMap<string, string>,
  ctx: AppendContext,
): SqlStatement[] {
  const changes = stampedKeyChanges(events, eventOf)
  const params = (json: string): SqlValue[] => [json, ctx.appendId]
  const created = "json_type(j.value, '$.created') = 'object'"
  const keyWinners = changes.flatMap((change) => change.keys)
  const blockFields = BLOCK_COLUMNS.map((name) => field("nodes", name)).join(", ")
  const blockHeld = BLOCK_COLUMNS.map((name) => heldStamp("nodes", name))
  const blockStampsAfter =
    "stamps = json_object(" +
    [...BLOCK_COLUMNS, "alive"]
      .map(
        (name) =>
          `'${name}', NULLIF(CASE WHEN ${wins("nodes", name)} THEN j.s_${name} ` +
          `ELSE ${heldStamp("nodes", name)} END, '')`,
      )
      .join(", ") +
    `, 'props', CASE WHEN j.touches_keys THEN ${propsStampFromKeys("nodes.id")} ` +
    `ELSE NULLIF(${heldStamp("nodes", "props")}, '') END` +
    ", 'legacy', CASE WHEN nodes.stamps IS NULL THEN nodes.seq " +
    "ELSE json_extract(nodes.stamps, '$.legacy') END)"
  // The run's top beats every held register: the columns and liveness as
  // held, and the keys as they stand after this append's upsert, so `>=`.
  const blockUpdatedAt =
    `updated_at = CASE WHEN j.s_top > MAX(${[...blockHeld, heldStamp("nodes", "alive")].join(", ")}) ` +
    `AND j.s_top >= COALESCE(${propsStampFromKeys("nodes.id")}, '') ` +
    "THEN json_extract(j.value, '$.top.at') ELSE nodes.updated_at END"

  return [
    insertEventsStatement(old, ctx),
    {
      sql:
        "INSERT INTO events_log (user_id, seq, id, entity, entity_id, action, key, value, v, " +
        "batch, origin, device, client, cause, actor, base_seq, ref_seq, at, tz, hlc, " +
        "received_at, append, event_id, event_seq) SELECT :tenant, " +
        "(SELECT COALESCE(MAX(seq), 0) FROM events_log WHERE user_id = :tenant) + j.key + 1, " +
        "json_extract(j.value, '$.id'), json_extract(j.value, '$.entity'), " +
        "json_extract(j.value, '$.entity_id'), json_extract(j.value, '$.action'), " +
        "json_extract(j.value, '$.key'), " +
        "COALESCE(j.value -> '$.value', 'null'), json_extract(j.value, '$.v'), " +
        "json_extract(j.value, '$.batch'), ?5, json_extract(j.value, '$.device'), ?6, " +
        "json_extract(j.value, '$.cause'), ?4, json_extract(j.value, '$.base_seq'), " +
        "json_extract(j.value, '$.ref_seq'), json_extract(j.value, '$.at'), " +
        "json_extract(j.value, '$.tz'), json_extract(j.value, '$.hlc'), ?2, ?3, " +
        "json_extract(j.value, '$.event'), " +
        "(SELECT e.seq FROM events e WHERE e.user_id = :tenant " +
        "AND e.id = json_extract(j.value, '$.event')) " +
        "FROM json_each(?1) AS j WHERE true ON CONFLICT (user_id, id) DO NOTHING",
      params: [JSON.stringify(events), ctx.now, ctx.appendId, ctx.actor, ctx.origin, ctx.client],
    },

    // Keys → block_values, by stamp
    {
      sql: KEY_WINNERS_UPSERT,
      params: params(JSON.stringify(keyWinners)),
    },

    // Blocks → nodes
    {
      sql:
        "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at, notes_id, " +
        "seq, stamps) SELECT :tenant, json_extract(j.value, '$.entity_id'), " +
        `${createdField("type")}, ${createdField("text")}, ` +
        `${propsFromKeys("json_extract(j.value, '$.entity_id')")}, ` +
        "json_extract(j.value, '$.created.top.at'), " +
        "json_extract(j.value, '$.created.alive.deleted_at'), " +
        `${createdField("notes_id")}, ${SEQ_OF_LAST_EVENT}, ` +
        // A block with no key yet holds its create's stamp for `props`, as
        // the old rollup would: the old door's stale check reads it.
        `json_set(${createdKeyStamps("block")}, '$.props', ` +
        `COALESCE(${propsStampFromKeys("json_extract(j.value, '$.entity_id')")}, ` +
        `${winnerStamp("j.value", "$.created.alive")})) ` +
        "FROM json_each(?1) AS j " +
        `WHERE ${created} AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, id) DO NOTHING",
      params: params(changesFor(changes, "block")),
    },
    {
      sql:
        keyChangesAs("block", "entity_id") +
        `UPDATE nodes SET ${blockFields}, ` +
        `props = CASE WHEN j.touches_keys THEN ${propsFromKeys("nodes.id")} ELSE nodes.props END, ` +
        `${tombstone("nodes")}, ${blockStampsAfter}, ${blockUpdatedAt}, ` +
        `seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM j WHERE nodes.user_id = :tenant AND nodes.id = j.entity_id " +
        `AND ${INSERTED_BY_THIS_APPEND} AND ${notJustInserted("nodes")} ` +
        "/* includes-deleted: an event may edit or restore a tombstoned block */",
      params: params(changesFor(changes, "block")),
    },

    // Links → link
    {
      sql:
        "INSERT INTO link (user_id, source_id, destination_id, kind, sort_key, updated_at, " +
        "deleted_at, seq, stamps) SELECT :tenant, json_extract(j.value, '$.source_id'), " +
        "json_extract(j.value, '$.destination_id'), json_extract(j.value, '$.kind'), " +
        `${createdField("sort_key")}, json_extract(j.value, '$.created.top.at'), ` +
        "json_extract(j.value, '$.created.alive.deleted_at'), " +
        `${SEQ_OF_LAST_EVENT}, ${createdKeyStamps("link")} FROM json_each(?1) AS j ` +
        `WHERE ${created} AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, source_id, destination_id, kind) DO NOTHING",
      params: params(changesFor(changes, "link")),
    },
    {
      sql:
        keyChangesAs("link", "source_id", "destination_id", "kind") +
        `UPDATE link SET ${field("link", "sort_key")}, ${tombstone("link")}, ` +
        `${stampsAfter("link", "link")}, ${updatedAt("link", "link")}, ` +
        `seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM j WHERE link.user_id = :tenant AND link.source_id = j.source_id " +
        "AND link.destination_id = j.destination_id AND link.kind = j.kind " +
        `AND ${INSERTED_BY_THIS_APPEND} AND ${notJustInserted("link")} ` +
        "/* includes-deleted: re-linking a pair revives its tombstoned row */",
      params: params(changesFor(changes, "link")),
    },

    // Views → views
    {
      sql:
        "INSERT INTO views (user_id, id, root_id, filter, sort, pinned, sort_key, stack, " +
        "updated_at, deleted_at, seq, stamps) SELECT :tenant, " +
        "json_extract(j.value, '$.entity_id'), " +
        `${createdField("root_id")}, ${createdField("filter")}, ${createdField("sort")}, ` +
        `COALESCE(${createdField("pinned")}, 0), ${createdField("sort_key")}, ` +
        `${createdField("stack")}, ` +
        "json_extract(j.value, '$.created.top.at'), " +
        "json_extract(j.value, '$.created.alive.deleted_at'), " +
        `${SEQ_OF_LAST_EVENT}, ${createdKeyStamps("view")} FROM json_each(?1) AS j ` +
        `WHERE ${created} AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, id) DO NOTHING",
      params: params(changesFor(changes, "view")),
    },
    {
      sql:
        keyChangesAs("view", "entity_id") +
        `UPDATE views SET ${RESOLVED.view.map((name) => field("views", name)).join(", ")}, ` +
        `${tombstone("views")}, ${stampsAfter("views", "view")}, ${updatedAt("views", "view")}, ` +
        `seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM j WHERE views.user_id = :tenant AND views.id = j.entity_id " +
        `AND ${INSERTED_BY_THIS_APPEND} AND ${notJustInserted("views")}`,
      params: params(changesFor(changes, "view")),
    },
  ]
}

/**
 * Cut key events into runs under `maxBytes`, as `chunksBySize` does, with
 * one rule more: the rows of one old-shaped event (`eventOf`) stay in one
 * run, together, in the order they came. A chunk's INSERT writes a created
 * row from the rows it holds, so a link's `create` cut from its `set
 * sort_key` would be a row with no key. Groups come out in first-seen
 * order, which is the old events' order (`collapseKeyEvents`).
 */
function chunksByGroup(
  events: readonly KeyEvent[],
  eventOf: ReadonlyMap<string, string>,
  maxBytes: number,
): KeyEvent[][] {
  const groups = new Map<string, KeyEvent[]>()
  for (const event of events) {
    const id = eventOf.get(event.id) ?? event.id
    const group = groups.get(id)
    if (group) group.push(event)
    else groups.set(id, [event])
  }
  const chunks: KeyEvent[][] = []
  let size = 0
  for (const group of groups.values()) {
    const bytes = group.reduce((sum, event) => sum + JSON.stringify(event).length, 0)
    if (chunks.length === 0 || size + bytes > maxBytes) {
      chunks.push([])
      size = 0
    }
    chunks[chunks.length - 1].push(...group)
    size += bytes
  }
  return chunks
}

/**
 * Plan one append of key events and the old-shaped events they fold to:
 * both logs, then the projection the rollup reads. Under the old rollup the
 * old events project as they always have (`planChunk`), and `block_values`
 * still takes the keys by stamp, so a later flip finds it current. Chunked
 * under D1's bound-value cap like `planEventAppend`.
 */
export function planKeyAppend(
  events: readonly KeyEvent[],
  old: readonly RuminateEvent[],
  eventOf: ReadonlyMap<string, string>,
  ctx: AppendContext,
  maxBytes: number = MAX_PARAM_BYTES,
): SqlStatement[] {
  const firstOf = new Map<string, RuminateEvent>()
  for (const event of old) firstOf.set(event.id, event)
  const mirrored = new Set(eventOf.values())
  const chunks = chunksByGroup(events, eventOf, maxBytes)
  if (chunks.length === 0) chunks.push([])
  const placed = new Set<string>()
  return chunks.flatMap((chunk, index) => {
    // An old event with no key rows (`appendEvents`) rides in the first chunk.
    const olds: RuminateEvent[] = index === 0 ? old.filter((event) => !mirrored.has(event.id)) : []
    for (const event of chunk) {
      const id = eventOf.get(event.id)
      if (id === undefined || placed.has(id)) continue
      const first = firstOf.get(id)
      if (first) {
        olds.push(first)
        placed.add(id)
      }
    }
    if (rollup === "new") return planKeyChunk(chunk, olds, eventOf, ctx)
    const keyWinners = stampedKeyChanges(chunk, eventOf).flatMap((change) => change.keys)
    return [
      ...planChunk(olds, ctx),
      {
        sql:
          "INSERT INTO events_log (user_id, seq, id, entity, entity_id, action, key, value, v, " +
          "batch, origin, device, client, cause, actor, base_seq, ref_seq, at, tz, hlc, " +
          "received_at, append, event_id, event_seq) SELECT :tenant, " +
          "(SELECT COALESCE(MAX(seq), 0) FROM events_log WHERE user_id = :tenant) + j.key + 1, " +
          "json_extract(j.value, '$.id'), json_extract(j.value, '$.entity'), " +
          "json_extract(j.value, '$.entity_id'), json_extract(j.value, '$.action'), " +
          "json_extract(j.value, '$.key'), " +
          "COALESCE(j.value -> '$.value', 'null'), json_extract(j.value, '$.v'), " +
          "json_extract(j.value, '$.batch'), ?5, json_extract(j.value, '$.device'), ?6, " +
          "json_extract(j.value, '$.cause'), ?4, json_extract(j.value, '$.base_seq'), " +
          "json_extract(j.value, '$.ref_seq'), json_extract(j.value, '$.at'), " +
          "json_extract(j.value, '$.tz'), json_extract(j.value, '$.hlc'), ?2, ?3, " +
          "json_extract(j.value, '$.event'), " +
          "(SELECT e.seq FROM events e WHERE e.user_id = :tenant " +
          "AND e.id = json_extract(j.value, '$.event')) " +
          "FROM json_each(?1) AS j WHERE true ON CONFLICT (user_id, id) DO NOTHING",
        params: [JSON.stringify(chunk), ctx.now, ctx.appendId, ctx.actor, ctx.origin, ctx.client],
      },
      {
        sql: KEY_WINNERS_UPSERT,
        params: [JSON.stringify(keyWinners), ctx.appendId],
      },
    ]
  })
}

/** The `meta` key that says a tenant's `block_values` were seeded. */
const BLOCK_VALUES_SEEDED = "block_values_seeded"

/**
 * Land key events: fold them to the old shape against the rows held
 * (`collapseKeyEvents`), reconcile and fill, seed `block_values` the first
 * time, then append both logs and project — one atomic batch for the
 * append; the seed, once per tenant, reads the log first and so takes a
 * batch of its own ahead of it.
 */
async function appendKeyEvents(
  tenant: TenantDb,
  events: readonly KeyEvent[],
  ctx: WriteContext,
  extra: SqlStatement[] = [],
  current?: HeldRows,
  eventless: readonly RuminateEvent[] = [],
): Promise<void> {
  const append = appendContext(ctx)
  const held = current ?? (await readCurrent(tenant, writeNaming(events)))
  const { events: old, eventOf } = collapseKeyEvents(events, (id) =>
    propsMapOfRow(held.nodes.get(id)),
  )
  const mirrored = events.map((event) => ({ ...event, event: eventOf.get(event.id) }))
  const seeded = await seedBlockValues(tenant, append)
  const statements = [
    ...(seeded ? [] : planReconcile(append)),
    ...(seeded ? [] : planLogFill(append)),
    ...planKeyAppend(mirrored, [...old, ...eventless], eventOf, append),
    ...extra,
  ]
  await tenant.includingDeleted().batch(statements)
}

/**
 * Seed a tenant's `block_values` once, from the per-key fold with the
 * legacy rule (`projectKeyLog`): exactly the rows `verify` expects. Runs the
 * reconcile and the fill first, in a batch of their own, so the fold reads
 * every event there is. Returns whether it ran (the caller's batch then
 * needs no reconcile of its own).
 */
async function seedBlockValues(tenant: TenantDb, ctx: AppendContext): Promise<boolean> {
  const [flag] = await tenant.exec(
    `SELECT value FROM meta WHERE user_id = :tenant AND key = '${BLOCK_VALUES_SEEDED}'`,
  )
  if (flag) return false
  const all = tenant.includingDeleted()
  await all.batch([...planReconcile(ctx), ...planLogFill(ctx)])
  const log = await readKeyLog(tenant)
  const legacy = await legacyReader(tenant)
  const { tables } = projectKeyLog(log, legacy.of)
  const rows: unknown[] = []
  for (const [id, block] of tables.block) {
    for (const [register, stamp] of Object.entries(block.stamps ?? {})) {
      if (!isPropsRegister(register)) continue
      const value = block.fields[register]
      rows.push({
        block: id,
        key: propNameOf(register),
        value: value === null || value === undefined ? null : JSON.stringify(value),
        stamp,
        seq: block.keySeq[register] ?? block.seq,
        at: block.keyAt[register] ?? block.at,
      })
    }
  }
  const statements: SqlStatement[] = []
  const ROWS = 2_000
  for (let i = 0; i < rows.length; i += ROWS) {
    statements.push({
      sql:
        "INSERT INTO block_values (user_id, block_id, key, value, hlc, seq, updated_at) " +
        "SELECT :tenant, json_extract(j.value, '$.block'), json_extract(j.value, '$.key'), " +
        "json_extract(j.value, '$.value'), json_extract(j.value, '$.stamp'), " +
        "json_extract(j.value, '$.seq'), json_extract(j.value, '$.at') " +
        "FROM json_each(?1) AS j WHERE true " +
        "ON CONFLICT (user_id, block_id, key) DO UPDATE SET value = excluded.value, " +
        "hlc = excluded.hlc, seq = excluded.seq, updated_at = excluded.updated_at",
      params: [JSON.stringify(rows.slice(i, i + ROWS))],
    })
  }
  statements.push({
    sql:
      "INSERT INTO meta (user_id, key, value) VALUES (:tenant, ?1, ?2) " +
      "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
    params: [BLOCK_VALUES_SEEDED, String(ctx.now)],
  })
  await all.batch(statements)
  return true
}

/**
 * Which key events a push lands, by stamp per key (`staleEvents`, per key):
 * a `set` or `unset` is stale when the key it names already holds a stamp
 * at least as high — a column's in the row's `stamps`, a props key's in
 * `block_values` — and a liveness row when `alive` does. A key no row has
 * been set on has no stamp, so any set of it lands.
 */
function staleKeyEvents(current: HeldRows, events: readonly KeyEvent[]): Set<KeyEvent> {
  const stale = new Set<KeyEvent>()
  for (const event of events) {
    const row =
      event.entity === "block"
        ? current.nodes.get(event.entity_id)
        : event.entity === "link"
          ? current.links.get(event.entity_id)
          : current.views.get(event.entity_id)
    if (row === undefined) continue
    const stamps = current.stamps.get(`${event.entity}\x1f${event.entity_id}`) ?? null
    const stamp = unplacedKeyStamp(event)
    let held: string
    if (event.action === "set" || event.action === "unset") {
      if (isPropsRegister(event.key)) {
        held = current.keyStamps.get(`${event.entity_id}\x1f${propNameOf(event.key)}`) ?? ""
      } else if (!RESOLVED[event.entity].includes(event.key)) {
        // A link's key columns: set by its create, never changed.
        held = ""
      } else {
        held = heldStampOf(stamps, event.key, row)
      }
    } else {
      held = heldStampOf(stamps, "alive", row)
    }
    if (stamp <= held) stale.add(event)
  }
  return stale
}

/** What a push of key events is answered with: each event's `seq` in
 * `events_log`, and the `seq` in `events` of the event it mirrors. */
export interface KeyEventsLanded {
  appended: number
  stale: number
  seqs: [id: string, seq: number, eventSeq: number | null][]
}

/**
 * Land a push of KEY EVENTS — the door a client of this build uses
 * (`opsToKeyEvents`): the per-key `appendClientEvents`. Stale events are
 * dropped by the rule of the rollup in force — per key under the new one,
 * per field of the old-shaped event each folds to under the old — the rest
 * are appended to both logs and projected in one batch, and a re-sent
 * event is answered with the seq it has.
 */
export async function appendClientKeyEvents(
  tenant: TenantDb,
  events: readonly KeyEvent[],
  ctx: WriteContext,
  extra: SqlStatement[] = [],
): Promise<KeyEventsLanded> {
  const current = await readCurrent(tenant, writeNaming(events))
  const held = await heldSeqs(tenant, "events_log", events)
  const unknown = events.filter((event) => !held.has(event.id))
  let stale: Set<KeyEvent>
  if (rollup === "new") {
    stale = staleKeyEvents(current, unknown)
  } else {
    const collapsed = collapseKeyEvents(unknown, (id) => propsMapOfRow(current.nodes.get(id)))
    const staleOld = new Set([...staleEvents(current, collapsed.events)].map((event) => event.id))
    stale = new Set(unknown.filter((event) => staleOld.has(collapsed.eventOf.get(event.id) ?? "")))
  }
  const fresh = unknown.filter((event) => !stale.has(event))
  if (fresh.length > 0 || extra.length > 0) {
    await appendKeyEvents(tenant, fresh, ctx, extra, current)
  }
  const after = await heldKeySeqs(tenant, events)
  return { appended: fresh.length, stale: stale.size, seqs: after }
}

/** Each key event's place in both logs, by id — absent when not appended. */
async function heldKeySeqs(
  tenant: TenantDb,
  events: readonly KeyEvent[],
): Promise<[string, number, number | null][]> {
  if (events.length === 0) return []
  const rows = await tenant.exec(
    "SELECT l.id, l.seq, l.event_seq FROM json_each(?1) AS j " +
      "JOIN events_log l ON l.user_id = :tenant AND l.id = j.value",
    [JSON.stringify(events.map((event) => event.id))],
  )
  return rows.map((row) => [
    String(row.id),
    Number(row.seq),
    row.event_seq === null ? null : Number(row.event_seq),
  ])
}

// -----------------------------------------------------------------------------
// Reading the per-key log
// -----------------------------------------------------------------------------

const KEY_EVENT_COLUMNS =
  "id, seq, entity, entity_id, action, key, value, v, batch, origin, device, client, cause, " +
  "actor, base_seq, ref_seq, at, tz, hlc, received_at, event_id, event_seq"

/** A key event as the log holds it. */
export type StoredKeyEvent = LoggedKeyEvent & {
  seq: number
  origin: EventOrigin
  client: string | null
  actor: number
  received_at: number
}

/** The per-key log after `since` (its own seq), oldest first, optionally
 * one entity's; `upTo` bounds by the OLD log's seq, the moments `/at` and
 * a restore name. A row that does not parse is logged and skipped. */
export async function readKeyEvents(
  tenant: TenantDb,
  options: {
    since?: number
    upTo?: number
    limit?: number
    entity?: string
    entityId?: string
  } = {},
): Promise<StoredKeyEvent[]> {
  const { since = 0, upTo = Number.MAX_SAFE_INTEGER, limit = 1000, entity, entityId } = options
  const rows =
    entity !== undefined && entityId !== undefined
      ? await tenant.exec(
          `SELECT ${KEY_EVENT_COLUMNS} FROM events_log WHERE user_id = :tenant AND entity = ?1 ` +
            "AND entity_id = ?2 AND seq > ?3 AND COALESCE(event_seq, 0) <= ?4 " +
            "ORDER BY seq LIMIT ?5",
          [entity, entityId, since, upTo, limit],
        )
      : await tenant.exec(
          `SELECT ${KEY_EVENT_COLUMNS} FROM events_log WHERE user_id = :tenant AND seq > ?1 ` +
            "AND COALESCE(event_seq, 0) <= ?2 ORDER BY seq LIMIT ?3",
          [since, upTo, limit],
        )
  const out: StoredKeyEvent[] = []
  for (const row of rows) {
    const event = parseStoredKeyEvent(row as Record<string, unknown>) as StoredKeyEvent | null
    if (event !== null) {
      event.client = row.client === null ? null : String(row.client)
      out.push(event)
    }
  }
  return out
}

/** The whole per-key log up to `upTo` (the old log's seq), paged. */
async function readKeyLog(
  tenant: TenantDb,
  upTo = Number.MAX_SAFE_INTEGER,
): Promise<StoredKeyEvent[]> {
  const log: StoredKeyEvent[] = []
  let since = 0
  for (;;) {
    const rows = await tenant.exec(
      `SELECT ${KEY_EVENT_COLUMNS} FROM events_log WHERE user_id = :tenant AND seq > ?1 ` +
        "AND COALESCE(event_seq, 0) <= ?2 ORDER BY seq LIMIT ?3",
      [since, upTo, PAGE],
    )
    for (const row of rows) {
      const event = parseStoredKeyEvent(row as Record<string, unknown>) as StoredKeyEvent | null
      if (event !== null) {
        event.client = row.client === null ? null : String(row.client)
        log.push(event)
      }
    }
    if (rows.length < PAGE) return log
    since = Number(rows[rows.length - 1].seq)
  }
}

// -----------------------------------------------------------------------------
// Verify, per key
// -----------------------------------------------------------------------------

/** One entity as the per-key projection holds it: every register — a
 * column, a `props.<name>`, with null for an unset key — and its stamp. */
interface KeyProjection extends Projection {
  /** The old log's seq and the writer's clock of the event that last set
   * each register, for `block_values`. */
  keySeq: Record<string, number>
  keyAt: Record<string, number>
}

/**
 * `projectLog` for the per-key log: the tables the new rollup keeps, by the
 * rules `planKeyChunk` keeps. Up to the seq a row was projected to by the
 * old rule (`legacyOf`) each row applies by seq; after it each register —
 * a block's props key by key — by stamp, every register starting from the
 * stamp the row's last legacy event derives. A row's `seq` and `at` are
 * the old log's, as the tables hold them.
 */
function projectKeyLog(
  log: readonly StoredKeyEvent[],
  legacyOf: (entity: Entity, id: string) => number,
): { tables: Record<Entity, Map<string, KeyProjection>>; rejected: number } {
  const tables: Record<Entity, Map<string, KeyProjection>> = {
    block: new Map(),
    link: new Map(),
    view: new Map(),
  }
  let rejected = 0
  for (const event of [...log].sort((a, b) => a.seq - b.seq)) {
    const table = tables[event.entity]
    const held = table.get(event.entity_id)
    if (held === undefined && event.action !== "create") {
      rejected += 1
      continue
    }
    const eseq = event.event_seq ?? event.seq
    const legacy = eseq <= legacyOf(event.entity, event.entity_id)
    const row: KeyProjection = held ?? {
      fields: {},
      deleted: false,
      deleted_at: null,
      seq: 0,
      at: 0,
      stamps: legacy ? null : {},
      keySeq: {},
      keyAt: {},
    }
    const tombstone = typeof event.value === "number" ? event.value : null
    const alive =
      event.action === "set" || event.action === "unset"
        ? null
        : event.action === "delete"
          ? false
          : event.action === "restore" || tombstone === null
    const deletedAt = alive ? null : (tombstone ?? event.at)

    if (legacy) {
      row.at = event.at
      if (event.action === "set") row.fields[event.key] = event.value
      else if (event.action === "unset") delete row.fields[event.key]
      if (alive !== null) {
        row.deleted = !alive
        row.deleted_at = deletedAt
      }
      if (event.action === "set" || event.action === "unset") {
        row.keySeq[event.key] = eseq
        row.keyAt[event.key] = event.at
      }
    } else {
      const stamps =
        row.stamps ??
        Object.fromEntries(
          [...registersOf(event.entity), ...Object.keys(row.fields)]
            .filter((name) => name !== "props")
            .map((name) => [name, rowStamp(row.at, row.seq)]),
        )
      const stamp = keyEventStamp(event)
      const top = Object.values(stamps).reduce((a, b) => (b > a ? b : a), "")
      if (event.action === "set" || event.action === "unset") {
        const name = event.key
        if (!isPropsRegister(name) && !RESOLVED[event.entity].includes(name)) {
          if (!(name in row.fields)) row.fields[name] = event.value
        } else if (stamp > (stamps[name] ?? "")) {
          row.fields[name] = event.action === "set" ? event.value : null
          stamps[name] = stamp
          row.keySeq[name] = eseq
          row.keyAt[name] = event.at
        }
      } else if (stamp > (stamps.alive ?? "")) {
        row.deleted = !alive
        row.deleted_at = deletedAt
        stamps.alive = stamp
      }
      if (stamp > top) row.at = event.at
      row.stamps = stamps
    }
    row.seq = Math.max(row.seq, eseq)
    table.set(event.entity_id, row)
  }
  return { tables, rejected }
}

/** The rows a per-key projection holds, in the old projection's shape:
 * `props` derived from the key registers, its stamp the highest of theirs. */
function assembleProjection(
  tables: Record<Entity, Map<string, KeyProjection>>,
): Record<Entity, Map<string, Projection>> {
  const out: Record<Entity, Map<string, Projection>> = {
    block: new Map(),
    link: tables.link,
    view: tables.view,
  }
  for (const [id, block] of tables.block) {
    const fields: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(block.fields)) {
      if (!isPropsRegister(name)) fields[name] = value
    }
    fields.props = derivedProps(block.fields)
    let stamps: Record<string, string> | null = null
    if (block.stamps !== null) {
      stamps = {}
      let propsStamp: string | undefined
      for (const [name, stamp] of Object.entries(block.stamps)) {
        if (isPropsRegister(name)) {
          if (propsStamp === undefined || stamp > propsStamp) propsStamp = stamp
        } else stamps[name] = stamp
      }
      if (propsStamp !== undefined) stamps.props = propsStamp
    }
    out.block.set(id, { ...block, fields, stamps })
  }
  return out
}

/** Each row's stamps and seq, for the seq the old rule projected it to. */
async function legacyReader(tenant: TenantDb): Promise<{
  of: (entity: Entity, id: string) => number
  stamps: Map<string, Record<string, string> | null>
  rows: { nodes: NodeRow[]; links: LinkRow[]; views: ViewRow[] }
}> {
  const all = tenant.includingDeleted()
  const nodeRows = await all.exec(
    "SELECT id, type, text, props, updated_at, deleted_at, notes_id, seq, stamps FROM nodes " +
      "WHERE user_id = :tenant /* includes-deleted: the fold holds tombstones too */",
  )
  const linkRows = await all.exec(
    "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq, stamps " +
      "FROM link WHERE user_id = :tenant /* includes-deleted: the fold holds tombstones too */",
  )
  const viewRows = await all.exec(
    "SELECT id, root_id, filter, sort, pinned, sort_key, stack, updated_at, deleted_at, seq, " +
      "stamps FROM views WHERE user_id = :tenant",
  )
  const nodes = nodeRows.map(toNodeRow)
  const links = linkRows.map(toLinkRow)
  const views = viewRows.map(toViewRow)
  const linkKey = (row: LinkRow) => linkEntityId(row.source_id, row.destination_id, row.kind)
  const stamps = new Map<string, Record<string, string> | null>()
  const rowSeq = new Map<string, number | undefined>()
  const note = (key: string, raw: Record<string, SqlValue>, seq: number | undefined) => {
    stamps.set(key, parseStamps(raw.stamps))
    rowSeq.set(key, seq)
  }
  nodeRows.forEach((raw, i) => note(`block\x1f${nodes[i].id}`, raw, nodes[i].seq))
  linkRows.forEach((raw, i) => note(`link\x1f${linkKey(links[i])}`, raw, links[i].seq))
  viewRows.forEach((raw, i) => note(`view\x1f${views[i].id}`, raw, views[i].seq))
  const of = (entity: Entity, id: string) => {
    const key = `${entity}\x1f${id}`
    if (!stamps.has(key)) return 0
    // A row with no stamps has been projected by the old rule up to its own
    // seq: from before 0025, or snapshotted since (`planReconcile`).
    const held = stamps.get(key)
    if (held === null || held === undefined) return Number(rowSeq.get(key) ?? 0)
    return Number(held.legacy ?? 0)
  }
  return { of, stamps, rows: { nodes, links, views } }
}
