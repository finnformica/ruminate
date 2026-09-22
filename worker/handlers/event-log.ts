// The event log: the one way anything is written to the corpus, and the ways
// a past moment is read back out of it (docs/event-sourcing.md,
// migrations/0018).
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
// tenant's first write after 0018 that is its whole corpus — genesis, with no
// backfill migration and therefore no window between a migration and the
// Worker that honours it. Ever after it is a no-op that reads nothing, unless
// something wrote around the log, in which case the next write repairs it.

import {
  fold,
  linkEntityId,
  netChanges,
  planRestoreSubtree,
  projectRows,
  rowsToEvents,
  type CurrentRows,
  type NetChange,
  type RowWrite,
  type RuminateEvent,
} from "../../src/data/events"
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
 * ONE statement, deliberately. Each arm asks for rows above the log's MAX;
 * three statements would let the first arm's inserts raise that MAX under the
 * other two, and rows between would be skipped. As one INSERT … SELECT the
 * MAX is read once, before anything is written.
 */
export function planReconcile(ctx: { now: number; appendId: string }): SqlStatement {
  const columns =
    "user_id, seq, id, entity, entity_id, action, patch, v, batch, origin, device, client, " +
    "cause, actor, base_seq, ref_seq, at, received_at, append"
  const tail = "1, 'snapshot', 'system', 'replica', NULL, 'snapshot', :tenant, NULL, NULL"
  const above = "seq > (SELECT COALESCE(MAX(e.seq), 0) FROM events e WHERE e.user_id = :tenant)"
  return {
    sql:
      `INSERT INTO events (${columns}) ` +
      "SELECT :tenant, seq, 'snap_block_' || id || '_' || seq, 'block', id, 'create', " +
      "json_object('type', type, 'text', text, 'props', props, 'notes_id', notes_id, " +
      `'deleted_at', deleted_at), ${tail}, updated_at, ?1, ?2 ` +
      `FROM nodes WHERE user_id = :tenant AND ${above} ` +
      "UNION ALL " +
      "SELECT :tenant, seq, " +
      "'snap_link_' || source_id || '|' || destination_id || '|' || kind || '_' || seq, " +
      "'link', source_id || '|' || destination_id || '|' || kind, 'create', " +
      "json_object('source_id', source_id, 'destination_id', destination_id, 'kind', kind, " +
      `'sort_key', sort_key, 'deleted_at', deleted_at), ${tail}, updated_at, ?1, ?2 ` +
      `FROM link WHERE user_id = :tenant AND ${above} ` +
      "UNION ALL " +
      "SELECT :tenant, seq, 'snap_view_' || id || '_' || seq, 'view', id, 'create', " +
      "json_object('root_id', root_id, 'filter', filter, 'sort', sort, " +
      "'pinned', json(CASE pinned WHEN 1 THEN 'true' ELSE 'false' END), " +
      `'sort_key', sort_key, 'deleted_at', deleted_at), ${tail}, updated_at, ?1, ?2 ` +
      `FROM views WHERE user_id = :tenant AND ${above} ` +
      "ON CONFLICT DO NOTHING " +
      "/* includes-deleted: a snapshot records tombstones as it finds them */",
    params: [ctx.now, ctx.appendId],
  }
}

/** Reconcile on its own — for a read of the log by a tenant who has not
 * written since 0018, whose log would otherwise be empty. */
