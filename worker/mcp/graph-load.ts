// The row reads behind a scoped view of the corpus: point lookups, one-hop
// link reads, and two recursive walks (docs/mcp-server.md §4), over the
// cache of the log (docs/events-log-cache.md).
//
// ## What this module is and is not
//
// It is a set of **loaders**. Every function here answers "which rows" and
// nothing else — no function decides what a user can see, what a note is
// called, which blocks are unassigned, or what a note's outline looks like.
// Those questions are answered exactly once, by the app's own pure functions
// over a `GraphSnapshot`, and `graph-access.ts` is where the two meet.
//
// That split is deliberate, and it is the whole reason the targeted reads are
// safe to add: a loader that fetches too FEW rows makes an answer wrong and a
// differential test catches it, while a loader that fetches too MANY only
// costs. There is no third outcome where the loader quietly invents a second
// definition of what the user can see, because a loader never answers a
// question.
//
// ## Two rules every statement here obeys
//
// 1. **Tenancy**: `user_id` + `:tenant`, on every table reference including
//    the ones inside a CTE (src/data/sql-tenancy-guard.ts).
// 2. **A traversal follows a link only between two LIVE nodes.** That is not
//    an extra safety margin, it is the rule `buildGraphSnapshot` applies when
//    it drops a link at a tombstoned endpoint — restated in SQL so a walk over
//    the rows and a walk over the snapshot cross the same edges. A hop reads
//    the link's `deleted` row and the far node's, both `null`.
//
// ## One hop, four seeks
//
// An entity is the group of its rows, so a hop from a node to its children
// is: its id on the `source_id` index (one seek per child link), the link's
// `deleted` row, its `destination_id` row, and the child's `deleted` row —
// each a primary-key seek (`HOP_DOWN`; `HOP_UP` the other way). The rows the
// walk reached are then read grouped (`GROUPED`), links and nodes in one
// statement of two compound terms (D1 allows five).
//
// ## Why the recursive walks use UNION
//
// The graph can hold loops: a node's child can be a node above it
// (docs/graph-schema-v2.md, "Loops"). `UNION` discards a row already produced,
// so an unbounded walk over a cyclic graph terminates — the same reason
// migration 0006's backfill uses it. The DEPTH-bounded walk carries a depth
// column, which makes a repeated node a distinct row, so the bound is what
// terminates it; `MAX_DEPTH` in `tools.ts` is what keeps that bound small.

import { GROUPED_COLUMNS, rowsOfGrouped } from "../../src/data/cache-rows"
import { NOTE_TYPES } from "../../src/data/graph"
import type { SqlValue } from "../../src/data/sql-driver"
import { readLiveEntitiesByIds, readLiveNotes, readLiveWrittenIn } from "../handlers/cache-reads"
import type { LinkRow, NodeRow } from "../handlers/replica-payload"
import type { TenantDb } from "../tenancy-db"

/**
 * How many ids one statement names. D1 binds at most 100 parameters per
 * statement and `:tenant` takes one of them, so a longer list is read in
 * several passes and the results concatenated — which is sound for every
 * loader here, since each is a union over its seeds.
 */
const CHUNK = 80

/**
 * Rows on the way to a snapshot: some links, and whichever node rows came back
 * alongside them.
 */
export interface Fragment {
  links: LinkRow[]
  nodes: NodeRow[]
}

const NOTHING: Fragment = { links: [], nodes: [] }

const merge = (parts: Fragment[]): Fragment => ({
  links: parts.flatMap((part) => part.links),
  nodes: parts.flatMap((part) => part.nodes),
})

/**
 * Run `read` over `ids` in bindable-sized batches and merge the results.
 *
 * Concurrently: the batches are independent (each loader is a union over its
 * seeds), so making them sequential would only add round trips.
 */
