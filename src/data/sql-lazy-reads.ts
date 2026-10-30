import { GROUPED_COLUMNS, LIVE_FIELDS, rowsOfGrouped } from "./cache-rows"
import { CORPUS_ROOT_ID, NOTE_TYPES } from "./graph"
import type { GraphFragment } from "./graph-patch"
import type { SqlDriver, SqlValue } from "./sql-driver"

/**
 * The lazy reads of the graph (docs/events-log-cache.md, "The client"):
 * what the runtime loads at boot, and what it loads when a note is opened,
 * a row expanded, or a block named — each a bounded part of the cache,
 * read by index, as a `GraphFragment` the runtime merges into the graph
 * (`mergeFragment`). The whole corpus is never read unless something asks
 * for all of it (`NoteStore.getGraph`: search, the calendar).
 *
 * The reads mirror the MCP server's loaders (`worker/mcp/graph-load.ts`)
 * and keep their invariants: a hop follows a child link only between two
 * live nodes; a note's view is closed under the questions the app asks of
 * it (its subtree, the blocks written in it and their subtrees, and the
 * upward closure of all of those, so what else reaches a block is known);
 * the fragment says which ids it holds in full (`loaded`).
 */
export interface LazyReads {
  /** The first screen: every live note, the corpus root and its order, one
   * preview child per note (what an untitled note is named by), and the
   * pinned nodes. Cost: the notes, not the blocks. */
  rootView(): Promise<GraphFragment>
  /** A note, opened: its subtree, the blocks written in it with their
   * subtrees, and the upward closure of all of them. */
  noteView(noteId: string): Promise<GraphFragment>
  /** The subtrees beneath these blocks: a row expanded whose children the
   * graph held only in part. */
  subtreeView(ids: readonly string[]): Promise<GraphFragment>
  /** Just these live nodes, nothing beneath or above them. */
  nodesView(ids: readonly string[]): Promise<GraphFragment>
}

/** The grouped read of an entity's rows. */
const GROUPED = GROUPED_COLUMNS("c")

/**
 * One hop DOWN from the rows of `v` (a column `id`): the live child links
 * out of each (`s`, the link's `source_id` row) and the live node at the
 * far end (`d`, its `destination_id` row). Four primary-key seeks per
 * child, the same hop the Worker takes (`worker/mcp/graph-load.ts`).
 */
const HOP_DOWN =
  "CROSS JOIN events_log_cache s ON s.key = 'source_id' AND s.value = json_quote(v.id) " +
  "AND s.entity_id GLOB '*|child' " +
  "CROSS JOIN events_log_cache ld ON ld.entity = 'link' AND ld.entity_id = s.entity_id " +
  "AND ld.key = 'deleted' AND ld.value = 'null' " +
  "CROSS JOIN events_log_cache d ON d.entity = 'link' AND d.entity_id = s.entity_id " +
  "AND d.key = 'destination_id' " +
  "CROSS JOIN events_log_cache fd ON fd.entity = 'block' " +
  "AND fd.entity_id = json_extract(d.value, '$') AND fd.key = 'deleted' AND fd.value = 'null' "

/** One hop UP: the live child links INTO each row of `v`, and the live
 * parent at the far end. */
const HOP_UP =
  "CROSS JOIN events_log_cache s ON s.key = 'destination_id' AND s.value = json_quote(v.id) " +
  "AND s.entity_id GLOB '*|child' " +
  "CROSS JOIN events_log_cache ld ON ld.entity = 'link' AND ld.entity_id = s.entity_id " +
  "AND ld.key = 'deleted' AND ld.value = 'null' " +
  "CROSS JOIN events_log_cache d ON d.entity = 'link' AND d.entity_id = s.entity_id " +
  "AND d.key = 'source_id' " +
  "CROSS JOIN events_log_cache fd ON fd.entity = 'block' " +
  "AND fd.entity_id = json_extract(d.value, '$') AND fd.key = 'deleted' AND fd.value = 'null' "

/** The links of `edges` (columns `link_id`, `far`) and the nodes at their
 * far ends, grouped: two compound terms. */
