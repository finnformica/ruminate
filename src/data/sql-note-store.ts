import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import {
  cacheWinners,
  foldCacheRows,
  GROUPED_COLUMNS,
  LIVE_FIELDS,
  rowsOfGrouped,
  type CacheEntity,
  type CacheRow,
} from "./cache-rows"
import { ensureCorpusSchema } from "./corpus-schema"
import type { EntityKeys } from "./events"
import { CHILD_KIND, buildGraphSnapshot } from "./graph"
import {
  coalesceTypingKeys,
  parseStoredKeyEvent,
  type KeyEvent,
  type LoggedKeyEvent,
} from "./key-events"
import type { NoteStore } from "./note-store"
import type { SqlDriver, SqlStatement, SqlValue } from "./sql-driver"
import { createLazyReads } from "./sql-lazy-reads"

/**
 * The SQL implementation of `NoteStore` — the store the app runs on: the
 * device's log (`events_log`, docs/event-sourcing.md) and the cache of its
 * fold (`events_log_cache`, docs/events-log-cache.md), the same two tables
 * the replica holds, without the tenant column.
 *
 * Backed by any `SqlDriver` (sqlite-wasm/OPFS in the browser, `node:sqlite`
 * in tests) and the exact migration files that initialize the D1 replica —
 * in the **single-tenant** shape (`corpus-schema.ts`): one user per browser
 * profile, so no `user_id` column.
 *
 * **The log is the truth; the cache is its fold, key by key.** A write
 * arrives as the per-key events the editor's ops amount to
 * (`opsToKeyEvents`), and a pull as the per-key events of the replica's
 * log. Each lands in one transaction: appended to `events_log`, and
 * upserted into the cache row of each register it sets, under a higher
 * stamp only (`WHERE excluded.hlc > hlc`). There is no read before the
 * write and nothing is folded again: the cache is the fold of its
 * entity's events, in any order, and an event applied twice changes
 * nothing. A read groups an entity's rows (`GROUPED_COLUMNS`,
 * `rowsOfGrouped`): the whole live graph in one statement at boot, the
 * touched entities after a batch.
 *
 * **Soft deletes.** Nothing here hard-deletes an entity. A delete sets its
 * `deleted` row to the tombstone's clock; reads leave a tombstoned entity
 * out, and a link with a tombstoned end (`buildGraphSnapshot`), so deletes
 * never cascade at write time and a link to a deleted node survives as the
 * position a restore would put it back into.
 */

/**
 * Open a `NoteStore` on `driver`, applying the migrations when the database is
 * empty. The ladder itself lives in `corpus-schema.ts`, shared with the D1
 * corpus; its v18 step is this store's shape.
 */
export async function openSqlNoteStore(driver: SqlDriver): Promise<NoteStore> {
  await ensureCorpusSchema(driver, { init: migration0001, nodes: migration0002 }, "single")

  return {
    getGraph: async () => {
      const { nodes, links } = rowsOfGrouped(await driver.exec(LIVE_GRAPH), { live: true })
      return buildGraphSnapshot(nodes, links)
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
      statements.push(...upsertStatements(cacheWinners(appended)))
      if (statements.length > 0) await driver.batch(statements)
    },

    unpushedEvents: () => loadUnpushed(driver),

    markEventsPushed: async (seqs) => {
      if (seqs.length === 0) return
      const statements: SqlStatement[] = []
      for (const [id, seq] of seqs) {
        // A placed event moves to the end of the log's append order.
        statements.push({
          sql: `UPDATE events_log SET seq = ?, position = ${NEXT_POSITION} WHERE id = ?`,
          params: [seq, id],
        })
        // The row the event set — still at its stamp — takes its place in
        // the log, never backwards.
        statements.push({
          sql:
            "UPDATE events_log_cache SET seq = ?1 WHERE (seq IS NULL OR seq < ?1) " +
            "AND (entity, entity_id, key, hlc) = (SELECT entity, entity_id, " +
            "CASE WHEN action IN ('set', 'unset') THEN key ELSE 'deleted' END, hlc " +
            "FROM events_log WHERE id = ?2) " +
            "/* includes-deleted: a placed tombstone takes its seq too */",
          params: [seq, id],
        })
      }
      await driver.batch(statements)
    },

    applyPulledEvents: async (events) => {
      if (events.length === 0) return
      await driver.batch([
        ...events.map(insertPulledEventStatement),
        ...upsertStatements(cacheWinners(events)),
      ])
    },

    eventLog: () => loadLog(driver),

    foldOfLog: (keys) => loadFoldOfLog(driver, keys),

    cacheRowsOf: (keys) => loadCacheRows(driver, keys),

    liveEntitiesOf: (keys) => loadLiveEntities(driver, keys),

    getAllRows: async () => rowsOfGrouped(await driver.exec(ALL_ENTITIES)),

    importCacheRows: async (rows) => {
      if (rows.length === 0) return
      await driver.batch(upsertStatements(rows))
    },

    applyUnpushedToCache: async () => {
      const statements = upsertStatements(cacheWinners(await loadUnpushed(driver)))
      if (statements.length > 0) await driver.batch(statements)
    },

    rebuildCacheFromLog: async () => {
      // An unpushed event reads with a provisional seq (`loadLog`); its
      // cache row has none until the push lands.
      const events = (await loadLog(driver)).map((event) => {
        if (!event.pending) return event
        const { seq: _provisional, pending: _pending, ...unpushed } = event
        return unpushed
      })
      const rows = [...foldCacheRows(cacheWinners(events)).values()]
      await driver.batch([
        // tenant-exempt: a cache rebuild from the device's own log, not a
        // delete of anything that happened.
        { sql: "DELETE FROM events_log_cache" },
        ...upsertStatements(rows),
      ])
    },

    clearCache: async () => {
      // tenant-exempt: the cache is re-pulled; the log stays.
      await driver.batch([{ sql: "DELETE FROM events_log_cache" }])
    },

    clear: async () => {
      await driver.batch([
        // tenant-exempt: a cache reset of the local store, which is one user
        // per browser profile — nothing is tombstoned, so nothing replicates.
        { sql: "DELETE FROM events_log_cache" },
        // The device's log goes with the rows it describes: a wiped cache
        // pulls the tenant's log again from the start, this device's own
        // placed events among it.
        { sql: "DELETE FROM events_log" },
      ])
    },

    lazy: createLazyReads(driver),

    getMeta: async (key) => {
      const rows = await driver.exec("SELECT value FROM meta WHERE key = ?", [key])
      return rows.length ? String(rows[0].value) : null
    },

    setMeta: async (key, value) => {
      await driver.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value])
    },

    close: () => driver.close(),
  }
}