export async function reconcileLog(tenant: TenantDb, now: number = Date.now()): Promise<void> {
  await tenant.includingDeleted().batch([planReconcile({ now, appendId: mintAppendId() })])
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
 * the log — and must add nothing to the projections either, or an old net
 * change would be laid over newer rows.
 */
const INSERTED_BY_THIS_APPEND =
  "EXISTS (SELECT 1 FROM events e WHERE e.user_id = :tenant " +
  "AND e.id = json_extract(j.value, '$.last_event') AND e.append = ?2)"
/** A field the change set, else the row's own value. `json_type` is SQL NULL
 * for an absent key and the text 'null' for a JSON null — which is how
 * "leave props alone" and "clear props" stay different things. */
const field = (table: string, name: string) =>
  `${name} = CASE WHEN json_type(j.value, '$.set.${name}') IS NULL THEN ${table}.${name} ` +
  `ELSE json_extract(j.value, '$.set.${name}') END`
const tombstone = (table: string) =>
  `deleted_at = CASE json_extract(j.value, '$.deleted') ` +
  `WHEN 1 THEN json_extract(j.value, '$.deleted_at') ` +
  `WHEN 0 THEN NULL ELSE ${table}.deleted_at END`

/**
 * The changes an UPDATE applies, as a materialised table `j` that the planner
 * drives the statement FROM.
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
const changesAs = (...keys: string[]) =>
  "WITH j AS MATERIALIZED (SELECT value" +
  keys.map((key) => `, json_extract(value, '$.${key}') AS ${key}`).join("") +
  " FROM json_each(?1)) "
/**
 * Not the row this append's own INSERT just wrote. A created row already
 * holds everything its change says, and its `seq`; updating it again would
 * write the row and each of its indexes a second time for nothing. When the
 * INSERT found the row already there (a create over a tombstone: a re-linked
 * pair), the `seq` differs and the UPDATE is what lands the change.
 */
const notJustInserted = (table: string) => `${table}.seq IS NOT ${SEQ_OF_LAST_EVENT}`

/** A link's net change, with its key split back out so the projection can
 * seek the primary key rather than compare a concatenation row by row. */
const withLinkKey = (change: NetChange) => {
  const [source_id, destination_id, kind] = change.entity_id.split("|")
  return { ...change, source_id, destination_id, kind }
}

const changesFor = (changes: NetChange[], entity: NetChange["entity"]) =>
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
  const changes = netChanges(events)
  const params = (json: string): SqlValue[] => [json, ctx.appendId]

  return [
    {
      sql:
        "INSERT INTO events (user_id, seq, id, entity, entity_id, action, patch, v, batch, " +
        "origin, device, client, cause, actor, base_seq, ref_seq, at, received_at, append) " +
        "SELECT :tenant, " +
        "(SELECT COALESCE(MAX(seq), 0) FROM events WHERE user_id = :tenant) + j.key + 1, " +
        "json_extract(j.value, '$.id'), json_extract(j.value, '$.entity'), " +
        "json_extract(j.value, '$.entity_id'), json_extract(j.value, '$.action'), " +
        "json_extract(j.value, '$.patch'), json_extract(j.value, '$.v'), " +
        "json_extract(j.value, '$.batch'), ?5, json_extract(j.value, '$.device'), ?6, " +
        "json_extract(j.value, '$.cause'), ?4, json_extract(j.value, '$.base_seq'), " +
        "json_extract(j.value, '$.ref_seq'), json_extract(j.value, '$.at'), ?2, ?3 " +
        "FROM json_each(?1) AS j WHERE true " +
        "ON CONFLICT (user_id, id) DO NOTHING",
      params: [JSON.stringify(events), ctx.now, ctx.appendId, ctx.actor, ctx.origin, ctx.client],
    },

    // Blocks → nodes
    {
      sql:
        "INSERT INTO nodes (user_id, id, type, text, props, updated_at, deleted_at, notes_id, seq) " +
        "SELECT :tenant, json_extract(j.value, '$.entity_id'), " +
        "json_extract(j.value, '$.created.type'), json_extract(j.value, '$.created.text'), " +
        "json_extract(j.value, '$.created.props'), json_extract(j.value, '$.at'), " +
        "json_extract(j.value, '$.deleted_at'), " +
        `json_extract(j.value, '$.created.notes_id'), ${SEQ_OF_LAST_EVENT} ` +
        "FROM json_each(?1) AS j " +
        `WHERE json_type(j.value, '$.created') = 'object' AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, id) DO NOTHING",
      params: params(changesFor(changes, "block")),
    },
    {
      sql:
        changesAs("entity_id") +
        `UPDATE nodes SET ${field("nodes", "type")}, ${field("nodes", "text")}, ` +
        `${field("nodes", "props")}, ${field("nodes", "notes_id")}, ${tombstone("nodes")}, ` +
        `updated_at = json_extract(j.value, '$.at'), seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM j WHERE nodes.user_id = :tenant AND nodes.id = j.entity_id " +
        `AND ${INSERTED_BY_THIS_APPEND} AND ${notJustInserted("nodes")} ` +
        "/* includes-deleted: an event may edit or restore a tombstoned block */",
      params: params(changesFor(changes, "block")),
    },

    // Links → link
    {
      sql:
        "INSERT INTO link (user_id, source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq) " +
        "SELECT :tenant, json_extract(j.value, '$.source_id'), " +
        "json_extract(j.value, '$.destination_id'), json_extract(j.value, '$.kind'), " +
        "json_extract(j.value, '$.created.sort_key'), json_extract(j.value, '$.at'), " +
        `json_extract(j.value, '$.deleted_at'), ${SEQ_OF_LAST_EVENT} FROM json_each(?1) AS j ` +
        `WHERE json_type(j.value, '$.created') = 'object' AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, source_id, destination_id, kind) DO NOTHING",
      params: params(changesFor(changes, "link")),
    },
    {
      sql:
        changesAs("source_id", "destination_id", "kind") +
        `UPDATE link SET ${field("link", "sort_key")}, ${tombstone("link")}, ` +
        `updated_at = json_extract(j.value, '$.at'), seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM j WHERE link.user_id = :tenant AND link.source_id = j.source_id " +
        "AND link.destination_id = j.destination_id AND link.kind = j.kind " +
        `AND ${INSERTED_BY_THIS_APPEND} AND ${notJustInserted("link")} ` +
        "/* includes-deleted: re-linking a pair revives its tombstoned row */",
      params: params(changesFor(changes, "link")),
    },

    // Views → views
    {
      sql:
        "INSERT INTO views (user_id, id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq) " +
        "SELECT :tenant, json_extract(j.value, '$.entity_id'), json_extract(j.value, '$.created.root_id'), " +
        "json_extract(j.value, '$.created.filter'), json_extract(j.value, '$.created.sort'), " +
        "COALESCE(json_extract(j.value, '$.created.pinned'), 0), " +
        "json_extract(j.value, '$.created.sort_key'), json_extract(j.value, '$.at'), " +
        `json_extract(j.value, '$.deleted_at'), ${SEQ_OF_LAST_EVENT} FROM json_each(?1) AS j ` +
        `WHERE json_type(j.value, '$.created') = 'object' AND ${INSERTED_BY_THIS_APPEND} ` +
        "ON CONFLICT (user_id, id) DO NOTHING",
      params: params(changesFor(changes, "view")),
    },
    {
      sql:
        changesAs("entity_id") +
        `UPDATE views SET ${field("views", "root_id")}, ${field("views", "filter")}, ` +
        `${field("views", "sort")}, ${field("views", "pinned")}, ${field("views", "sort_key")}, ` +
        `${tombstone("views")}, updated_at = json_extract(j.value, '$.at'), seq = ${SEQ_OF_LAST_EVENT} ` +
        "FROM j WHERE views.user_id = :tenant AND views.id = j.entity_id " +
        `AND ${INSERTED_BY_THIS_APPEND} AND ${notJustInserted("views")}`,
      params: params(changesFor(changes, "view")),
    },
  ]
}

