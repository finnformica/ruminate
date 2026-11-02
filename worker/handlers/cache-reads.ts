// Reads of the cache of the log (docs/events-log-cache.md): the statements
// every reader of a block or a link in the Worker goes through, over
// `events_log_cache`. Each is written out in full — the guard checks the
// string that runs (src/data/sql-tenancy-guard.ts), so the string that runs
// is the one a reader sees — and each reads an entity as the GROUP of its
// rows (`GROUPED_COLUMNS`, `json_group_object`), one row per entity, which
// `src/data/cache-rows.ts` assembles into the row shapes the app reads.
//
// Two rules every statement here obeys, as the MCP loaders' and the share
// slice's do:
//
// 1. **Tenancy**: `user_id` + `:tenant`, on every table reference.
// 2. **Liveness is the `deleted` key**: a read of live entities says so in
//    its own text (`json_type(fields, '$.deleted') = 'null'`, which is
//    `LIVE_FIELDS` of src/data/cache-rows.ts spelled out, so the CI scan of
//    each literal sees it); a read that carries tombstones says that instead.
//
// A read of many entities by id is driven FROM `json_each` of the ids
// (`CROSS JOIN`, so the ids are the outer loop and each entity is one
// primary-key seek), which also keeps a long list under D1's bound of 100
// parameters: the ids travel as one.

import {
  GROUPED_COLUMNS,
  groupedEntity,
  type CacheEntity,
  type CacheEntityState,
  type CacheRow,
} from "../../src/data/cache-rows"
import type { SqlValue } from "../../src/data/sql-driver"
import type { TenantDb } from "../tenancy-db"

/** The grouped read of every row of an entity: the rows with a value
 * (an unset key has none and is left out of the group). */
const GROUPED = GROUPED_COLUMNS("c")

const toRow = (raw: Record<string, SqlValue>): CacheRow => ({
  entity: String(raw.entity) as CacheEntity,
  entity_id: String(raw.entity_id),
  key: String(raw.key),
  value: raw.value === null || raw.value === undefined ? null : String(raw.value),
  hlc: String(raw.hlc),
  seq: raw.seq === null || raw.seq === undefined ? null : Number(raw.seq),
  updated_at: Number(raw.updated_at),
})

/** Every entity the tenant holds, grouped, tombstones included: the
 * whole corpus, for the whole-corpus readers (`loadSnapshot`, the full pull
 * served to a build before the cache, verify). */
export async function readAllEntities(tenant: TenantDb): Promise<CacheEntityState[]> {
  const rows = await tenant
    .includingDeleted()
    .exec(
      `SELECT ${GROUPED} FROM events_log_cache c WHERE c.user_id = :tenant ` +
        "AND c.value IS NOT NULL GROUP BY c.entity, c.entity_id " +
        "/* includes-deleted: the whole corpus, tombstones too */ " +
        "/* reads-corpus: a whole-corpus reader by design */",
    )
  return rows.map(groupedEntity)
}

/** The named LIVE entities of one kind, grouped. */
export async function readLiveEntitiesByIds(
  tenant: TenantDb,
  entity: CacheEntity,
  ids: readonly string[],
): Promise<CacheEntityState[]> {
  if (ids.length === 0) return []
  const rows = await tenant.exec(
    `SELECT * FROM (SELECT ${GROUPED} FROM json_each(?1) AS j ` +
      "CROSS JOIN events_log_cache c ON c.user_id = :tenant AND c.entity = ?2 " +
      "AND c.entity_id = j.value WHERE c.value IS NOT NULL " +
      "GROUP BY c.entity, c.entity_id) WHERE json_type(fields, '$.deleted') = 'null'",
    [JSON.stringify([...new Set(ids)]), entity],
  )
  return rows.map(groupedEntity)
}

/** The rows, not grouped, of the named entities of one kind, every key with
 * its stamp: what a write is diffed and judged stale against
 * (`readCurrent`, event-log.ts). Tombstones and keys no create has reached
 * included: a write lands over the row as it stands. */
export async function readRowsByIds(
  tenant: TenantDb,
  entity: CacheEntity,
  ids: readonly string[],
): Promise<CacheRow[]> {
  if (ids.length === 0) return []
  const rows = await tenant
    .includingDeleted()
    .exec(
      "SELECT c.entity, c.entity_id, c.key, c.value, c.hlc, c.seq, c.updated_at " +
        "FROM json_each(?1) AS j CROSS JOIN events_log_cache c ON c.user_id = :tenant " +
        "AND c.entity = ?2 AND c.entity_id = j.value " +
        "/* includes-deleted: a write is diffed against the rows as they stand */",
      [JSON.stringify([...new Set(ids)]), entity],
    )
  return rows.map(toRow)
}