// -----------------------------------------------------------------------------
// Reads: an entity is the group of its rows
// -----------------------------------------------------------------------------

/** The grouped read of every row of an entity with a value: an unset key
 * has none and is left out of the group. */
const GROUPED =
  `SELECT ${GROUPED_COLUMNS("c")} FROM events_log_cache c WHERE c.value IS NOT NULL ` +
  "GROUP BY c.entity, c.entity_id " +
  "/* includes-deleted: every entity grouped; the reads below keep the live ones ($.deleted) */"

/** The LIVE graph — what the snapshot is built from: every created entity
 * whose `deleted` row says `null`. A link with a tombstoned end is read and
 * dropped by `buildGraphSnapshot`, which does not see the tombstone's row:
 * only the live ones are read, so a link whose end is missing is dropped. */
const LIVE_GRAPH = `SELECT * FROM (${GROUPED}) WHERE ${LIVE_FIELDS("fields")}`

/** Every created entity, tombstones included. */
const ALL_ENTITIES =
  `SELECT * FROM (${GROUPED}) WHERE json_type(fields, '$.deleted') IS NOT NULL ` +
  "/* includes-deleted: Recently deleted and the full push read tombstones too */"

/** Keys in one statement: well under SQLite's bound on parameters. */
const KEYS_PER_READ = 300

const inChunks = <T>(items: readonly T[]) =>
  Array.from({ length: Math.ceil(items.length / KEYS_PER_READ) }, (_, i) =>
    items.slice(i * KEYS_PER_READ, (i + 1) * KEYS_PER_READ),
  )

/** The live entities of one kind among `ids`, grouped. */
async function liveByIds(
  driver: SqlDriver,
  entity: CacheEntity,
  ids: readonly string[],
): Promise<Record<string, SqlValue>[]> {
  const out: Record<string, SqlValue>[] = []
  for (const chunk of inChunks([...new Set(ids)])) {
    out.push(
      ...(await driver.exec(
        `SELECT * FROM (SELECT ${GROUPED_COLUMNS("c")} FROM json_each(?) AS j ` +
          "CROSS JOIN events_log_cache c ON c.entity = ? AND c.entity_id = j.value " +
          `WHERE c.value IS NOT NULL GROUP BY c.entity, c.entity_id) WHERE ${LIVE_FIELDS("fields")} ` +
          "/* includes-deleted: grouped, then only the live ones kept ($.deleted) */",
        [JSON.stringify(chunk), entity],
      )),
    )
  }
  return out
}

/** The ids of the live links adjacent to these blocks, by the `source_id`
 * and `destination_id` indexes. */
async function adjacentLinkIds(driver: SqlDriver, blockIds: readonly string[]): Promise<string[]> {
  const out = new Set<string>()
  for (const chunk of inChunks([...new Set(blockIds)])) {
    for (const key of ["source_id", "destination_id"]) {
      const rows = await driver.exec(
        "SELECT s.entity_id FROM json_each(?) AS j " +
          `CROSS JOIN events_log_cache s ON s.key = '${key}' AND s.value = json_quote(j.value) ` +
          "CROSS JOIN events_log_cache d ON d.entity = 'link' AND d.entity_id = s.entity_id " +
          "AND d.key = 'deleted' AND d.value = 'null'",
        [JSON.stringify(chunk)],
      )
      for (const row of rows) out.add(String(row.entity_id))
    }
  }
  return [...out]
}