const EDGES_AND_FAR_NODES =
  `SELECT ${GROUPED} FROM edges e CROSS JOIN events_log_cache c ` +
  "ON c.entity = 'link' AND c.entity_id = e.link_id " +
  "WHERE c.value IS NOT NULL GROUP BY c.entity, c.entity_id " +
  "/* includes-deleted: the hop that made `edges` crossed live links to live nodes only */ " +
  "UNION ALL " +
  `SELECT ${GROUPED} FROM (SELECT DISTINCT far FROM edges) AS f ` +
  "CROSS JOIN events_log_cache c ON c.entity = 'block' AND c.entity_id = f.far " +
  "WHERE c.value IS NOT NULL GROUP BY c.entity, c.entity_id"

/** The grouped rows of the live blocks named by `source` (a CTE or
 * subquery with a column `id`). */
const blocksOf = (source: string) =>
  `SELECT ${GROUPED} FROM ${source} AS i CROSS JOIN events_log_cache c ` +
  "ON c.entity = 'block' AND c.entity_id = i.id WHERE c.value IS NOT NULL " +
  "GROUP BY c.entity, c.entity_id " +
  "/* includes-deleted: the ids come from a live read; the caller keeps the live ones ($.deleted) */"

/** The live ones among `json_each(?n)`'s ids, as a CTE body. */
const liveIds = (param: number) =>
  `SELECT l.entity_id AS id FROM json_each(?${param}) AS j ` +
  "CROSS JOIN events_log_cache l ON l.entity = 'block' AND l.entity_id = j.value " +
  "AND l.key = 'deleted' AND l.value = 'null'"

/** The live notes, as a CTE body: `?n` is the JSON list of note types. */
const liveNotes = (param: number) =>
  `SELECT t.entity_id AS id FROM json_each(?${param}) AS j ` +
  "CROSS JOIN events_log_cache t ON t.key = 'type' AND t.value = json_quote(j.value) " +
  "CROSS JOIN events_log_cache l ON l.entity = 'block' AND l.entity_id = t.entity_id " +
  "AND l.key = 'deleted' AND l.value = 'null'"

const LIVE = (rows: Record<string, SqlValue>[]) => rowsOfGrouped(rows, { live: true })

/** The ids a fragment holds in full: every node the walk reached (its
 * child links came with it), and the seeds. */
const reachedIds = (
  fragment: { links: readonly { destination_id: string }[] },
  seeds: readonly string[],
) => [...new Set([...seeds, ...fragment.links.map((link) => link.destination_id)])]