/** The live notes: every block whose `type` is one of `types`, grouped. On
 * the `type` index. */
export async function readLiveNotes(
  tenant: TenantDb,
  types: readonly string[],
): Promise<CacheEntityState[]> {
  const rows = await tenant.exec(
    `SELECT * FROM (SELECT ${GROUPED} FROM json_each(?1) AS j ` +
      "CROSS JOIN events_log_cache t ON t.user_id = :tenant AND t.key = 'type' " +
      "AND t.value = json_quote(j.value) " +
      "CROSS JOIN events_log_cache c ON c.user_id = :tenant AND c.entity = 'block' " +
      "AND c.entity_id = t.entity_id WHERE c.value IS NOT NULL " +
      "GROUP BY c.entity, c.entity_id) WHERE json_type(fields, '$.deleted') = 'null'",
    [JSON.stringify([...types])],
  )
  return rows.map(groupedEntity)
}

/** The live blocks written in a note (`notes_id`), grouped. On the
 * `notes_id` index. */
export async function readLiveWrittenIn(
  tenant: TenantDb,
  noteId: string,
): Promise<CacheEntityState[]> {
  const rows = await tenant.exec(
    `SELECT * FROM (SELECT ${GROUPED} FROM events_log_cache n ` +
      "CROSS JOIN events_log_cache c ON c.user_id = :tenant AND c.entity = 'block' " +
      "AND c.entity_id = n.entity_id " +
      "WHERE n.user_id = :tenant AND n.key = 'notes_id' AND n.value = json_quote(?1) " +
      "AND c.value IS NOT NULL " +
      "GROUP BY c.entity, c.entity_id) WHERE json_type(fields, '$.deleted') = 'null'",
    [noteId],
  )
  return rows.map(groupedEntity)
}

/**
 * One hop DOWN from the rows of `v` (a column `id`): the live child links
 * out of each (`s`, the link's `source_id` row) and the live node at the far
 * end (`d`, its `destination_id` row). The hop the MCP loaders take
 * (`worker/mcp/graph-load.ts`), spelled out here so the guard's scan of this
 * file sees the statement that runs.
 */
const HOP_DOWN =
  "CROSS JOIN events_log_cache s ON s.user_id = :tenant AND s.key = 'source_id' " +
  "AND s.value = json_quote(v.id) AND s.entity_id GLOB '*|child' " +
  "CROSS JOIN events_log_cache ld ON ld.user_id = :tenant AND ld.entity = 'link' " +
  "AND ld.entity_id = s.entity_id AND ld.key = 'deleted' AND ld.value = 'null' " +
  "CROSS JOIN events_log_cache d ON d.user_id = :tenant AND d.entity = 'link' " +
  "AND d.entity_id = s.entity_id AND d.key = 'destination_id' " +
  "CROSS JOIN events_log_cache fd ON fd.user_id = :tenant AND fd.entity = 'block' " +
  "AND fd.entity_id = json_extract(d.value, '$') AND fd.key = 'deleted' AND fd.value = 'null' "

/**
 * The rows of the first screen, not grouped: what a device whose cache is
 * empty takes before the snapshot (`GET /api/replica/first-screen`,
 * docs/events-log-cache.md, "Sync is the log"), the same read the device
 * makes of its own cache at boot (`LazyReads.rootView`,
 * src/data/sql-lazy-reads.ts) — the live notes (every block whose `type`
 * is one of `types`), the corpus root and its live child links (the notes'
 * order), one preview child per note (the first in sibling order, which an
 * untitled note is named by) with its link, and the pinned nodes. Every
 * row of each, tombstoned keys included, as the snapshot carries them: the
 * device imports them as rows. Cost: the notes, not the blocks.
 */
