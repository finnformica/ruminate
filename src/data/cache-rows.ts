import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { derivedProps, keyEventStamp, type KeyEvent } from "./key-events"

/**
 * The cache of the log (docs/events-log-cache.md): `events_log_cache`, one
 * row per `(entity, entity_id, key)` holding the current value of that
 * register and the stamp of the event that set it. The same shape on the
 * server (with `user_id`) and on every device (without). This module is the
 * mapping both ways, shared by the Worker (`worker/handlers/event-log.ts`,
 * `worker/handlers/cache-reads.ts`) and the browser's store
 * (`src/data/sql-note-store.ts`), so the two cannot disagree about what a
 * row means:
 *
 * - **A key event sets one row** (`cacheRowOf`): a `set` the register it
 *   names, an `unset` the same register with a NULL value (the tombstone of
 *   a key keeps its stamp, so an older set that arrives later loses to it),
 *   and a `create`, `delete` or `restore` the liveness register, `deleted`:
 *   JSON `null` while live, else the tombstone's clock.
 * - **A row lands only under a higher stamp** (`foldCacheRows`, and the
 *   `WHERE excluded.hlc > hlc` of every upsert). So the cache is the fold by
 *   stamp of the log, key by key, in whatever order the events arrive, and
 *   an event applied twice changes nothing.
 * - **An entity is the group of its rows** (`groupCacheRows`, or the SQL
 *   `json_group_object` of `GROUPED_COLUMNS`). One with no `deleted` row is
 *   held before created — an update reached it before its create — and is
 *   never read out. A block's `props.<name>` rows gather into its `props`
 *   column (`derivedProps`); a link's four keys are its columns.
 */

export type CacheEntity = "block" | "link"

export const isCacheEntity = (entity: string): entity is CacheEntity =>
  entity === "block" || entity === "link"

/** The liveness register: `null` while live, else the tombstone's clock. */
const LIVENESS_KEY = "deleted"

/** One row of `events_log_cache`, without the tenant. */
export interface CacheRow {
  entity: CacheEntity
  entity_id: string
  key: string
  /** The value as JSON text; null for a props key that was unset. */
  value: string | null
  /** The stamp of the event that set it (`keyEventStamp`). */
  hlc: string
  /** That event's seq in `events_log`; null on a device until the event is
   * placed by a push. */
  seq: number | null
  /** That event's `at`, the writer's clock. */
  updated_at: number
}

/** The key of a row in a map: `<entity>\x1f<entity id>\x1f<key>`. */
export const cacheRowKey = (entity: string, entityId: string, key: string): string =>
  `${entity}\x1f${entityId}\x1f${key}`

/** The key of an entity in a map: `<entity>\x1f<entity id>`. */
const cacheEntityKey = (entity: string, entityId: string): string => `${entity}\x1f${entityId}`

/** The register a key event sets, and the value it gives it. */
export function registerOf(event: Pick<KeyEvent, "action" | "key" | "value" | "at">): {
  key: string
  value: string | null
} {
  if (event.action === "set") return { key: event.key, value: JSON.stringify(event.value ?? null) }
  if (event.action === "unset") return { key: event.key, value: null }
  const tombstone = typeof event.value === "number" ? event.value : null
  if (event.action === "restore") return { key: LIVENESS_KEY, value: "null" }
  if (event.action === "delete") return { key: LIVENESS_KEY, value: String(tombstone ?? event.at) }
  return { key: LIVENESS_KEY, value: tombstone === null ? "null" : String(tombstone) }
}

/** The cache row one key event sets, at `stamp` (its own by default) and
 * `seq`; null for an entity the cache does not hold (a view). */
export function cacheRowOf(
  event: KeyEvent,
  stamp: string = keyEventStamp(event),
  seq: number | null = event.seq ?? null,
): CacheRow | null {
  if (!isCacheEntity(event.entity)) return null
  const { key, value } = registerOf(event)
  return {
    entity: event.entity,
    entity_id: event.entity_id,
    key,
    value,
    hlc: stamp,
    seq,
    updated_at: event.at,
  }
}

/**
 * The net effect of a run of key events on the cache: one row per register,
 * the one with the highest stamp (the first, on a tie). `stampOf` gives each
 * event its stamp — the Worker derives one for an event not yet placed from
 * its place in the run (`unplacedKeyStamp`).
 */
export function cacheWinners(
  events: readonly KeyEvent[],
  stampOf: (event: KeyEvent, rank: number) => string = (event) => keyEventStamp(event),
  seqOf: (event: KeyEvent) => number | null = (event) => event.seq ?? null,
): CacheRow[] {
  const out = new Map<string, CacheRow>()
  events.forEach((event, rank) => {
    const row = cacheRowOf(event, stampOf(event, rank), seqOf(event))
    if (row === null) return
    const key = cacheRowKey(row.entity, row.entity_id, row.key)
    const held = out.get(key)
    if (held === undefined || row.hlc > held.hlc) out.set(key, row)
  })
  return [...out.values()]
}

/** Fold rows into `into` by stamp: a row lands only above the stamp held. */
export function foldCacheRows(
  rows: Iterable<CacheRow>,
  into: Map<string, CacheRow> = new Map(),
): Map<string, CacheRow> {
  for (const row of rows) {
    const key = cacheRowKey(row.entity, row.entity_id, row.key)
    const held = into.get(key)
    if (held === undefined || row.hlc > held.hlc) into.set(key, row)
  }
  return into
}

