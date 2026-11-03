// The event log: the one way anything is written to the corpus, and the ways
// a past moment is read back out of it (docs/event-sourcing.md,
// docs/events-log-cache.md; migrations/0023, 0028, 0032).
//
// `events_log` is the truth: one row per change to ONE KEY of one entity
// (docs/event-sourcing.md, "Per-key events"). `events_log_cache` is its one
// PROJECTION — the current value of every key of every block and link, one
// row per `(entity, entity_id, key)` with the stamp of the event that set
// it — and it is written in exactly one place, `planKeyAppend`, inside the
// same atomic batch that appends the rows it follows from. So the cache is
// never ahead of the log nor behind it, and everything that reads the
// corpus (pulls, MCP, shares, search, the D1 console) reads the cache
// (`cache-reads.ts`), an entity as the group of its rows
// (`src/data/cache-rows.ts`). `nodes`, `link` and `delta_mat_values` stay
// in place, unwritten, until a later migration drops them (the doc,
// "Migration order and rollback"). The old `events` table stays as it was
// at the cut-over, read-only: `readEvents` still serves it as history.
//
// ## Two doors
//
// A client of this build pushes KEY EVENTS (`opsToKeyEvents`): the door is
// `appendClientKeyEvents`. Every other writer hands over ROWS — a share's
// grantee, an MCP tool, a cached bundle of the app from before key events —
// and `writeRows` is where all of them land: it reads the entities the
// write names from the cache, derives the events the difference amounts to
// (`rowsToEvents`, last-writer-wins exactly as the row planner had it),
// reads them per key against the rows it holds (`expandEvent`), and
// appends. A build from before key events that pushes old-shaped events
// comes through `appendClientEvents`, read per key the same way. No writer
// has to speak key events for its change to be one, and none can write
// around the log, because nothing else in the Worker holds an INSERT or
// UPDATE against the cache (`npm run check:queries`).
//
// ## A fixed number of statements
//
// D1 allows 50 queries per Worker invocation on the free plan, and a paste
// can create two hundred blocks. So nothing here is per-event: the key rows
// travel as one JSON parameter and are inserted by one statement over
// `json_each`; their net effect per register (`cacheWinnersOf` — the
// highest-stamp value of each key) travels as one JSON parameter and lands
// in ONE upsert, by stamp. Every lookup is a primary-key seek driven FROM
// the JSON, never a walk of the tenant's rows: a push reads what it touches.
//
// ## By stamp
//
// Each register of an entity — a block's `type`, `text`, `notes_id`, its
// liveness (`deleted`) and each `props.<name>`; a link's `sort_key` and
// liveness — is a last-writer-wins register on the stamp of the event that
// set it (`keyEventStamp`, src/data/hlc.ts; docs/event-only-sync.md). A
// cache row keeps that stamp (`hlc`), and an upsert sets a register only
// under a higher one (`WHERE excluded.hlc > hlc`). So the cache does not
// depend on the order the events arrive in, two devices that change two
// keys of one block both keep their change, and a re-sent append changes
// nothing: the upsert is idempotent by itself.
//
// ## Sequence, and the watermark
//
// `seq` is `events_log`'s own order, assigned in SQL as MAX(seq) + position.
// SQLite materialises an INSERT … SELECT that reads its own table before
// writing, so the MAX is read once, before any row of this append exists,
// and positions are contiguous. A cache row takes the `seq` of the event
// that set it. `meta.cache_seq` is the seq of the last log row the cache
// has projected: every append writes it in its batch, and first projects
// any row above it the append does not hold (`catchUpStatements`) —
// normally none; the rows a Worker from before the cache appended in the
// seconds between migration 0032 and its upload, once.
//
// ## Genesis
//
// Every row the log holds no event for was recorded once, as a snapshot
// `create` with a `set` per register, by migration 0030. A row written
// around the log is not repaired: `verify` reports it.

