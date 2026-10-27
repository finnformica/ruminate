import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import {
  toLinkRow,
  toNodeRow,
  toViewRow,
  type LinkRow,
  type NodeRow,
  type ViewRow,
} from "../../worker/handlers/replica-payload"
import { ensureCorpusSchema } from "./corpus-schema"
import type { Entity, EntityKeys, StampedState } from "./events"
import {
  CACHE_TABLES,
  cacheRowStatements,
  derivedStamps,
  entityIdOfRow,
  entityOfRow,
  fillStampsStatements,
  keyValues,
} from "./fold-cache"
import {
  assembleStamped,
  coalesceTypingKeys,
  foldKeysByStamp,
  parseStoredKeyEvent,
  type BlockValueRow,
  type KeyEvent,
  type LoggedKeyEvent,
} from "./key-events"
import { CHILD_KIND, buildGraphSnapshot } from "./graph"
import type { NoteStore } from "./note-store"
import type { SqlDriver, SqlStatement, SqlValue } from "./sql-driver"

/** The `meta` flag of the one-time stamp fill (`fillStampsStatements`). */
export const CACHE_STAMPS_KEY = "cache_stamps"

/**
 * The SQL implementation of `NoteStore` — the store the app runs on, over the
 * schema v3 graph (docs/graph-schema-v2.md): `nodes` + `link` + `views` +
 * `meta`, and since v9 the device's own `events` (docs/event-sourcing.md).
 *
 * Backed by any `SqlDriver` (sqlite-wasm/OPFS in the browser, `node:sqlite` in
 * tests) and the exact migration files that initialize the D1 replica — in the
 * **single-tenant** shape (`corpus-schema.ts`): one user per browser profile,
 * so no `user_id` column, but the same `deleted_at` soft deletes the replica
 * has.
 *
 * **The log is the truth; the rows are a cache of its fold**
 * (docs/event-only-sync.md, "The cache"). A write arrives as the per-key
 * events the editor's ops amount to (`opsToKeyEvents`), and a pull as the
 * per-key events of the replica's log. Each lands in one transaction:
 * appended to `events_log`, and applied to the cache rows of the entities
 * it names, register by register by stamp (`foldKeysByStamp`,
 * `fold-cache.ts`), a block's keys to `block_values` beside its row. Each
 * row keeps the stamp of each register (`stamps`), so it is the fold of its
 * entity's events, in any order, and an event applied twice changes
 * nothing. No other row is read, and nothing is folded again: a read is an
 * index lookup. The old `events` table stays, unread (schema v15).
 *
 * **Soft deletes.** Nothing here hard-deletes a corpus row. A delete stamps
 * `deleted_at` (and bumps `updated_at`, so the tombstone replicates like any
 * edit); every row a single write retires shares that write's one timestamp,
 * so a future restore is "revive the rows stamped at T". Reads discard
 * tombstones at read time — `loadMemGraph` loads only live rows and
 * `buildGraphSnapshot` drops links whose endpoints are gone — so deletes never
 * cascade at write time and a link to a deleted node survives as the position
 * a restore would put it back into.
 *
 * **The stamp fill.** Rows from before the cache have no stamps. The first
 * open of this build gives each the stamps its last event derives
 * (`derivedStamps`), once, under the `cache_stamps` flag in `meta`.
 */

/**
 * Open a `NoteStore` on `driver`, applying the migrations when the database is
 * empty. A v1 database is migrated in place by `0002` (which drops the v1
 * tables — contents re-pull from the replica), a v2 one gains its soft-delete
 * columns, and anything else unrecognized is reset. The ladder itself lives in
 * `corpus-schema.ts`, shared with the D1 corpus.
 */