export function createLazyReads(driver: SqlDriver): LazyReads {
  const types = JSON.stringify([...NOTE_TYPES])

  /** The subtrees beneath the live ids of `seeds` (a CTE body with a
   * column `id`): their links and nodes, and the seed nodes themselves. */
  const below = async (seeds: string, params: SqlValue[]) =>
    LIVE(
      await driver.exec(
        `WITH RECURSIVE seed (id) AS (${seeds}), ` +
          "below (id) AS (SELECT id FROM seed UNION " +
          `SELECT json_extract(d.value, '$') FROM below v ${HOP_DOWN}), ` +
          "edges (link_id, far) AS (SELECT s.entity_id, json_extract(d.value, '$') " +
          `FROM below v ${HOP_DOWN}) ` +
          `${EDGES_AND_FAR_NODES} UNION ALL ${blocksOf("seed")}`,
        params,
      ),
    )

  /** The upward closure of the ids in `?1` (a JSON list): every live child
   * link into a node that reaches one of them, and the parents. */
  const above = async (ids: readonly string[]) =>
    ids.length === 0
      ? { nodes: [], links: [] }
      : LIVE(
          await driver.exec(
            "WITH RECURSIVE above (id) AS (SELECT value FROM json_each(?1) UNION " +
              `SELECT json_extract(d.value, '$') FROM above v ${HOP_UP}), ` +
              "edges (link_id, far) AS (SELECT s.entity_id, json_extract(d.value, '$') " +
              `FROM above v ${HOP_UP}) ` +
              EDGES_AND_FAR_NODES,
            [JSON.stringify(ids)],
          ),
        )

  return {
    rootView: async () => {
      const notes = LIVE(
        await driver.exec(
          `SELECT * FROM (${blocksOf(`(${liveNotes(1)})`)}) WHERE ${LIVE_FIELDS("fields")}`,
          [types],
        ),
      )
      // The corpus root and its order: one hop down from it (its rows are
      // the notes, read above).
      const root = LIVE(
        await driver.exec(
          "WITH v (id) AS (SELECT ?1), " +
            "edges (link_id, far) AS (SELECT s.entity_id, json_extract(d.value, '$') " +
            `FROM v ${HOP_DOWN}) ` +
            `${EDGES_AND_FAR_NODES} UNION ALL ${blocksOf("v")}`,
          [CORPUS_ROOT_ID],
        ),
      )
      // One preview child per note: the first in sibling order, which an
      // untitled note is named by (`noteFromNode`). The window picks it in
      // SQL, so what comes back is one row per note, not one per block.
      const previews = LIVE(
        await driver.exec(
          `WITH v (id) AS (${liveNotes(1)}), ` +
            "hops (link_id, far, src, sort_key) AS (SELECT s.entity_id, " +
            "json_extract(d.value, '$'), v.id, json_extract(k.value, '$') " +
            `FROM v ${HOP_DOWN} CROSS JOIN events_log_cache k ON k.entity = 'link' ` +
            "AND k.entity_id = s.entity_id AND k.key = 'sort_key'), " +
            "edges (link_id, far) AS (SELECT link_id, far FROM (SELECT link_id, far, " +
            "ROW_NUMBER() OVER (PARTITION BY src ORDER BY sort_key, far) AS rn FROM hops) " +
            "WHERE rn = 1) /* includes-deleted: the hop crossed live links to live nodes only */ " +
            EDGES_AND_FAR_NODES +
            " /* includes-deleted: the hop crossed live links to live nodes only */",
          [types],
        ),
      )
      // The pinned nodes (`props.pinned_at`), on their own index: the
      // Pinned list draws them without a walk.
      const pinned = LIVE(
        await driver.exec(
          `SELECT * FROM (SELECT ${GROUPED} FROM events_log_cache p ` +
            "CROSS JOIN events_log_cache c ON c.entity = p.entity AND c.entity_id = p.entity_id " +
            "WHERE p.key = 'props.pinned_at' AND p.value IS NOT NULL AND c.value IS NOT NULL " +
            `GROUP BY c.entity, c.entity_id) WHERE ${LIVE_FIELDS("fields")} ` +
            "/* includes-deleted: grouped, then only the live ones kept ($.deleted) */",
        ),
      )
      return {
        nodes: [...notes.nodes, ...root.nodes, ...previews.nodes, ...pinned.nodes],
        links: [...root.links, ...previews.links],
        loaded: [CORPUS_ROOT_ID],
      }
    },

    noteView: async (noteId) => {
      // The note and the blocks written in it (its basket's candidates), with
      // everything beneath them.
      const down = await below(
        "SELECT ?1 UNION SELECT w.entity_id FROM events_log_cache w " +
          "CROSS JOIN events_log_cache l ON l.entity = 'block' AND l.entity_id = w.entity_id " +
          "AND l.key = 'deleted' AND l.value = 'null' " +
          "WHERE w.key = 'notes_id' AND w.value = json_quote(?1)",
        [noteId],
      )
      const loaded = reachedIds(down, [noteId, ...down.nodes.map((row) => row.id)])
      // What else reaches any of them: the upward closure, so a basket, a
      // delete and a place count read exactly.
      const up = await above(loaded)
      return {
        nodes: [...down.nodes, ...up.nodes],
        links: [...down.links, ...up.links],
        loaded,
      }
    },

    subtreeView: async (ids) => {
      if (ids.length === 0) return { nodes: [], links: [], loaded: [] }
      const down = await below(liveIds(1), [JSON.stringify([...new Set(ids)])])
      return { ...down, loaded: reachedIds(down, [...ids]) }
    },

    nodesView: async (ids) => {
      if (ids.length === 0) return { nodes: [], links: [], loaded: [] }
      const rows = LIVE(
        await driver.exec(
          `SELECT * FROM (${blocksOf(`(${liveIds(1)})`)}) WHERE ${LIVE_FIELDS("fields")}`,
          [JSON.stringify([...new Set(ids)])],
        ),
      )
      return { nodes: rows.nodes, links: [], loaded: [] }
    },
  }
}