import {
  eventStamp,
  linkEntityId,
  planRestoreSubtree,
  projectRows,
  rowsToEvents,
  type CurrentRows,
  type Entity,
  type RowWrite,
  type RuminateEvent,
} from "../../src/data/events"
import {
  cacheRowKey,
  cacheWinners,
  foldCacheRows,
  groupCacheRows,
  isCacheEntity,
  registerOf,
  rowsOfEntities,
  type CacheRow,
} from "../../src/data/cache-rows"
import { parseProps } from "../../src/data/graph"
import { decodeHlc, encodeHlc, tickHlc, type Hlc } from "../../src/data/hlc"
import {
  assembleLogState,
  canonicalJson,
  editsOf,
  expandEvent,
  foldKeys,
  keyEventStamp,
  keyStateAt,
  parseStoredKeyEvent,
  type KeyEvent,
  type LoggedKeyEvent,
} from "../../src/data/key-events"
import type { SqlStatement, SqlValue } from "../../src/data/sql-driver"
import type { TenantDb } from "../tenancy-db"
import { cacheSeqOf, readAllCacheRows, readRowsByIds } from "./cache-reads"
import type { LinkRow, NodeRow, ViewRow } from "./replica-payload"

/** The door a write came through. */
type EventOrigin = "replica" | "mcp" | "share" | "system"

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

/** The largest `ms` a stamp can hold (`encodeHlc`). */
const MAX_STAMP_MS = 10 ** 15 - 1
/**
 * `eventStamp`'s derivation (src/data/events.ts), in SQL: `ms` from `at`,
 * counter 0, and `seq:` with the `seq` padded to 15 digits. The SQL needs its
 * own spelling only because a row's `seq` is assigned in SQL; the test suite
 * pins it to `eventStamp`, so the two cannot drift apart.
 */
const derivedStamp = (at: string, seq: string) =>
  `printf('%015d-0000-seq:%015d', MIN(MAX(${at}, 0), ${MAX_STAMP_MS}), ${seq})`

/** The columns an `events_log` insert names, in the order every insert
 * here spells them. */
const LOG_COLUMNS =
  "user_id, seq, id, entity, entity_id, action, key, value, v, batch, origin, device, client, " +
  "cause, actor, base_seq, ref_seq, at, tz, hlc, received_at, append, event_id, event_seq"

// -----------------------------------------------------------------------------
// Append
// -----------------------------------------------------------------------------

/**
 * D1 refuses a bound value over 2 MB, and a push's events travel as ONE. A
 * browser push is capped at 2,000 rows (`MAX_KEY_EVENTS_PER_PUT`), which is
 * far under that for ordinary notes and not for long code blocks — and a
 * push that fails on size fails every retry, forever. So the events are cut
 * into runs that fit (`chunksByGroup`), each planned on its own and all run
 * in the one batch: each run's MAX(seq) sees the runs before it, so the
 * sequence stays contiguous and the order of events is the order they were
 * made in.
 */
const MAX_PARAM_BYTES = 750_000

// -----------------------------------------------------------------------------
// The old-shaped door: events as a build before key events made them
// -----------------------------------------------------------------------------

/** Append old-shaped events a caller already holds (a restore): read per
 * key against the rows held (`expandAgainst`) and landed as key events.
 * Reconciles first, like every write; `extra` rides in the same transaction. */
export async function appendEvents(
  tenant: TenantDb,
  events: readonly RuminateEvent[],
  ctx: WriteContext,
  extra: SqlStatement[] = [],
  current?: HeldRows,
): Promise<void> {
  const held = current ?? (await readCurrent(tenant, writeNaming(events)))
  await appendKeyEvents(tenant, expandAgainst(events, held), ctx, extra)
}

/** The rows a run of events names, as a `RowWrite` for `readCurrent`. */
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

/**
 * Land a push of old-shaped EVENTS — the door a build from before key
 * events uses (`opsToEvents` on its side). Each event is read per key
 * against the rows held (`expandAgainst`) and its rows land by the per-key
 * rule (`staleKeyEvents`): a device that was offline for a week pushing an
 * edit to one key beside a newer edit to another keeps its key. An event
 * every row of which is stale is dropped whole and not answered, as before;
 * one that reads as no change per key (a props patch that only reorders
 * keys) appends nothing and is answered with the log's end, so the client
 * clears it. The push is idempotent: an event whose rows the log holds (by
 * `event_id`) is neither stale nor new, whatever has happened to its row
 * since, and is answered with the seq it has.
 *
 * Returns each landed event's `seq` — its last key row's — so the client
 * can stamp its own copy.
 */