export async function openSqlNoteStore(
  driver: SqlDriver,
  options: { now?: () => number } = {},
): Promise<NoteStore> {
  await ensureCorpusSchema(driver, { init: migration0001, nodes: migration0002 }, "single")
  const now = options.now ?? Date.now
  await fillStampsOnce(driver, now())

  return {
    getGraph: async () => {
      const mem = await loadMemGraph(driver)
      return buildGraphSnapshot(mem.nodes, mem.links)
    },

    applyEvents: async (events, options = {}) => {
      if (events.length === 0) return
      const frozen = options.frozen ?? new Set<string>()
      const unpushed = await loadUnpushed(driver)
      // The tail a new typing run may still coalesce into: unpushed, and not
      // in a push that has already picked it up.
      const open = unpushed.filter((event) => !frozen.has(event.id))
      const held = new Set(open.map((event) => event.id))
      const coalesced = coalesceTypingKeys([...open, ...events])
      const kept = new Set(coalesced.map((event) => event.id))
      const statements: SqlStatement[] = []
      const appended: KeyEvent[] = []
      for (const event of coalesced) {
        if (held.has(event.id)) continue
        statements.push(insertEventStatement(event))
        appended.push(event)
      }
      // The deletes go after the inserts, so a new event never takes the
      // position of one it replaces: positions keep the order made.
      for (const event of open) {
        // tenant-exempt: the local store is one user per browser profile; and
        // this is the queue coalescing, not a delete of anything that happened.
        if (!kept.has(event.id))
          statements.push({ sql: "DELETE FROM events_log WHERE id = ?", params: [event.id] })
      }
      // The cache takes what is appended. An event a run coalesced away was
      // applied when it was appended, and the one that replaced it has the
      // higher stamp, so the row is the fold of what the log keeps.
      statements.push(...(await cacheStatements(driver, appended)))
      if (statements.length > 0) await driver.batch(statements)
    },

    unpushedEvents: () => loadUnpushed(driver),

    markEventsPushed: async (seqs) => {
      if (seqs.length === 0) return
      const statements: SqlStatement[] = []
      // A placed event moves to the end of the log's append order.
      for (const [id, seq, eventSeq] of seqs) {
        statements.push({
          sql:
            "UPDATE events_log SET seq = ?, event_seq = COALESCE(?, event_seq), " +
            `position = ${NEXT_POSITION} WHERE id = ?`,
          params: [seq, eventSeq ?? null, id],
        })
      }
      // A row's `seq` is its last event's in the OLD log — the cursors' order:
      // stamp the rows these events changed, never backwards.
      for (const [id, , eventSeq] of seqs) {
        if (eventSeq === null || eventSeq === undefined) continue
        for (const table of ["nodes", "link", "views"] as const) {
          statements.push({
            sql:
              `UPDATE ${table} SET seq = ?1 WHERE (seq IS NULL OR seq < ?1) AND ` +
              (table === "link"
                ? "source_id || '|' || destination_id || '|' || kind = "
                : "id = ") +
              `(SELECT entity_id FROM events_log WHERE id = ?2 AND entity = '${ENTITY_OF[table]}')`,
            params: [eventSeq, id],
          })
        }
        statements.push({
          sql:
            "UPDATE block_values SET seq = ?1 WHERE (seq IS NULL OR seq < ?1) AND block_id = " +
            "(SELECT entity_id FROM events_log WHERE id = ?2 AND entity = 'block')",
          params: [eventSeq, id],
        })
      }
      await driver.batch(statements)
    },

    applyPulledEvents: async (events) => {
      if (events.length === 0) return
      await driver.batch([
        ...events.map(insertPulledEventStatement),
        ...(await cacheStatements(driver, events)),
      ])
    },

    eventLog: () => loadLog(driver),

    foldOfLog: (keys) => loadFoldOfLog(driver, keys),

    getRowsOf: (keys) => loadRowsOf(driver, keys),

    getBlockValuesOf: (ids) => loadBlockValuesOf(driver, ids),

    childLinksOf: (ids) =>
      readChunked(driver, ids, LIVE_LINKS, "source_id", toLinkRow, ORDER_LINKS),

    parentLinksOf: (ids) =>
      readChunked(driver, ids, LIVE_LINKS, "destination_id", toLinkRow, ORDER_LINKS),

    nodesOf: (ids) => readChunked(driver, ids, LIVE_NODES, "id", toNodeRow),

    getAllRows: () => loadAllRows(driver),

    applyPull: async (plan) => {
      const statements: SqlStatement[] = []
      for (const [source, destination, kind] of plan.deleteLinks) {
        // tenant-exempt: a row absent from the replica's key lists no longer
        // exists there at all (purged, or never replicated) — there is no
        // tombstone to mirror, so the local copy goes too.
        statements.push({
          sql: "DELETE FROM link WHERE source_id = ? AND destination_id = ? AND kind = ?",
          params: [source, destination, kind],
        })
      }
      for (const id of plan.deleteNodes) {
        // tenant-exempt: as above — mirroring a purge, not performing a delete.
        statements.push({
          sql: "DELETE FROM link WHERE source_id = ? OR destination_id = ?",
          params: [id, id],
        })
        // tenant-exempt: as above.
        statements.push({ sql: "DELETE FROM nodes WHERE id = ?", params: [id] })
      }
      // Rows from outside the log (a repair from the screen) take the stamps
      // their last event derives, as the stamp fill gives them.
      for (const node of plan.nodes) statements.push(upsertNodeStatement(node))
      for (const link of plan.links) statements.push(upsertLinkStatement(link))
      for (const view of plan.views) statements.push(upsertViewStatement(view))
      if (statements.length > 0) await driver.batch(statements)
    },

    getViews: () => loadViews(driver),

    getLiveRows: (keys) => loadLiveRows(driver, keys),

    clear: async () => {
      await driver.batch([
        // tenant-exempt: a cache reset discards the local database wholesale —
        // a wipe, not a delete, and tombstones would only resurrect the rows
        // the next pull replaces.
        { sql: "DELETE FROM link" },
        // tenant-exempt: as above.
        { sql: "DELETE FROM nodes" },
        // tenant-exempt: as above.
        { sql: "DELETE FROM views" },
        // tenant-exempt: as above — the device's log of a corpus it no longer
        // holds, unpushed events included (see `NoteStore.clear`).
        { sql: "DELETE FROM events" },
        // tenant-exempt: as above.
        { sql: "DELETE FROM events_log" },
        // tenant-exempt: as above.
        { sql: "DELETE FROM block_values" },
      ])
    },

    getMeta: async (key) => {
      const rows = await driver.exec("SELECT value FROM meta WHERE key = ?", [key])
      return rows.length > 0 && rows[0].value != null ? String(rows[0].value) : null
    },

    setMeta: async (key, value) => {
      await driver.batch([
        {
          sql:
            "INSERT INTO meta (key, value) VALUES (?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          params: [key, value],
        },
      ])
    },

    close: () => driver.close(),
  }
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** The LIVE graph — what the snapshot is built from. `seq` rides along: it is
 * what an edit of the row says it believed it was changing (`base_seq`). */
async function loadMemGraph(driver: SqlDriver): Promise<{ nodes: NodeRow[]; links: LinkRow[] }> {
  const [nodeRows, linkRows] = await Promise.all([driver.exec(LIVE_NODES), driver.exec(LIVE_LINKS)])
  return { nodes: nodeRows.map(toNodeRow), links: linkRows.map(toLinkRow) }
}

const LIVE_NODES =
  "SELECT id, type, text, props, updated_at, notes_id, seq FROM nodes WHERE deleted_at IS NULL"
// A live link with a tombstoned end is not read: `buildGraphSnapshot` drops
// it when it sees the tombstone, and only the live nodes are read here. The
// fold reads out the same graph (`toGraphSnapshot`, `readOutEntities`).
const LIVE_LINKS =
  "SELECT source_id, destination_id, kind, sort_key, updated_at, seq FROM link " +
  "WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM nodes " +
  "WHERE nodes.id IN (link.source_id, link.destination_id) " +
  "AND nodes.deleted_at IS NOT NULL)"
const LIVE_VIEWS =
  "SELECT id, root_id, filter, sort, pinned, sort_key, stack, updated_at, seq FROM views " +
  "WHERE deleted_at IS NULL"

/** Keys in one statement: well under SQLite's bound on parameters. */
const KEYS_PER_READ = 300

const inChunks = <T>(items: readonly T[]) =>
  Array.from({ length: Math.ceil(items.length / KEYS_PER_READ) }, (_, i) =>
    items.slice(i * KEYS_PER_READ, (i + 1) * KEYS_PER_READ),
  )

/** The live rows of the named entities, by the rules `loadMemGraph` and
 * `loadViews` read the whole tables with (`NoteStore.getLiveRows`). */
async function loadLiveRows(
  driver: SqlDriver,
  keys: EntityKeys,
): Promise<{ nodes: NodeRow[]; links: LinkRow[]; views: ViewRow[] }> {
  const marks = (n: number) => Array(n).fill("?").join(", ")
  const nodes: NodeRow[] = []
  for (const ids of inChunks([...keys.blocks])) {
    const rows = await driver.exec(`${LIVE_NODES} AND id IN (${marks(ids.length)})`, ids)
    nodes.push(...rows.map(toNodeRow))
  }
  const links: LinkRow[] = []
  const linkKeys = [...keys.links].map((id) => id.split("|"))
  for (const chunk of inChunks(linkKeys)) {
    const rows = await driver.exec(
      `${LIVE_LINKS} AND (${chunk
        .map(() => "(source_id = ? AND destination_id = ? AND kind = ?)")
        .join(" OR ")})`,
      chunk.flat(),
    )
    // The graph holds child links only (`buildGraphSnapshot`).
    links.push(...rows.map(toLinkRow).filter((link) => link.kind === CHILD_KIND))
  }
  const views: ViewRow[] = []
  for (const ids of inChunks([...keys.views])) {
    const rows = await driver.exec(`${LIVE_VIEWS} AND id IN (${marks(ids.length)})`, ids)
    views.push(...rows.map(toViewRow))
  }
  return { nodes, links, views }
}

/** Every row, tombstones included — what replication has to carry. */
async function loadAllRows(
  driver: SqlDriver,
): Promise<{ nodes: NodeRow[]; links: LinkRow[]; views: ViewRow[] }> {
  const [nodeRows, linkRows, viewRows] = await Promise.all([
    driver.exec(
      `SELECT id, type, text, props, updated_at, deleted_at, notes_id, seq FROM nodes WHERE ${CREATED} ` +
        "/* includes-deleted: the full-push source; a delete only reaches other " +
        "devices if its tombstone travels */",
    ),
    driver.exec(
      "SELECT source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq FROM link " +
        `WHERE ${CREATED} /* includes-deleted: as above */`,
    ),
    driver.exec(
      "SELECT id, root_id, filter, sort, pinned, sort_key, stack, updated_at, deleted_at, seq " +
        "FROM views " +
        `WHERE ${CREATED} /* includes-deleted: as above */`,
    ),
  ])
  return {
    nodes: nodeRows.map(toNodeRow),
    links: linkRows.map(toLinkRow),
    views: viewRows.map(toViewRow),
  }
}

/** Every LIVE view row — the entrypoints the sidebar and the note page read
 * (migrations/0015). Tombstones are for replication, not for reading. */
async function loadViews(driver: SqlDriver): Promise<ViewRow[]> {
  const rows = await driver.exec(LIVE_VIEWS)
  return rows.map(toViewRow)
}

// -----------------------------------------------------------------------------
// The device's log
// -----------------------------------------------------------------------------

const ENTITY_OF = { nodes: "block", link: "link", views: "view" } as const

/** The queue: events the replica has not acknowledged, in the order made. */
async function loadUnpushed(driver: SqlDriver): Promise<KeyEvent[]> {
  const rows = await driver.exec(
    `SELECT ${EVENT_COLUMNS} FROM events_log WHERE seq IS NULL ORDER BY position`,
  )
  return rows.flatMap((row) => {
    const event = toEvent(row)
    return event === null ? [] : [event]
  })
}

/** The whole log, placed events first in `seq` order, then this device's
 * unpushed ones in the order made, each given a provisional `seq` above the
 * last placed one so a fold keeps them last. A row that does not read as an
 * event is reported and skipped (`parseStoredKeyEvent`). */
async function loadLog(driver: SqlDriver): Promise<LoggedKeyEvent[]> {
  const rows = await driver.exec(
    `SELECT ${EVENT_COLUMNS}, origin, actor, received_at FROM events_log ` +
      "ORDER BY seq IS NULL, seq, position",
  )
  let last = 0
  const out: LoggedKeyEvent[] = []
  for (const row of rows) {
    const event = toEvent(row)
    if (event === null) continue
    if (row.seq !== null) {
      event.seq = Number(row.seq)
      last = event.seq
    } else {
      event.seq = last += 1
      event.pending = true
    }
    out.push(event)
  }
  return out
}

// -----------------------------------------------------------------------------
// The cache
// -----------------------------------------------------------------------------

/** A row no create has reached is held, not read (`fold-cache.ts`). */
const CREATED = "(stamps IS NULL OR json_extract(stamps, '$.alive') IS NOT NULL)"

const EVENT_COLUMNS =
  "id, seq, entity, entity_id, action, key, value, v, batch, device, cause, base_seq, ref_seq, " +
  "at, tz, hlc, event_id, event_seq"

/** A stored row as a key event, placed when it is; null (reported) for a
 * row that is not one. */
const toEvent = (row: Record<string, SqlValue>): LoggedKeyEvent | null =>
  parseStoredKeyEvent(row as Record<string, unknown>)

/** The entities a batch of events names, by kind. */
function keysOfEvents(events: readonly KeyEvent[]) {
  const keys = { block: new Set<string>(), link: new Set<string>(), view: new Set<string>() }
  for (const event of events) keys[event.entity].add(event.entity_id)
  return keys
}

/** `(k1 = ? AND k2 = ?) OR …` for a chunk of entity ids, with its params. */
function whereKeys(entity: Entity, ids: readonly string[]): { sql: string; params: string[] } {
  const { key } = CACHE_TABLES[entity]
  if (key.length === 1) {
    return { sql: `${key[0]} IN (${ids.map(() => "?").join(", ")})`, params: [...ids] }
  }
  return {
    sql: ids.map(() => `(${key.map((column) => `${column} = ?`).join(" AND ")})`).join(" OR "),
    params: ids.flatMap((id) => keyValues(entity, id)),
  }
}

/** The cache rows of the named entities, as the fold's entities. */
async function loadCacheState(
  driver: SqlDriver,
  keys: Record<Entity, ReadonlySet<string>>,
): Promise<StampedState> {
  const state: StampedState = { blocks: new Map(), links: new Map(), views: new Map() }
  const tables = { block: state.blocks, link: state.links, view: state.views } as unknown as Record<
    Entity,
    Map<string, ReturnType<typeof entityOfRow>>
  >
  for (const entity of Object.keys(keys) as Entity[]) {
    for (const ids of inChunks([...keys[entity]])) {
      const where = whereKeys(entity, ids)
      const rows = await driver.exec(
        `SELECT * FROM ${CACHE_TABLES[entity].table} WHERE ${where.sql} ` +
          "/* includes-deleted: the fold holds tombstones */",
        where.params,
      )
      for (const row of rows)
        tables[entity].set(entityIdOfRow(entity, row), entityOfRow(entity, row))
    }
  }
  return state
}

/**
 * The statements that bring the cache rows of the entities `events` names
 * up to them: each row read, the events applied by stamp (`foldByStamp`),
 * and the row written back. They go in the same batch as the append, so the
 * log and the cache move together or not at all.
 */
async function cacheStatements(
  driver: SqlDriver,
  events: readonly KeyEvent[],
): Promise<SqlStatement[]> {
  if (events.length === 0) return []
  const keys = keysOfEvents(events)
  const state = foldKeysByStamp(events, await loadCacheState(driver, keys))
  const tables = { block: state.blocks, link: state.links, view: state.views }
  const statements: SqlStatement[] = []
  for (const entity of Object.keys(keys) as Entity[]) {
    const table = tables[entity] as Map<string, Parameters<typeof cacheRowStatements>[1][0][1]>
    const entries = [...keys[entity]].flatMap((id) => {
      const value = table.get(id)
      return value ? [[id, value] as const] : []
    })
    statements.push(...cacheRowStatements(entity, entries))
  }
  return statements
}

/** The fold of the log (`foldKeysByStamp`): of the named entities' events,
 * by the `events_log_entity` index, or of the whole log, in the old shape
 * with each block's props assembled (`assembleStamped`). What the fold
 * check compares the cache with. */
async function loadFoldOfLog(driver: SqlDriver, keys?: EntityKeys): Promise<StampedState> {
  const events: KeyEvent[] = []
  const take = (rows: Record<string, SqlValue>[]) => {
    for (const row of rows) {
      const event = toEvent(row)
      if (event !== null) events.push(event)
    }
  }
  if (!keys) {
    take(await driver.exec(`SELECT ${EVENT_COLUMNS} FROM events_log`))
    return assembleStamped(foldKeysByStamp(events))
  }
  const named: [Entity, ReadonlySet<string>][] = [
    ["block", keys.blocks],
    ["link", keys.links],
    ["view", keys.views],
  ]
  for (const [entity, ids] of named) {
    for (const chunk of inChunks([...ids])) {
      take(
        await driver.exec(
          `SELECT ${EVENT_COLUMNS} FROM events_log WHERE entity = ? AND entity_id IN ` +
            `(${chunk.map(() => "?").join(", ")})`,
          [entity, ...chunk],
        ),
      )
    }
  }
  return assembleStamped(foldKeysByStamp(events))
}

/** The `block_values` rows of the named blocks (`NoteStore.getBlockValuesOf`). */
async function loadBlockValuesOf(
  driver: SqlDriver,
  ids: readonly string[],
): Promise<BlockValueRow[]> {
  const out: BlockValueRow[] = []
  for (const chunk of inChunks([...new Set(ids)])) {
    const rows = await driver.exec(
      "SELECT block_id, key, value, hlc, seq, updated_at FROM block_values WHERE block_id IN " +
        `(${chunk.map(() => "?").join(", ")})`,
      chunk,
    )
    for (const row of rows) {
      out.push({
        block_id: String(row.block_id),
        key: String(row.key),
        value: row.value === null ? null : String(row.value),
        hlc: String(row.hlc),
        ...(row.seq === null ? {} : { seq: Number(row.seq) }),
        updated_at: Number(row.updated_at),
      })
    }
  }
  return out
}

/** Every cache row of the named entities, tombstones too, as the replica's
 * rows look (`NoteStore.getRowsOf`). */
async function loadRowsOf(
  driver: SqlDriver,
  keys: EntityKeys,
): Promise<{ nodes: NodeRow[]; links: LinkRow[]; views: ViewRow[] }> {
  const read = async <R>(
    entity: Entity,
    ids: ReadonlySet<string>,
    map: (row: Record<string, SqlValue>) => R,
  ) => {
    const out: R[] = []
    for (const chunk of inChunks([...ids])) {
      const where = whereKeys(entity, chunk)
      const rows = await driver.exec(
        `SELECT * FROM ${CACHE_TABLES[entity].table} WHERE ${CREATED} AND (${where.sql}) ` +
          "/* includes-deleted: compared with the replica's rows, tombstones too */",
        where.params,
      )
      out.push(...rows.map(map))
    }
    return out
  }
  return {
    nodes: await read("block", keys.blocks, toNodeRow),
    links: await read("link", keys.links, toLinkRow),
    views: await read("view", keys.views, toViewRow),
  }
}

const ORDER_LINKS = " ORDER BY sort_key, destination_id"

/** Live rows by one column, in chunks: the lazy reads of the walk. */
async function readChunked<R>(
  driver: SqlDriver,
  ids: readonly string[],
  base: string,
  column: string,
  map: (row: Record<string, SqlValue>) => R,
  order = "",
): Promise<R[]> {
  const out: R[] = []
  for (const chunk of inChunks([...new Set(ids)])) {
    const kind = base === LIVE_LINKS ? ` AND kind = '${CHILD_KIND}'` : ""
    const rows = await driver.exec(
      `${base} AND ${column} IN (${chunk.map(() => "?").join(", ")})${kind}${order}`,
      chunk,
    )
    out.push(...rows.map(map))
  }
  return out
}

/** Fill the stamps of rows from before the cache, once (`CACHE_STAMPS_KEY`).
 * The flag is set in the same transaction as the fill. */
async function fillStampsOnce(driver: SqlDriver, now: number): Promise<void> {
  const [flag] = await driver.exec("SELECT value FROM meta WHERE key = ?", [CACHE_STAMPS_KEY])
  if (flag) return
  await driver.batch([
    ...fillStampsStatements(),
    {
      sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
      params: [CACHE_STAMPS_KEY, String(now)],
    },
  ])
}

/**
 * The position the next event takes, worked out by the statement that writes
 * it: the log's append order, which the push queue and the history keep.
 */
const NEXT_POSITION = "(SELECT COALESCE(MAX(position), 0) + 1 FROM events_log)"

/** A key event's columns, in the order the inserts name them. */
const eventParams = (event: KeyEvent): SqlValue[] => [
  event.id,
  event.entity,
  event.entity_id,
  event.action,
  event.key,
  JSON.stringify(event.value ?? null),
  event.v,
  event.batch,
  event.device,
  event.cause ?? null,
  event.base_seq ?? null,
  event.ref_seq ?? null,
  event.at,
  event.tz ?? null,
  event.hlc ?? null,
  event.event ?? null,
  event.event_seq ?? null,
]

/** A pulled event, placed, at the next position. One of this device's own
 * that the replica took but never answered is placed by this, and moves to
 * that position as `markEventsPushed` would move it; one already placed stays. */
const insertPulledEventStatement = (event: LoggedKeyEvent): SqlStatement => ({
  sql:
    "INSERT INTO events_log (id, entity, entity_id, action, key, value, v, batch, device, " +
    "cause, base_seq, ref_seq, at, tz, hlc, event_id, event_seq, seq, origin, actor, " +
    "received_at, position) " +
    `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_POSITION}) ` +
    "ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, event_id = excluded.event_id, " +
    "event_seq = excluded.event_seq, origin = excluded.origin, " +
    "actor = excluded.actor, received_at = excluded.received_at, " +
    "position = CASE WHEN events_log.seq IS NULL THEN excluded.position " +
    "ELSE events_log.position END",
  params: [
    ...eventParams(event),
    event.seq,
    event.origin ?? null,
    event.actor ?? null,
    event.received_at ?? null,
  ],
})

const insertEventStatement = (event: KeyEvent): SqlStatement => ({
  sql:
    "INSERT INTO events_log (id, entity, entity_id, action, key, value, v, batch, device, " +
    "cause, base_seq, ref_seq, at, tz, hlc, event_id, event_seq, seq, position) " +
    `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ${NEXT_POSITION})`,
  params: eventParams(event),
})

// -----------------------------------------------------------------------------
// The pull: the replica's rows, verbatim
// -----------------------------------------------------------------------------

/** Upsert one view row, last-writer-wins, as the replica does. A delete is a
 * row carrying `deleted_at`, so it goes through here too. */
function upsertViewStatement(view: ViewRow): SqlStatement {
  return {
    // tenant-exempt: the local store is one user per browser profile; there is
    // no second tenant in an OPFS database (src/data/corpus-schema.ts).
    sql:
      "INSERT INTO views (id, root_id, filter, sort, pinned, sort_key, stack, updated_at, " +
      "deleted_at, seq, stamps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (id) DO UPDATE SET root_id = excluded.root_id, filter = excluded.filter, " +
      "sort = excluded.sort, pinned = excluded.pinned, sort_key = excluded.sort_key, " +
      "stack = excluded.stack, updated_at = excluded.updated_at, " +
      "deleted_at = excluded.deleted_at, seq = excluded.seq, " +
      "stamps = excluded.stamps WHERE excluded.updated_at >= views.updated_at",
    params: [
      view.id,
      view.root_id,
      view.filter,
      view.sort,
      view.pinned ? 1 : 0,
      view.sort_key,
      view.stack ?? null,
      view.updated_at,
      view.deleted_at ?? null,
      view.seq ?? null,
      derivedStamps("view", view),
    ],
  }
}

const upsertNodeStatement = (node: NodeRow): SqlStatement => ({
  sql:
    "INSERT INTO nodes (id, type, text, props, updated_at, deleted_at, notes_id, seq, stamps) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (id) DO UPDATE SET type = excluded.type, text = excluded.text, " +
    "props = excluded.props, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, " +
    // A note id is set once and never cleared by a row that carries none.
    "notes_id = COALESCE(excluded.notes_id, nodes.notes_id), seq = excluded.seq, " +
    "stamps = excluded.stamps",
  params: [
    node.id,
    node.type,
    node.text,
    node.props,
    node.updated_at,
    node.deleted_at ?? null,
    node.notes_id ?? null,
    node.seq ?? null,
    derivedStamps("block", node),
  ],
})

const upsertLinkStatement = (link: LinkRow): SqlStatement => ({
  sql:
    "INSERT INTO link (source_id, destination_id, kind, sort_key, updated_at, deleted_at, seq, " +
    "stamps) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT (source_id, destination_id, kind) DO UPDATE SET " +
    "sort_key = excluded.sort_key, updated_at = excluded.updated_at, " +
    "deleted_at = excluded.deleted_at, seq = excluded.seq, stamps = excluded.stamps",
  params: [
    link.source_id,
    link.destination_id,
    link.kind,
    link.sort_key,
    link.updated_at,
    link.deleted_at ?? null,
    link.seq ?? null,
    derivedStamps("link", link),
  ],
})