/** Append events a caller already holds (a restore). Reconciles first, like
 * every write. */
export async function appendEvents(
  tenant: TenantDb,
  events: readonly RuminateEvent[],
  ctx: WriteContext,
): Promise<void> {
  const append = appendContext(ctx)
  await tenant.includingDeleted().batch([planReconcile(append), ...planEventAppend(events, append)])
}

// -----------------------------------------------------------------------------
// The one door: rows in, events appended
// -----------------------------------------------------------------------------

/** The rows a write names, as the replica holds them now — three primary-key
 * lookups driven from the JSON, however large the corpus. */
async function readCurrent(tenant: TenantDb, write: RowWrite): Promise<CurrentRows> {
  const all = tenant.includingDeleted()
  const nodeIds = [
    ...new Set([...write.nodes.map((node) => node.id), ...(write.deleteNodes ?? [])]),
  ]
  const linkKeys = [
    ...write.links.map((link) => [link.source_id, link.destination_id, link.kind]),
    ...(write.deleteLinks ?? []).map((key) => [...key]),
  ]
  const viewIds = (write.views ?? []).map((view) => view.id)

  const nodes = new Map<string, NodeRow>()
  if (nodeIds.length > 0) {
    const rows = await all.exec(
      "SELECT n.id, n.type, n.text, n.props, n.updated_at, n.deleted_at, n.notes_id, n.seq " +
        "FROM json_each(?1) AS j JOIN nodes n ON n.user_id = :tenant AND n.id = j.value " +
        "/* includes-deleted: a write is diffed against the row as it stands, tombstone or not */",
      [JSON.stringify(nodeIds)],
    )
    for (const row of rows.map(toNodeRow)) nodes.set(row.id, row)
  }
  const links = new Map<string, LinkRow>()
  if (linkKeys.length > 0) {
    const rows = await all.exec(
      "SELECT l.source_id, l.destination_id, l.kind, l.sort_key, l.updated_at, l.deleted_at, l.seq " +
        "FROM json_each(?1) AS j JOIN link l ON l.user_id = :tenant " +
        "AND l.source_id = json_extract(j.value, '$[0]') " +
        "AND l.destination_id = json_extract(j.value, '$[1]') " +
        "AND l.kind = json_extract(j.value, '$[2]') " +
        "/* includes-deleted: a write is diffed against the row as it stands, tombstone or not */",
      [JSON.stringify(linkKeys)],
    )
    for (const row of rows.map(toLinkRow)) {
      links.set(linkEntityId(row.source_id, row.destination_id, row.kind), row)
    }
  }
  const views = new Map<string, ViewRow>()
  if (viewIds.length > 0) {
    const rows = await all.exec(
      "SELECT v.id, v.root_id, v.filter, v.sort, v.pinned, v.sort_key, v.updated_at, " +
        "v.deleted_at, v.seq " +
        "FROM json_each(?1) AS j JOIN views v ON v.user_id = :tenant AND v.id = j.value",
      [JSON.stringify(viewIds)],
    )
    for (const row of rows.map(toViewRow)) views.set(row.id, row)
  }
  return { nodes, links, views }
}