export async function appendClientEvents(
  tenant: TenantDb,
  events: readonly RuminateEvent[],
  ctx: WriteContext,
  extra: SqlStatement[] = [],
): Promise<{ appended: number; stale: number; seqs: [string, number][] }> {
  const current = await readCurrent(tenant, writeNaming(events))
  const held = await heldEditSeqs(tenant, events)
  const unknown = events.filter((event) => !held.has(event.id))
  const keys = expandAgainst(unknown, current)
  const stale = staleKeyEvents(current, keys)
  const fresh = keys.filter((key) => !stale.has(key))
  const landed = new Set(fresh.map((key) => key.event as string))
  const named = new Set(keys.map((key) => key.event as string))
  if (fresh.length > 0 || extra.length > 0) {
    await appendKeyEvents(tenant, fresh, ctx, extra)
  }
  const after = await heldEditSeqs(tenant, events)
  const [tail] = await tenant.exec(
    "SELECT COALESCE(MAX(seq), 0) AS seq FROM events_log WHERE user_id = :tenant",
  )
  const end = Number(tail?.seq ?? 0)
  return {
    appended: landed.size,
    stale: unknown.filter((event) => named.has(event.id) && !landed.has(event.id)).length,
    seqs: events
      .filter((event) => after.has(event.id) || !named.has(event.id))
      .map((event) => [event.id, after.get(event.id) ?? end]),
  }
}

/** The `seq` of the last key row of each of these old-shaped events, by
 * `event_id` — absent when none is appended. One index seek per id. */
async function heldEditSeqs(
  tenant: TenantDb,
  events: readonly { id: string }[],
): Promise<Map<string, number>> {
  if (events.length === 0) return new Map()
  const rows = await tenant.exec(
    "SELECT l.event_id AS id, MAX(l.seq) AS seq FROM json_each(?1) AS j CROSS JOIN events_log l " +
      "ON l.user_id = :tenant AND l.event_id = j.value GROUP BY l.event_id",
    [JSON.stringify(events.map((event) => event.id))],
  )
  return new Map(rows.map((row) => [String(row.id), Number(row.seq)]))
}

// -----------------------------------------------------------------------------
// The rows door: rows in, key events appended
// -----------------------------------------------------------------------------

/**
 * The entities a write names, as the cache holds them: each created one as
 * a row (`CurrentRows`, tombstones included), and the stamp of every key
 * the cache holds for them (`keyStamps`, by `cacheRowKey`) — what an event
 * is stale against, and what the row door diffs against.
 */
interface HeldRows extends CurrentRows {
  keyStamps: Map<string, string>
}

/** The entities a write names, as the cache holds them now — one read per
 * kind, driven from the JSON of the ids, however large the corpus. */