/** What a patch of the graph needs (`NoteStore.liveEntitiesOf`). */
async function loadLiveEntities(
  driver: SqlDriver,
  keys: EntityKeys,
): Promise<{ nodes: NodeRow[]; links: LinkRow[] }> {
  const blockIds = [...keys.blocks]
  const linkIds = [...new Set([...keys.links, ...(await adjacentLinkIds(driver, blockIds))])]
  const nodes = rowsOfGrouped(await liveByIds(driver, "block", blockIds), { live: true }).nodes
  const links = rowsOfGrouped(await liveByIds(driver, "link", linkIds), { live: true }).links
  return { nodes, links: links.filter((link) => link.kind === CHILD_KIND) }
}

const toCacheRow = (raw: Record<string, SqlValue>): CacheRow => ({
  entity: String(raw.entity) as CacheEntity,
  entity_id: String(raw.entity_id),
  key: String(raw.key),
  value: raw.value === null || raw.value === undefined ? null : String(raw.value),
  hlc: String(raw.hlc),
  seq: raw.seq === null || raw.seq === undefined ? null : Number(raw.seq),
  updated_at: Number(raw.updated_at),
})

/** The cache rows of the named entities, every key (`NoteStore.cacheRowsOf`). */
async function loadCacheRows(driver: SqlDriver, keys: EntityKeys): Promise<CacheRow[]> {
  const out: CacheRow[] = []
  const named: [CacheEntity, ReadonlySet<string>][] = [
    ["block", keys.blocks],
    ["link", keys.links],
  ]
  for (const [entity, ids] of named) {
    for (const chunk of inChunks([...ids])) {
      const rows = await driver.exec(
        "SELECT c.entity, c.entity_id, c.key, c.value, c.hlc, c.seq, c.updated_at " +
          "FROM json_each(?) AS j CROSS JOIN events_log_cache c ON c.entity = ? " +
          "AND c.entity_id = j.value /* includes-deleted: the fold holds tombstones */",
        [JSON.stringify(chunk), entity],
      )
      out.push(...rows.map(toCacheRow))
    }
  }
  return out
}

// -----------------------------------------------------------------------------
// The device's log
// -----------------------------------------------------------------------------

const EVENT_COLUMNS =
  "id, seq, entity, entity_id, action, key, value, v, batch, device, cause, base_seq, ref_seq, " +
  "at, tz, hlc, event_id, event_seq"

/** A stored row as a key event, placed when it is; null (reported) for a
 * row that is not one. */
const toEvent = (row: Record<string, SqlValue>): LoggedKeyEvent | null =>
  parseStoredKeyEvent(row as Record<string, unknown>)

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

/** The fold of the log by stamp (`foldEventsToCache`): of the named
 * entities' events, read by the `events_log_entity` index, or of the whole
 * log. What the fold check compares the cache with. An unpushed event has
 * no `seq`, as its cache row has none. */
async function loadFoldOfLog(driver: SqlDriver, keys?: EntityKeys): Promise<Map<string, CacheRow>> {
  const events: KeyEvent[] = []
  const take = (rows: Record<string, SqlValue>[]) => {
    for (const row of rows) {
      const event = toEvent(row)
      if (event === null) continue
      // An unpushed event has no seq, as its cache row has none.
      if (row.seq === null) {
        const { seq: _unplaced, ...unpushed } = event
        events.push(unpushed)
      } else events.push(event)
    }
  }
  if (!keys) {
    take(await driver.exec(`SELECT ${EVENT_COLUMNS} FROM events_log`))
  } else {
    const named: [CacheEntity, ReadonlySet<string>][] = [
      ["block", keys.blocks],
      ["link", keys.links],
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
  }
  return foldCacheRows(cacheWinners(events))
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

/** Rows per upsert: seven columns each, well under the parameter bound. */
const ROWS_PER_WRITE = 500

/**
 * The upsert of cache rows by stamp: each lands only above the stamp its
 * register holds — the one rule every write to the cache follows, on the
 * replica too (`CACHE_UPSERT`, worker/handlers/event-log.ts). One
 * multi-row statement per `ROWS_PER_WRITE` rows.
 */
function upsertStatements(rows: readonly CacheRow[]): SqlStatement[] {
  const statements: SqlStatement[] = []
  for (let i = 0; i < rows.length; i += ROWS_PER_WRITE) {
    const chunk = rows.slice(i, i + ROWS_PER_WRITE)
    statements.push({
      sql:
        "INSERT INTO events_log_cache (entity, entity_id, key, value, hlc, seq, updated_at) " +
        `VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")} ` +
        "ON CONFLICT (entity, entity_id, key) DO UPDATE SET value = excluded.value, " +
        "hlc = excluded.hlc, seq = excluded.seq, updated_at = excluded.updated_at " +
        "WHERE excluded.hlc > events_log_cache.hlc",
      params: chunk.flatMap((row) => [
        row.entity,
        row.entity_id,
        row.key,
        row.value,
        row.hlc,
        row.seq,
        row.updated_at,
      ]),
    })
  }
  return statements
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