async function inChunks(
  ids: string[],
  read: (batch: string[]) => Promise<Fragment>,
): Promise<Fragment> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return NOTHING
  const batches: string[][] = []
  for (let at = 0; at < unique.length; at += CHUNK) batches.push(unique.slice(at, at + CHUNK))
  return merge(await Promise.all(batches.map(read)))
}

/** `?1, ?2, …` for `count` parameters. */
const holes = (count: number): string =>
  Array.from({ length: count }, (_, at) => `?${at + 1}`).join(", ")

/**
 * One hop DOWN from the rows of `v` (a column `id`): the live child links
 * out of each, and the live node at the far end of each. Yields `s`, the
 * link's `source_id` row (its id is `s.entity_id`), and `d`, its
 * `destination_id` row (the child's id is `json_extract(d.value, '$')`).
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

/** One hop UP: the live child links INTO each row of `v`, and the live
 * parent at the far end. `s` is the link's `destination_id` row, `d` its
 * `source_id` row. */
const HOP_UP =
  "CROSS JOIN events_log_cache s ON s.user_id = :tenant AND s.key = 'destination_id' " +
  "AND s.value = json_quote(v.id) AND s.entity_id GLOB '*|child' " +
  "CROSS JOIN events_log_cache ld ON ld.user_id = :tenant AND ld.entity = 'link' " +
  "AND ld.entity_id = s.entity_id AND ld.key = 'deleted' AND ld.value = 'null' " +
  "CROSS JOIN events_log_cache d ON d.user_id = :tenant AND d.entity = 'link' " +
  "AND d.entity_id = s.entity_id AND d.key = 'source_id' " +
  "CROSS JOIN events_log_cache fd ON fd.user_id = :tenant AND fd.entity = 'block' " +
  "AND fd.entity_id = json_extract(d.value, '$') AND fd.key = 'deleted' AND fd.value = 'null' "

/** The grouped read of an entity's rows. */
const GROUPED = GROUPED_COLUMNS("c")

/**
 * The links of `edges` (columns `link_id`, `far`) and the nodes at their
 * far ends, grouped: one statement of two compound terms. The CTEs before
 * it must leave `edges` defined.
 */
const EDGES_AND_FAR_NODES =
  `SELECT ${GROUPED} FROM edges e CROSS JOIN events_log_cache c ` +
  "ON c.user_id = :tenant AND c.entity = 'link' AND c.entity_id = e.link_id " +
  "WHERE c.value IS NOT NULL GROUP BY c.entity, c.entity_id " +
  "/* includes-deleted: the hop crossed live links and nodes only; the group reads each one's " +
  "rows whole, its deleted row among them */ " +
  "UNION ALL " +
  `SELECT ${GROUPED} FROM (SELECT DISTINCT far FROM edges) AS f ` +
  "CROSS JOIN events_log_cache c ON c.user_id = :tenant AND c.entity = 'block' " +
  "AND c.entity_id = f.far WHERE c.value IS NOT NULL GROUP BY c.entity, c.entity_id"

/** The live node ids among `seeds` (`?1 …`), as a CTE body: a seed that is
 * tombstoned, or unknown, contributes nothing. */
const liveSeeds = (count: number) =>
  "SELECT n.entity_id AS id FROM events_log_cache n WHERE n.user_id = :tenant " +
  `AND n.entity = 'block' AND n.key = 'deleted' AND n.value = 'null' AND n.entity_id IN (${holes(count)})`

/** Split a grouped read's rows into the two row shapes it carries. */
const asFragment = (rows: Record<string, SqlValue>[]): Fragment => {
  const { nodes, links } = rowsOfGrouped(rows, { live: true })
  return { links, nodes }
}

// -----------------------------------------------------------------------------
// Point reads
// -----------------------------------------------------------------------------