async function readCurrent(tenant: TenantDb, write: RowWrite): Promise<HeldRows> {
  const nodeIds = [
    ...new Set([...write.nodes.map((node) => node.id), ...(write.deleteNodes ?? [])]),
  ]
  const linkIds = [
    ...new Set([
      ...write.links.map((link) => linkEntityId(link.source_id, link.destination_id, link.kind)),
      ...(write.deleteLinks ?? []).map(([source, destination, kind]) =>
        linkEntityId(source, destination, kind),
      ),
    ]),
  ]
  const rows = [
    ...(await readRowsByIds(tenant, "block", nodeIds)),
    ...(await readRowsByIds(tenant, "link", linkIds)),
  ]
  const keyStamps = new Map<string, string>()
  for (const row of rows) keyStamps.set(cacheRowKey(row.entity, row.entity_id, row.key), row.hlc)
  const held = rowsOfEntities(groupCacheRows(rows).values())
  const nodes = new Map<string, NodeRow>(held.nodes.map((row) => [row.id, row]))
  const links = new Map<string, LinkRow>(
    held.links.map((row) => [linkEntityId(row.source_id, row.destination_id, row.kind), row]),
  )
  // A view is history only (docs/removing-views.md): no row is held.
  const views = new Map<string, ViewRow>()
  return { nodes, links, views, keyStamps }
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

/** The highest stamp any key of the held entities holds. */
function highestHeld(current: HeldRows): string | null {
  let highest: string | null = null
  for (const stamp of current.keyStamps.values()) {
    if (stamp !== "" && (highest === null || stamp > highest)) highest = stamp
  }
  return highest
}

/**
 * Land a write of rows: derive its events, read them per key, append and
 * project them — one atomic batch, reconcile first. `extra` rides in the
 * same transaction (the browser's `replica_cursor` stamp).
 *
 * The derived events carry a server stamp (`serverStamps`): a row says when
 * it was written, not what its writer had seen, so the replica's clock is
 * the best account there is.
 *
 * The rows are read BEFORE the batch, outside its transaction — D1 has no
 * interactive transactions. Two writers racing on one row therefore both
 * derive against the same held row, and the higher stamp wins each register,
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
  // View rows (a full push from a build before docs/removing-views.md) are
  // dropped: there is no table for them.
  const rows: RowWrite = { ...write, views: [] }
  const current = await readCurrent(tenant, rows)
  const stamp = serverStamps(append.now, append.origin, highestHeld(current))
  const events = rowsToEvents(current, rows, {
    batch: append.appendId,
    device: ctx.device ?? "unknown",
    cause: ctx.cause,
    now: append.now,
  }).map((event) => ({ ...event, hlc: stamp() }))
  await appendKeyEvents(tenant, expandAgainst(events, current), { ...ctx, ...append }, extra)
  return { events: events.length }
}

// -----------------------------------------------------------------------------
// Reading the old log — history only, from before the cut-over (0029)
// -----------------------------------------------------------------------------

const EVENT_COLUMNS =
  "id, seq, entity, entity_id, action, patch, v, batch, origin, device, client, cause, actor, " +
  "base_seq, ref_seq, at, tz, hlc, received_at"

/** An old-shaped event as the old log holds it: the envelope plus what the
 * replica stamped. */
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

/**
 * The old `events` table after `since`, oldest first, optionally one
 * entity's: the history as it stood at the cut-over, which a build from
 * before key events still pulls. Nothing is written there any more, so a
 * reader of it sees nothing after that moment; the per-key log
 * (`readKeyEvents`) holds everything, before and since.
 */
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

// -----------------------------------------------------------------------------
// A past moment, and the way back
// -----------------------------------------------------------------------------

/** How many rows one read asks for while walking a whole log. */
const PAGE = 5000

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
      "(SELECT MAX(seq) FROM events_log WHERE user_id = :tenant AND received_at = " +
      "(SELECT MIN(received_at) FROM events_log WHERE user_id = :tenant)) AS seq " +
      "FROM events_log WHERE user_id = :tenant",
  )
  if (!row || row.latest === null) return { earliest: null, latest: 0 }
  return {
    earliest: { seq: Number(row.seq), received_at: Number(row.received_at) },
    latest: Number(row.latest),
  }
}

export interface CorpusAt extends LogBounds {
  /** The moment served: every key row up to and including this `seq`. */
  seq: number
  nodes: NodeRow[]
  links: LinkRow[]
  views: ViewRow[]
}

/**
 * The corpus as it stood at a moment — by `seq` (the per-key log's own), or
 * by a time, which is answered as the last row the replica had RECEIVED by
 * then (its own clock; a writer's is never trusted to order anything).
 *
 * A moment before the log begins is answered as the beginning: the snapshot
 * is the earliest state there is, and `earliest` tells the caller so.
 */