/**
 * Land a write of rows: derive its events, append them, project them — one
 * atomic batch, reconcile first. `extra` rides in the same transaction (the
 * browser's `replica_cursor` stamp).
 *
 * The rows are read BEFORE the batch, outside its transaction — D1 has no
 * interactive transactions. Two writers racing on one row therefore both
 * derive against the same held row, and the later append wins by `seq`, where
 * the row planner would have let the later `updated_at` win. The fold and the
 * tables agree either way; only which of two same-instant writes survives
 * differs, and only inside that window.
 */
export async function writeRows(
  tenant: TenantDb,
  write: RowWrite,
  ctx: WriteContext,
  extra: SqlStatement[] = [],
): Promise<{ events: number }> {
  const append = appendContext(ctx)
  const current = await readCurrent(tenant, write)
  const events = rowsToEvents(current, write, {
    batch: append.appendId,
    device: ctx.device ?? "unknown",
    cause: ctx.cause,
    now: append.now,
  })
  const statements = [planReconcile(append), ...planEventAppend(events, append), ...extra]
  await tenant.includingDeleted().batch(statements)
  return { events: events.length }
}

// -----------------------------------------------------------------------------
// Reading the log
// -----------------------------------------------------------------------------

const EVENT_COLUMNS =
  "id, seq, entity, entity_id, action, patch, v, batch, origin, device, client, cause, actor, " +
  "base_seq, ref_seq, at, received_at"

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
  const events = planRestoreSubtree(await readLog(tenant), blockId, seq, {
    batch: append.appendId,
    device: ctx.device ?? "unknown",
    cause: ctx.cause ?? "restore",
    at: append.now,
    mintId: () => `${append.appendId}:${(n += 1)}`,
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

/**
 * Does folding the log still yield the tables? Drift is this architecture's
 * failure mode — a row written around the log, a projection statement that
 * disagrees with the fold — and it is silent, so it is checked rather than
 * assumed. Reads the whole log and the whole corpus: a diagnostic, never
 * something a request does on its way past.
 */
export async function verifyLog(tenant: TenantDb): Promise<LogVerdict> {
  await reconcileLog(tenant)
  const all = tenant.includingDeleted()
  const log = await readLog(tenant)
  const state = fold(log)
  const folded = projectRows(state)
  const nodes = (
    await all.exec(
      "SELECT id, type, text, props, updated_at, deleted_at, notes_id, seq FROM nodes " +
        "WHERE user_id = :tenant /* includes-deleted: the fold holds tombstones too */",
    )
  ).map(toNodeRow)
  const links = (
    await all.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq FROM link " +
        "WHERE user_id = :tenant /* includes-deleted: the fold holds tombstones too */",
    )
  ).map(toLinkRow)
  const views = (
    await all.exec(
      "SELECT id, root_id, filter, sort, pinned, sort_key, updated_at, deleted_at, seq " +
        "FROM views WHERE user_id = :tenant",
    )
  ).map(toViewRow)

  const canon = (row: object) =>
    JSON.stringify(
      Object.entries(row)
        .filter(([, value]) => value !== undefined && value !== null)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    )
  const compare = <T extends object>(held: T[], want: T[], keyOf: (row: T) => string) => {
    const wanted = new Map(want.map((row) => [keyOf(row), canon(row)]))
    const drift: string[] = []
    for (const row of held) {
      const key = keyOf(row)
      if (wanted.get(key) !== canon(row)) drift.push(key)
      wanted.delete(key)
    }
    return [...drift, ...wanted.keys()]
  }
  const drift = {
    nodes: compare(nodes, folded.nodes, (row) => row.id),
    links: compare(links, folded.links, (row) =>
      linkEntityId(row.source_id, row.destination_id, row.kind),
    ),
    views: compare(views, folded.views, (row) => row.id),
  }
  return {
    ok: drift.nodes.length + drift.links.length + drift.views.length === 0,
    events: log.length,
    rows: { nodes: nodes.length, links: links.length, views: views.length },
    drift,
    rejected: state.rejected.length,
  }
}