/** The live node rows for these ids — a primary-key seek per id. */
export const nodesByIds = async (tenant: TenantDb, ids: string[]): Promise<NodeRow[]> =>
  rowsOfGrouped(
    (await readLiveEntitiesByIds(tenant, "block", ids)).map((state) => ({
      entity: state.entity,
      entity_id: state.entity_id,
      fields: JSON.stringify(state.fields),
      seq: state.seq,
      updated_at: state.updated_at,
    })),
    { live: true },
  ).nodes

/** Every live NOTE node, and nothing beneath any of them — on the `type`
 * index. Enough to order and page a note list, because a note's place in
 * that order is a fact about its own row. */
export const noteNodes = async (tenant: TenantDb): Promise<NodeRow[]> =>
  asFragment(
    (await readLiveNotes(tenant, NOTE_TYPES)).map((state) => ({
      entity: state.entity,
      entity_id: state.entity_id,
      fields: JSON.stringify(state.fields),
      seq: state.seq,
      updated_at: state.updated_at,
    })),
  ).nodes

/** Every live block written in this note (`notes_id`) — the candidates for its
 * Unassigned section, on the `notes_id` index. */
export const nodesWrittenIn = async (tenant: TenantDb, noteId: string): Promise<NodeRow[]> =>
  asFragment(
    (await readLiveWrittenIn(tenant, noteId)).map((state) => ({
      entity: state.entity,
      entity_id: state.entity_id,
      fields: JSON.stringify(state.fields),
      seq: state.seq,
      updated_at: state.updated_at,
    })),
  ).nodes

/** The child links OUT of these nodes, and the children themselves — on
 * the `source_id` index. */
export const linksFrom = (tenant: TenantDb, ids: string[]): Promise<Fragment> =>
  inChunks(ids, async (batch) =>
    asFragment(
      await tenant.exec(
        `WITH v (id) AS (SELECT value FROM json_each(?1)), ` +
          "edges (link_id, far) AS (SELECT s.entity_id, json_extract(d.value, '$') " +
          `FROM v ${HOP_DOWN}) ` +
          EDGES_AND_FAR_NODES,
        [JSON.stringify(batch)],
      ),
    ),
  )

// -----------------------------------------------------------------------------
// The two walks
// -----------------------------------------------------------------------------

/**
 * Every child link on a path DOWN from these roots, `maxDepth` hops at most
 * (`null` for the whole subtree), with the node at the foot of each.
 *
 * The returned edges leave every node the walk reached, INCLUDING the ones at
 * the depth limit — so a caller sees one level past the blocks it will emit,
 * which is exactly what `hasMoreChildren` needs to be true or false.
 */
export function linksBelow(
  tenant: TenantDb,
  roots: string[],
  maxDepth: number | null,
): Promise<Fragment> {
  return inChunks(roots, async (batch) => {
    // Unbounded: the walk carries ids only, so `UNION` collapses a revisit and
    // a loop terminates.
    const unbounded =
      `WITH RECURSIVE below (id) AS ( ${liveSeeds(batch.length)} ` +
      `UNION SELECT json_extract(d.value, '$') FROM below v ${HOP_DOWN}), ` +
      "edges (link_id, far) AS (SELECT s.entity_id, json_extract(d.value, '$') " +
      `FROM below v ${HOP_DOWN}) ` +
      EDGES_AND_FAR_NODES
    // Bounded: the depth column makes a revisited node a NEW row, so the bound
    // — not `UNION` — is what stops a loop. `MAX_DEPTH` keeps it small.
    const bounded =
      `WITH RECURSIVE below (id, depth) AS ( SELECT id, 0 FROM (${liveSeeds(batch.length)}) ` +
      `UNION SELECT json_extract(d.value, '$'), v.depth + 1 FROM below v ${HOP_DOWN}` +
      `WHERE v.depth < ?${batch.length + 1}), ` +
      "edges (link_id, far) AS (SELECT s.entity_id, json_extract(d.value, '$') " +
      `FROM (SELECT DISTINCT id FROM below) v ${HOP_DOWN}) ` +
      EDGES_AND_FAR_NODES
    return asFragment(
      maxDepth === null
        ? await tenant.exec(unbounded, batch)
        : await tenant.exec(bounded, [...batch, maxDepth]),
    )
  })
}

