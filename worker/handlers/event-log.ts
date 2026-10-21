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
import { decodeHlc, encodeHlc, tickHlc, type Hlc } from "../../src/data/hlc"
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
        `'sort_key', sort_key, 'deleted_at', deleted_at), ${tail}, updated_at, NULL, ?1, ?2 ` +
        `FROM views WHERE user_id = :tenant AND ${above} ` +
        "ON CONFLICT DO NOTHING " +
        "/* includes-deleted: a snapshot records tombstones as it finds them */",
      params: [ctx.now, ctx.appendId],
    },
  ]
}

/** Reconcile on its own — for a read of the log by a tenant who has not
 * written since 0023, whose log would otherwise be empty. */
export async function reconcileLog(tenant: TenantDb, now: number = Date.now()): Promise<void> {
  await tenant.includingDeleted().batch(planReconcile({ now, appendId: mintAppendId() }))
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
  view: ["root_id", "filter", "sort", "pinned", "sort_key"],
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
 * has touched since 0025 — the one derived from its last event. */
const heldStamp = (table: string, name: string) =>
  `COALESCE(json_extract(${table}.stamps, '$.${name}'), ` +
  `${derivedStamp(`${table}.updated_at`, `${table}.seq`)})`
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
        `'${name}', CASE WHEN ${wins(table, name)} THEN j.s_${name} ` +
        `ELSE ${heldStamp(table, name)} END`,
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
    {
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
    },

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
        "INSERT INTO views (user_id, id, root_id, filter, sort, pinned, sort_key, updated_at, " +
        "deleted_at, seq, stamps) SELECT :tenant, json_extract(j.value, '$.entity_id'), " +
        `${createdField("root_id")}, ${createdField("filter")}, ${createdField("sort")}, ` +
        `COALESCE(${createdField("pinned")}, 0), ${createdField("sort_key")}, ` +
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
): Promise<void> {
  const append = appendContext(ctx)
  await tenant
    .includingDeleted()
    .batch([...planReconcile(append), ...planEventAppend(events, append), ...extra])
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
    const held = (name: string) => stamps?.[name] ?? rowStamp(row.updated_at, row.seq)
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
  const nodeIds = new Set<string>()
  const linkKeys = new Set<string>()
  const viewIds = new Set<string>()
  for (const event of events) {
    if (event.entity === "block") nodeIds.add(event.entity_id)
    else if (event.entity === "link") linkKeys.add(event.entity_id)
    else viewIds.add(event.entity_id)
  }
  const current = await readCurrent(tenant, {
    nodes: [],
    links: [],
    deleteNodes: [...nodeIds],
    deleteLinks: [...linkKeys].map((key) => key.split("|") as [string, string, string]),
    views: [...viewIds].map((id) => ({ id }) as ViewRow),
  })
  // An event the log already holds (a retry after a lost answer) is neither
  // stale nor new, whatever has happened to its row since: it is answered
  // with the seq it has.
  const held = await heldSeqs(tenant, events)
  const unknown = events.filter((event) => !held.has(event.id))
  const stale = staleEvents(current, unknown)
  const fresh = unknown.filter((event) => !stale.has(event))
  await appendEvents(tenant, fresh, ctx, extra)
  const after = await heldSeqs(tenant, events)
  return { appended: fresh.length, stale: stale.size, seqs: [...after.entries()] }
}

/** The `seq` the log holds each of these events at, by id — absent when not
 * (yet) appended. One primary-key seek per id, driven from the JSON. */