export async function readFirstScreenRows(
  tenant: TenantDb,
  types: readonly string[],
  rootId: string,
): Promise<CacheRow[]> {
  const columns = "c.entity, c.entity_id, c.key, c.value, c.hlc, c.seq, c.updated_at"
  const rows = await tenant.includingDeleted().exec(
    // The live notes, on the `type` index.
    "WITH notes (id) AS (SELECT t.entity_id FROM json_each(?1) AS j " +
      "CROSS JOIN events_log_cache t ON t.user_id = :tenant AND t.key = 'type' " +
      "AND t.value = json_quote(j.value) " +
      "CROSS JOIN events_log_cache l ON l.user_id = :tenant AND l.entity = 'block' " +
      "AND l.entity_id = t.entity_id AND l.key = 'deleted' AND l.value = 'null'), " +
      // The root and its order: one hop down from it.
      "root (id) AS (SELECT ?2), " +
      "root_edges (link_id) AS (SELECT s.entity_id " +
      `FROM root v ${HOP_DOWN}), ` +
      // One preview child per note: the window picks the first by sort key.
      "hops (link_id, far, src, sort_key) AS (SELECT s.entity_id, " +
      "json_extract(d.value, '$'), v.id, json_extract(k.value, '$') " +
      `FROM notes v ${HOP_DOWN} CROSS JOIN events_log_cache k ON k.user_id = :tenant ` +
      "AND k.entity = 'link' AND k.entity_id = s.entity_id AND k.key = 'sort_key'), " +
      "previews (link_id, far) AS (SELECT link_id, far FROM (SELECT link_id, far, " +
      "ROW_NUMBER() OVER (PARTITION BY src ORDER BY sort_key, far) AS rn FROM hops) " +
      "WHERE rn = 1), " +
      // The pinned nodes, on the `props.pinned_at` index (0033).
      "pinned (id) AS (SELECT p.entity_id FROM events_log_cache p " +
      "WHERE p.user_id = :tenant AND p.key = 'props.pinned_at' AND p.value IS NOT NULL), " +
      // The blocks and the links of the screen: four terms, then two.
      "blocks (id) AS (SELECT id FROM notes UNION SELECT id FROM root " +
      "UNION SELECT far FROM previews UNION SELECT id FROM pinned), " +
      "links (id) AS (SELECT link_id FROM root_edges UNION SELECT link_id FROM previews) " +
      `SELECT ${columns} FROM blocks b CROSS JOIN events_log_cache c ` +
      "ON c.user_id = :tenant AND c.entity = 'block' AND c.entity_id = b.id " +
      "UNION ALL " +
      `SELECT ${columns} FROM links lk CROSS JOIN events_log_cache c ` +
      "ON c.user_id = :tenant AND c.entity = 'link' AND c.entity_id = lk.id " +
      "/* includes-deleted: the device imports the rows as the snapshot carries them; " +
      "the hops crossed live links to live nodes only, and a pinned tombstone is kept " +
      "out by the device ($.deleted) */",
    [JSON.stringify([...types]), rootId],
  )
  return rows.map(toRow)
}

/**
 * One page of the cache, in primary-key order, after `after` (the key of
 * the last row of the page before, or null for the first): what a new
 * device takes before it pulls the log (docs/events-log-cache.md, "Sync").
 * Keyset-paged, never by offset, so a row written between two pages is in
 * a later page or in the log; cache rows are never deleted, so a page
 * misses nothing.
 */
export async function readCachePage(
  tenant: TenantDb,
  after: readonly [entity: string, entityId: string, key: string] | null,
  limit: number,
): Promise<CacheRow[]> {
  const columns = "c.entity, c.entity_id, c.key, c.value, c.hlc, c.seq, c.updated_at"
  const rows =
    after === null
      ? await tenant
          .includingDeleted()
          .exec(
            `SELECT ${columns} FROM events_log_cache c WHERE c.user_id = :tenant ` +
              "ORDER BY c.entity, c.entity_id, c.key LIMIT ?1 " +
              "/* includes-deleted: a snapshot carries every row, tombstones too */ " +
              "/* reads-corpus: the snapshot a new device takes */",
            [limit],
          )
      : await tenant
          .includingDeleted()
          .exec(
            `SELECT ${columns} FROM events_log_cache c WHERE c.user_id = :tenant ` +
              "AND (c.entity, c.entity_id, c.key) > (?1, ?2, ?3) " +
              "ORDER BY c.entity, c.entity_id, c.key LIMIT ?4 " +
              "/* includes-deleted: a snapshot carries every row, tombstones too */ " +
              "/* reads-corpus: the snapshot a new device takes */",
            [after[0], after[1], after[2], limit],
          )
  return rows.map(toRow)
}

/** Every row of the cache, paged (`readCachePage`): what verify compares
 * the fold of the log with. */
export async function readAllCacheRows(tenant: TenantDb, page = 20_000): Promise<CacheRow[]> {
  const out: CacheRow[] = []
  let after: readonly [string, string, string] | null = null
  for (;;) {
    const rows = await readCachePage(tenant, after, page)
    out.push(...rows)
    if (rows.length < page) return out
    const last = rows[rows.length - 1]
    after = [last.entity, last.entity_id, last.key]
  }
}

/** The tenant's watermark (`meta.cache_seq`): the seq of the last log row
 * the cache has projected; 0 before the first. */
export async function cacheSeqOf(tenant: TenantDb): Promise<number> {
  const [row] = await tenant.exec(
    "SELECT value FROM meta WHERE user_id = :tenant AND key = 'cache_seq'",
  )
  const value = row === undefined ? null : row.value
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0
}