/**
 * Every child link INTO a node that reaches one of these ids — the upward
 * closure, on the `destination_id` index.
 *
 * This is the edge set that makes upward questions exact. Every edge it
 * returns ends at an ancestor of a seed (or at a seed), so it lies on some
 * path down to one; and every path down to a seed is made of such edges. So
 * `parentsIndex` over these rows gives a seed's true parents, and walking DOWN
 * from the notes among them gives exactly the notes that reach it.
 */
export const linksAbove = (tenant: TenantDb, ids: string[]): Promise<Fragment> =>
  inChunks(ids, async (batch) =>
    asFragment(
      await tenant.exec(
        `WITH RECURSIVE above (id) AS ( ${liveSeeds(batch.length)} ` +
          `UNION SELECT json_extract(d.value, '$') FROM above v ${HOP_UP}), ` +
          "edges (link_id, far) AS (SELECT s.entity_id, json_extract(d.value, '$') " +
          `FROM above v ${HOP_UP}) ` +
          EDGES_AND_FAR_NODES,
        batch,
      ),
    ),
  )

// -----------------------------------------------------------------------------
// The note scope
// -----------------------------------------------------------------------------

/**
 * The node ids a NOTE-SCOPED grant may see, read straight out of the rows.
 *
 * The definition is the one in docs/mcp-server.md and `visibleNodes`
 * (graph-access.ts), transcribed hop for hop: the granted ids that name a live
 * NOTE, plus every live block written in one of them (`notes_id` — the
 * Unassigned baskets the person can see), plus everything reachable from all
 * of those over live child links.
 *
 * Seeding the walk at the grant is the point. The snapshot path computes the
 * same set by loading the corpus and walking it in memory; this one touches
 * only the granted notes' own region, which is the smallest set that can
 * answer the question at all.
 */
export const scopeNodeIds = async (tenant: TenantDb, noteIds: string[]): Promise<string[]> => {
  const batches: string[][] = []
  const unique = [...new Set(noteIds)]
  for (let at = 0; at < unique.length; at += CHUNK) batches.push(unique.slice(at, at + CHUNK))
  const walks = await Promise.all(
    batches.map(async (batch) => {
      const rows = await tenant.exec(
        "WITH RECURSIVE granted (id) AS ( " +
          "SELECT t.entity_id FROM json_each(?1) AS j " +
          "CROSS JOIN events_log_cache t ON t.user_id = :tenant AND t.key = 'type' " +
          "AND t.value = json_quote(j.value) " +
          "CROSS JOIN events_log_cache n ON n.user_id = :tenant AND n.entity = 'block' " +
          "AND n.entity_id = t.entity_id AND n.key = 'deleted' AND n.value = 'null' " +
          `WHERE t.entity_id IN (${holes(batch.length).replace(/\?(\d+)/g, (_, i) => `?${Number(i) + 1}`)}) ), ` +
          "seed (id) AS ( SELECT id FROM granted UNION " +
          "SELECT w.entity_id FROM granted g " +
          "CROSS JOIN events_log_cache w ON w.user_id = :tenant AND w.key = 'notes_id' " +
          "AND w.value = json_quote(g.id) " +
          "CROSS JOIN events_log_cache n ON n.user_id = :tenant AND n.entity = 'block' " +
          "AND n.entity_id = w.entity_id AND n.key = 'deleted' AND n.value = 'null' ), " +
          "visible (id) AS ( SELECT id FROM seed UNION " +
          `SELECT json_extract(d.value, '$') FROM visible v ${HOP_DOWN}) ` +
          "SELECT id FROM visible",
        [JSON.stringify([...NOTE_TYPES]), ...batch],
      )
      return rows.map((row) => String(row.id))
    }),
  )
  return walks.flat()
}