async function heldSeqs(
  tenant: TenantDb,
  events: readonly RuminateEvent[],
): Promise<Map<string, number>> {
  if (events.length === 0) return new Map()
  const rows = await tenant.exec(
    "SELECT e.id, e.seq FROM json_each(?1) AS j " +
      "JOIN events e ON e.user_id = :tenant AND e.id = j.value",
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
      "SELECT v.id, v.root_id, v.filter, v.sort, v.pinned, v.sort_key, v.updated_at, " +
        "v.deleted_at, v.seq, v.stamps " +
        "FROM json_each(?1) AS j JOIN views v ON v.user_id = :tenant AND v.id = j.value",
      [JSON.stringify(viewIds)],
    )
    for (const raw of rows) {
      const row = toViewRow(raw)
      views.set(row.id, row)
      stamps.set(`view\x1f${row.id}`, parseStamps(raw.stamps))
    }
  }
  return { nodes, links, views, stamps }
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
      const stamp = stamps?.[name] ?? rowStamp(row.updated_at, row.seq)
      if (highest === null || stamp > highest) highest = stamp
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
  const statements = [...planReconcile(append), ...planEventAppend(events, append), ...extra]
  await tenant.includingDeleted().batch(statements)
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
  return { seq, ...projectRows(fold(await readLog(tenant, seq))), ...bounds }
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
  events: number
  rows: { nodes: number; links: number; views: number }
  /** Rows the fold and the tables disagree about, by table. A healthy log has none. */
  drift: { nodes: string[]; links: string[]; views: string[] }
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
 * it is checked rather than assumed. Reads the whole log and the whole
 * corpus: a diagnostic, never something a request does on its way past.
 */
export async function verifyLog(tenant: TenantDb): Promise<LogVerdict> {
  await reconcileLog(tenant)
  const all = tenant.includingDeleted()
  const log = await readLog(tenant)
  const nodeRows = await all.exec(
    "SELECT id, type, text, props, updated_at, deleted_at, notes_id, seq, stamps FROM nodes " +
      "WHERE user_id = :tenant /* includes-deleted: the fold holds tombstones too */",
  )
  const linkRows = await all.exec(
    "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq, stamps " +
      "FROM link WHERE user_id = :tenant /* includes-deleted: the fold holds tombstones too */",
  )
  const viewRows = await all.exec(
    "SELECT id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq, stamps " +
      "FROM views WHERE user_id = :tenant",
  )
  const nodes = nodeRows.map(toNodeRow)
  const links = linkRows.map(toLinkRow)
  const views = viewRows.map(toViewRow)
  const linkKey = (row: LinkRow) => linkEntityId(row.source_id, row.destination_id, row.kind)

  // Each row's stamps and seq, for the seq the old rule projected it to.
  const stamps = new Map<string, Record<string, string> | null>()
  const rowSeq = new Map<string, number | undefined>()
  const note = (key: string, raw: Record<string, SqlValue>, seq: number | undefined) => {
    stamps.set(key, parseStamps(raw.stamps))
    rowSeq.set(key, seq)
  }
  nodeRows.forEach((raw, i) => note(`block\x1f${nodes[i].id}`, raw, nodes[i].seq))
  linkRows.forEach((raw, i) => note(`link\x1f${linkKey(links[i])}`, raw, links[i].seq))
  viewRows.forEach((raw, i) => note(`view\x1f${views[i].id}`, raw, views[i].seq))
  const legacyOf = (entity: Entity, id: string) => {
    const key = `${entity}\x1f${id}`
    if (!stamps.has(key)) return 0
    // A row with no stamps has been projected by the old rule up to its own
    // seq: from before 0025, or snapshotted since (`planReconcile`).
    const held = stamps.get(key)
    if (held === null || held === undefined) return Number(rowSeq.get(key) ?? 0)
    return Number(held.legacy ?? 0)
  }

  const { tables, rejected } = projectLog(log, legacyOf)
  const folded = projectRows({
    blocks: tables.block,
    links: tables.link,
    views: tables.view,
  } as unknown as Parameters<typeof projectRows>[0])

  const canon = (row: object, held: Record<string, string> | null | undefined) =>
    JSON.stringify([
      Object.entries(row)
        .filter(([, value]) => value !== undefined && value !== null)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
      canonStamps(held ?? null),
    ])
  const compare = <T extends object>(
    entity: Entity,
    held: T[],
    want: T[],
    keyOf: (row: T) => string,
  ) => {
    const wanted = new Map(
      want.map((row) => [keyOf(row), canon(row, tables[entity].get(keyOf(row))?.stamps)]),
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
  return {
    ok: drift.nodes.length + drift.links.length + drift.views.length === 0,
    events: log.length,
    rows: { nodes: nodes.length, links: links.length, views: views.length },
    drift,
    rejected,
  }
}