export async function corpusAt(
  tenant: TenantDb,
  moment: { seq: number } | { at: number },
): Promise<CorpusAt> {
  const bounds = await logBounds(tenant)
  let seq: number
  if ("seq" in moment) {
    seq = moment.seq
  } else {
    const [row] = await tenant.exec(
      "SELECT MAX(seq) AS seq FROM events_log WHERE user_id = :tenant AND received_at <= ?1",
      [moment.at],
    )
    seq = row === undefined || row.seq === null ? 0 : Number(row.seq)
  }
  seq = Math.min(Math.max(seq, bounds.earliest?.seq ?? 0), bounds.latest)
  const state = assembleLogState(keyStateAt(await readKeyLog(tenant, seq), seq))
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
  const append = appendContext(ctx)
  let n = 0
  const log = await readKeyLog(tenant)
  const seen = log.reduce<string | null>((highest, event) => {
    const stamp = keyEventStamp(event)
    return highest === null || stamp > highest ? stamp : highest
  }, null)
  const states = {
    then: assembleLogState(keyStateAt(log, seq)),
    now: assembleLogState(foldKeys(log)),
  }
  const events = planRestoreSubtree(states, blockId, seq, {
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
  keyEvents: number
  /** How many rows the cache holds. */
  rows: number
  /** The registers the fold of the log and the cache disagree about, as
   * `<entity> <entity id> <key>: <what>`. A healthy log has none. */
  drift: string[]
  /** Log rows above the watermark (`meta.cache_seq`) that no append has
   * projected yet: 0 unless a write landed around the Worker. */
  behind: number
}

/** A row's value as compared: JSON with its keys sorted, or null for an
 * unset key. */
const canonValue = (value: string | null): string | null =>
  value === null ? null : canonicalJson(JSON.parse(value) as unknown)

/**
 * Does folding the log still yield the cache — every register, its value
 * and its stamp? Drift is this architecture's failure mode — a row written
 * around the log, an upsert that disagrees with the fold — and it is
 * silent, so it is checked rather than assumed. Reads the whole log and the
 * whole cache: a diagnostic, never something a request does on its way
 * past. The fold is `foldEventsToCache` (src/data/cache-rows.ts): each
 * register the highest-stamp event that set it, exactly as the upserts
 * resolve it and as migration 0032 backfilled it.
 */
export async function verifyLog(tenant: TenantDb): Promise<LogVerdict> {
  const log = await readKeyLog(tenant)
  const fold = foldCacheRows(cacheWinners(log))
  const cache = await readAllCacheRows(tenant)
  const held = new Map<string, CacheRow>()
  for (const row of cache) held.set(cacheRowKey(row.entity, row.entity_id, row.key), row)
  const drift: string[] = []
  const label = (row: CacheRow) => `${row.entity} ${row.entity_id} ${row.key}`
  for (const [key, want] of fold) {
    const have = held.get(key)
    if (have === undefined) {
      drift.push(`${label(want)}: only in the log`)
      continue
    }
    const differs: string[] = []
    if (canonValue(want.value) !== canonValue(have.value)) differs.push("value")
    if (want.hlc !== have.hlc) differs.push("hlc")
    if (differs.length > 0) drift.push(`${label(want)}: ${differs.join(", ")}`)
    held.delete(key)
  }
  for (const row of held.values()) drift.push(`${label(row)}: only in the cache`)
  const [head] = await tenant.exec(
    "SELECT COALESCE(MAX(seq), 0) AS seq FROM events_log WHERE user_id = :tenant",
  )
  const behind = Math.max(0, Number(head?.seq ?? 0) - (await cacheSeqOf(tenant)))
  return {
    ok: drift.length === 0 && behind === 0,
    keyEvents: log.length,
    rows: cache.length,
    drift,
    behind,
  }
}

// -----------------------------------------------------------------------------
// The per-key append (docs/event-sourcing.md, "Per-key events"; migrations/0028)
// -----------------------------------------------------------------------------

/** The stamp a key row in the log resolves by, found by its id (one seek):
 * its own, or the one its `at` and `seq` derive (`keyEventStamp`). */
const stampOf = (eventId: string) =>
  `(SELECT COALESCE(l.hlc, ${derivedStamp("l.at", "l.seq")}) FROM events_log l ` +
  `WHERE l.user_id = :tenant AND l.id = ${eventId})`

/** A seq above any the log holds: what an event not yet placed derives its
 * stamp from, in its place in the append (`rank`), so a derived stamp ranks
 * after every placed one, as it will once the event is placed. */
const UNPLACED_SEQ = 10 ** 14

/** The stamp a key event not yet placed resolves by, in its place in the
 * append (`UNPLACED_SEQ`). Every key event a client pushes carries one. */
const unplacedKeyStamp = (event: KeyEvent, rank = 0) =>
  event.hlc ?? eventStamp({ at: event.at, seq: UNPLACED_SEQ + rank } as RuminateEvent)

/** The stamp a winner resolves by: the key row's own (`hlc`), or — for a
 * row without one — the one that row derives, found by its id (`stampOf`),
 * as `keyEventStamp` derives it on every reader. */
const winnerStamp = (source: string, path: string) =>
  `COALESCE(json_extract(${source}, '${path}.hlc'), ` +
  `${stampOf(`json_extract(${source}, '${path}.event')`)})`

/** One register a run sets, as the upsert's JSON carries it: the value as
 * JSON text (null for an unset), the event's own stamp or null for one the
 * SQL derives (`winnerStamp`), and the event that set it. */
interface CacheWinner {
  entity: string
  entity_id: string
  key: string
  value: string | null
  hlc: string | null
  event: string
  at: number
}

/**
 * The net effect of a run of key events on the cache: one winner per
 * register, by stamp — a row the replica has not placed deriving its stamp
 * from its place in the run (`unplacedKeyStamp`), in the order the SQL will
 * derive it. A view event is history only: it logs and projects nothing.
 */
function cacheWinnersOf(events: readonly KeyEvent[]): CacheWinner[] {
  const out = new Map<string, { stamp: string; winner: CacheWinner }>()
  events.forEach((event, rank) => {
    if (!isCacheEntity(event.entity)) return
    const stamp = unplacedKeyStamp(event, rank)
    const { key, value } = registerOf(event)
    const id = cacheRowKey(event.entity, event.entity_id, key)
    const held = out.get(id)
    if (held !== undefined && held.stamp >= stamp) return
    out.set(id, {
      stamp,
      winner: {
        entity: event.entity,
        entity_id: event.entity_id,
        key,
        value,
        hlc: event.hlc ?? null,
        event: event.id,
        at: event.at,
      },
    })
  })
  return [...out.values()].map((entry) => entry.winner)
}

/**
 * The upsert of a run's winners (`CacheWinner[]` as `?1`) into the cache,
 * by stamp: each lands only above the stamp its register holds. A winner's
 * `seq` is its event's, found by its id (one seek); its stamp its own, or
 * the one its log row derives (`winnerStamp`). Idempotent: a re-sent
 * append's rows hold no higher stamp than the ones they left.
 */
const CACHE_UPSERT =
  "INSERT INTO events_log_cache (user_id, entity, entity_id, key, value, hlc, seq, updated_at) " +
  "SELECT :tenant, json_extract(j.value, '$.entity'), json_extract(j.value, '$.entity_id'), " +
  "json_extract(j.value, '$.key'), json_extract(j.value, '$.value'), " +
  `${winnerStamp("j.value", "$")}, ` +
  "(SELECT l.seq FROM events_log l WHERE l.user_id = :tenant " +
  "AND l.id = json_extract(j.value, '$.event')), json_extract(j.value, '$.at') " +
  "FROM json_each(?1) AS j WHERE true " +
  "ON CONFLICT (user_id, entity, entity_id, key) DO UPDATE SET value = excluded.value, " +
  "hlc = excluded.hlc, seq = excluded.seq, updated_at = excluded.updated_at " +
  "WHERE excluded.hlc > events_log_cache.hlc"

/** The watermark, written in the append's batch: the log's end, which the
 * batch's own insert has just moved. */
const WATERMARK: SqlStatement = {
  sql:
    "INSERT INTO meta (user_id, key, value) VALUES (:tenant, 'cache_seq', " +
    "(SELECT CAST(COALESCE(MAX(seq), 0) AS TEXT) FROM events_log WHERE user_id = :tenant)) " +
    "ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
}

/**
 * The projection of one run of key events: the log appended, then the
 * cache upserted register by register by stamp. Two statements, however
 * many events.
 */
function planKeyChunk(events: readonly KeyEvent[], ctx: AppendContext): SqlStatement[] {
  return [
    {
      sql:
        `INSERT INTO events_log (${LOG_COLUMNS}) SELECT :tenant, ` +
        "(SELECT COALESCE(MAX(seq), 0) FROM events_log WHERE user_id = :tenant) + j.key + 1, " +
        "json_extract(j.value, '$.id'), json_extract(j.value, '$.entity'), " +
        "json_extract(j.value, '$.entity_id'), json_extract(j.value, '$.action'), " +
        "json_extract(j.value, '$.key'), " +
        "COALESCE(j.value -> '$.value', 'null'), json_extract(j.value, '$.v'), " +
        "json_extract(j.value, '$.batch'), ?5, json_extract(j.value, '$.device'), ?6, " +
        "json_extract(j.value, '$.cause'), ?4, json_extract(j.value, '$.base_seq'), " +
        "json_extract(j.value, '$.ref_seq'), json_extract(j.value, '$.at'), " +
        "json_extract(j.value, '$.tz'), json_extract(j.value, '$.hlc'), ?2, ?3, " +
        "json_extract(j.value, '$.event'), NULL " +
        "FROM json_each(?1) AS j WHERE true ON CONFLICT (user_id, id) DO NOTHING",
      params: [JSON.stringify(events), ctx.now, ctx.appendId, ctx.actor, ctx.origin, ctx.client],
    },
    { sql: CACHE_UPSERT, params: [JSON.stringify(cacheWinnersOf(events))] },
  ]
}

/**
 * Cut key events into runs under `maxBytes`, with one rule: the rows of one
 * edit (`event`, `editsOf`) stay in one run, together, in the order they
 * came. A run's INSERT writes a created row from the rows it holds, so a
 * link's `create` cut from its `set sort_key` would be a row with no key.
 * Edits come out in first-seen order, which is the order they were made in.
 */
function chunksByGroup(events: readonly KeyEvent[], maxBytes: number): KeyEvent[][] {
  const groups = new Map<string, KeyEvent[]>()
  for (const event of events) {
    const id = event.event ?? event.id
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
 * Plan one append of key events: the statements that add them to the log
 * and apply them to the cache, chunked under D1's bound-value cap, then the
 * watermark. Run them as ONE batch — the atomicity is the design. `?1` is
 * always the JSON; `:tenant` is bound by `TenantDb` and by nothing else.
 * Each event names its edit (`event`) before it comes here
 * (`appendKeyEvents`).
 */
export function planKeyAppend(
  events: readonly KeyEvent[],
  ctx: AppendContext,
  maxBytes: number = MAX_PARAM_BYTES,
): SqlStatement[] {
  return [
    ...chunksByGroup(events, maxBytes).flatMap((chunk) => planKeyChunk(chunk, ctx)),
    WATERMARK,
  ]
}

/**
 * The rows the log holds above the watermark, projected: what a Worker
 * from before the cache appended in the seconds between migration 0032 and
 * its own replacement, once — or a row a hand ran around the Worker. One
 * `meta` read per write to find nothing; the rows' own stamps and seqs
 * when there is something (`cacheWinners`, as verify folds them).
 */
async function catchUpStatements(tenant: TenantDb): Promise<SqlStatement[]> {
  const [row] = await tenant.exec(
    "SELECT (SELECT value FROM meta WHERE user_id = :tenant AND key = 'cache_seq') AS cache_seq, " +
      "(SELECT MAX(seq) FROM events_log WHERE user_id = :tenant) AS head",
  )
  const cacheSeq = typeof row?.cache_seq === "string" ? Number(row.cache_seq) : 0
  const head = row?.head === null || row?.head === undefined ? 0 : Number(row.head)
  if (head <= cacheSeq) return []
  const behind: StoredKeyEvent[] = []
  let since = cacheSeq
  for (;;) {
    const page = await readKeyEvents(tenant, { since, upTo: head, limit: PAGE })
    behind.push(...page)
    if (page.length < PAGE) break
    since = page[page.length - 1].seq
  }
  const rows = cacheWinners(behind)
  if (rows.length === 0) return []
  return [
    {
      sql:
        "INSERT INTO events_log_cache (user_id, entity, entity_id, key, value, hlc, seq, " +
        "updated_at) SELECT :tenant, json_extract(j.value, '$.entity'), " +
        "json_extract(j.value, '$.entity_id'), json_extract(j.value, '$.key'), " +
        "json_extract(j.value, '$.value'), json_extract(j.value, '$.hlc'), " +
        "json_extract(j.value, '$.seq'), json_extract(j.value, '$.updated_at') " +
        "FROM json_each(?1) AS j WHERE true " +
        "ON CONFLICT (user_id, entity, entity_id, key) DO UPDATE SET value = excluded.value, " +
        "hlc = excluded.hlc, seq = excluded.seq, updated_at = excluded.updated_at " +
        "WHERE excluded.hlc > events_log_cache.hlc",
      params: [JSON.stringify(rows)],
    },
  ]
}

/**
 * Land key events: name each row's edit (`editsOf`), then append and
 * project — one atomic batch, the watermark's catch-up ahead of the run
 * inside it.
 */
async function appendKeyEvents(
  tenant: TenantDb,
  events: readonly KeyEvent[],
  ctx: WriteContext,
  extra: SqlStatement[] = [],
): Promise<void> {
  const append = appendContext(ctx)
  const edits = editsOf(events)
  const named = events.map((event) => ({ ...event, event: edits.get(event.id) }))
  const statements = [
    ...(await catchUpStatements(tenant)),
    ...planKeyAppend(named, append),
    ...extra,
  ]
  await tenant.includingDeleted().batch(statements)
}

/** A link's key columns: set by its create, never changed. A set of one is
 * never stale, so a create lands whole over a tombstoned link. */
const LINK_KEY_COLUMNS = new Set(["source_id", "destination_id", "kind"])

/**
 * Which key events a push lands, by stamp per key: a `set` or `unset` is
 * stale when the key it names already holds a stamp at least as high, and
 * a liveness row when `deleted` does. A key no row has been set on has no
 * stamp, so any set of it lands. The upsert would ignore a stale row
 * anyway; this keeps it out of the log as well.
 */
function staleKeyEvents(current: HeldRows, events: readonly KeyEvent[]): Set<KeyEvent> {
  const stale = new Set<KeyEvent>()
  for (const event of events) {
    if (!isCacheEntity(event.entity)) continue
    if (event.entity === "link" && LINK_KEY_COLUMNS.has(event.key)) continue
    const { key } = registerOf(event)
    const held = current.keyStamps.get(cacheRowKey(event.entity, event.entity_id, key)) ?? ""
    if (unplacedKeyStamp(event) <= held) stale.add(event)
  }
  return stale
}

/** What a push of key events is answered with: each event's `seq`. */
export interface KeyEventsLanded {
  appended: number
  stale: number
  seqs: [id: string, seq: number][]
}

/**
 * Land a push of KEY EVENTS — the door a client of this build uses
 * (`opsToKeyEvents`). Stale events are dropped per key (`staleKeyEvents`),
 * the rest are appended and projected in one batch, reconcile first, and
 * the push is idempotent: an event already in the log (by `id`) is not
 * appended again and projects nothing, so a retry after a lost response is
 * harmless and answered with the seq it has.
 */
export async function appendClientKeyEvents(
  tenant: TenantDb,
  events: readonly KeyEvent[],
  ctx: WriteContext,
  extra: SqlStatement[] = [],
): Promise<KeyEventsLanded> {
  const current = await readCurrent(tenant, writeNaming(events))
  const held = await heldKeySeqs(tenant, events)
  const unknown = events.filter((event) => !held.has(event.id))
  const stale = staleKeyEvents(current, unknown)
  const fresh = unknown.filter((event) => !stale.has(event))
  if (fresh.length > 0 || extra.length > 0) {
    await appendKeyEvents(tenant, fresh, ctx, extra)
  }
  const after = await heldKeySeqs(tenant, events)
  return { appended: fresh.length, stale: stale.size, seqs: [...after.entries()] }
}

/** The `seq` the log holds each of these key events at, by id — absent when
 * not (yet) appended. One primary-key seek per id, driven from the JSON:
 * CROSS JOIN, so `json_each` is the outer loop. As a plain JOIN the planner
 * walked the whole log once per id (93,241 rows at 46,620 events, twice per
 * push); the same holds for every `json_each` lookup of rows below. */
async function heldKeySeqs(
  tenant: TenantDb,
  events: readonly { id: string }[],
): Promise<Map<string, number>> {
  if (events.length === 0) return new Map()
  const rows = await tenant.exec(
    "SELECT l.id, l.seq FROM json_each(?1) AS j CROSS JOIN events_log l " +
      "ON l.user_id = :tenant AND l.id = j.value",
    [JSON.stringify(events.map((event) => event.id))],
  )
  return new Map(rows.map((row) => [String(row.id), Number(row.seq)]))
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

/** The per-key log after `since` and up to `upTo` (its own seq), oldest
 * first, optionally one entity's. A row that does not parse is logged and
 * skipped. */
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
            "AND entity_id = ?2 AND seq > ?3 AND seq <= ?4 ORDER BY seq LIMIT ?5",
          [entity, entityId, since, upTo, limit],
        )
      : await tenant.exec(
          `SELECT ${KEY_EVENT_COLUMNS} FROM events_log WHERE user_id = :tenant AND seq > ?1 ` +
            "AND seq <= ?2 ORDER BY seq LIMIT ?3",
          [since, upTo, limit],
        )
  return storedKeyEvents(rows)
}

const storedKeyEvents = (rows: Record<string, SqlValue>[]): StoredKeyEvent[] => {
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

/** The whole per-key log up to `upTo`, paged. */
async function readKeyLog(
  tenant: TenantDb,
  upTo = Number.MAX_SAFE_INTEGER,
): Promise<StoredKeyEvent[]> {
  const log: StoredKeyEvent[] = []
  let since = 0
  for (;;) {
    const rows = await tenant.exec(
      `SELECT ${KEY_EVENT_COLUMNS} FROM events_log WHERE user_id = :tenant AND seq > ?1 ` +
        "AND seq <= ?2 ORDER BY seq LIMIT ?3 " +
        "/* reads-corpus: the whole log, for verify, a past moment and a restore */",
      [since, upTo, PAGE],
    )
    log.push(...storedKeyEvents(rows))
    if (rows.length < PAGE) return log
    since = Number(rows[rows.length - 1].seq)
  }
}