/** The fold by stamp of a log's events, as cache rows. */
export const foldEventsToCache = (events: readonly KeyEvent[]): Map<string, CacheRow> =>
  foldCacheRows(cacheWinners(events))

// -----------------------------------------------------------------------------
// Entities: the group of an entity's rows
// -----------------------------------------------------------------------------

/** An entity as the group of its rows: each register's value (parsed JSON;
 * an unset key is absent), the highest seq and clock among them. */
export interface CacheEntityState {
  entity: CacheEntity
  entity_id: string
  fields: Record<string, unknown>
  seq: number | null
  updated_at: number
}

/** Group rows, in any order, into entities. */
export function groupCacheRows(rows: Iterable<CacheRow>): Map<string, CacheEntityState> {
  const out = new Map<string, CacheEntityState>()
  for (const row of rows) {
    const key = cacheEntityKey(row.entity, row.entity_id)
    let state = out.get(key)
    if (state === undefined) {
      state = { entity: row.entity, entity_id: row.entity_id, fields: {}, seq: null, updated_at: 0 }
      out.set(key, state)
    }
    // A row with no value is an unset key: the register is gone.
    if (row.value === null) delete state.fields[row.key]
    else state.fields[row.key] = JSON.parse(row.value)
    if (row.seq !== null && (state.seq === null || row.seq > state.seq)) state.seq = row.seq
    if (row.updated_at > state.updated_at) state.updated_at = row.updated_at
  }
  return out
}

/**
 * The columns a grouped read selects: the SQL spelling of `groupCacheRows`,
 * one row per entity. `fields` is a JSON object of every register with a
 * value (`json_group_object`), so the statement must leave NULL values out
 * (`value IS NOT NULL`) and group by `(entity, entity_id)`.
 */
export const GROUPED_COLUMNS = (alias: string): string =>
  `${alias}.entity, ${alias}.entity_id, ` +
  `json_group_object(${alias}.key, json(${alias}.value)) AS fields, ` +
  `MAX(${alias}.seq) AS seq, MAX(${alias}.updated_at) AS updated_at`

/** A live entity, in SQL, over a grouped read's `fields`: created, and not
 * tombstoned. `json_type` is `'null'` for a JSON null and NULL for a key
 * the object does not hold, which tells a live entity from one no create
 * has reached. */
export const LIVE_FIELDS = (fields: string): string => `json_type(${fields}, '$.deleted') = 'null'`

/** A grouped row as a driver returns it, as the entity it stands for. */
export function groupedEntity(raw: Record<string, unknown>): CacheEntityState {
  return {
    entity: String(raw.entity) as CacheEntity,
    entity_id: String(raw.entity_id),
    fields: JSON.parse(String(raw.fields)) as Record<string, unknown>,
    seq: raw.seq === null || raw.seq === undefined ? null : Number(raw.seq),
    updated_at: Number(raw.updated_at),
  }
}

/** Has a create reached the entity? Only then is it read out. */
export const isCreated = (state: CacheEntityState): boolean => LIVENESS_KEY in state.fields

/** Created, and not tombstoned. */
export const isLive = (state: CacheEntityState): boolean =>
  isCreated(state) && state.fields[LIVENESS_KEY] === null

/** The tombstone's clock, or undefined while live. */
const deletedAtOf = (state: CacheEntityState): number | undefined => {
  const value = state.fields[LIVENESS_KEY]
  return typeof value === "number" ? value : undefined
}

/** A block's row, as the app reads it. */
export function nodeRowOf(state: CacheEntityState): NodeRow {
  const { fields } = state
  const row: NodeRow = {
    id: state.entity_id,
    type: String(fields.type ?? ""),
    text: String(fields.text ?? ""),
    props: derivedProps(fields),
    updated_at: state.updated_at,
  }
  const deletedAt = deletedAtOf(state)
  if (deletedAt !== undefined) row.deleted_at = deletedAt
  if (state.seq !== null) row.seq = state.seq
  if (typeof fields.notes_id === "string") row.notes_id = fields.notes_id
  return row
}

/** A link's row, as the app reads it. */
export function linkRowOf(state: CacheEntityState): LinkRow {
  const { fields } = state
  const row: LinkRow = {
    source_id: String(fields.source_id ?? ""),
    destination_id: String(fields.destination_id ?? ""),
    kind: String(fields.kind ?? ""),
    sort_key: String(fields.sort_key ?? ""),
    updated_at: state.updated_at,
  }
  const deletedAt = deletedAtOf(state)
  if (deletedAt !== undefined) row.deleted_at = deletedAt
  if (state.seq !== null) row.seq = state.seq
  return row
}

/** The rows of a set of entities: every created one, tombstones carried as
 * `deleted_at` — or, with `live`, only the live ones. */
export function rowsOfEntities(
  states: Iterable<CacheEntityState>,
  options: { live?: boolean } = {},
): { nodes: NodeRow[]; links: LinkRow[] } {
  const nodes: NodeRow[] = []
  const links: LinkRow[] = []
  for (const state of states) {
    if (!isCreated(state)) continue
    if (options.live && !isLive(state)) continue
    if (state.entity === "block") nodes.push(nodeRowOf(state))
    else links.push(linkRowOf(state))
  }
  return { nodes, links }
}

/** The rows a driver's grouped read returns, assembled (`rowsOfEntities`). */
export const rowsOfGrouped = (
  raws: readonly Record<string, unknown>[],
  options: { live?: boolean } = {},
): { nodes: NodeRow[]; links: LinkRow[] } => rowsOfEntities(raws.map(groupedEntity), options)
