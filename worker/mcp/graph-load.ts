// The row reads behind a scoped view of the corpus: point lookups, one-hop
// link reads, and two recursive walks (docs/mcp-server.md §4).
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
//    the rows and a walk over the snapshot cross the same edges. A statement
//    that traverses therefore joins `nodes` at both ends.
//
// ## Why the recursive walks use UNION
//
// The graph can hold loops: a node's child can be a node above it
// (docs/graph-schema-v2.md, "Loops"). `UNION` discards a row already produced,
// so an unbounded walk over a cyclic graph terminates — the same reason
// migration 0006's backfill uses it. The DEPTH-bounded walk carries a depth
// column, which makes a repeated node a distinct row, so the bound is what
// terminates it; `MAX_DEPTH` in `tools.ts` is what keeps that bound small.

import { NOTE_TYPE } from "../../src/data/graph"
import type { SqlValue } from "../../src/data/sql-driver"
import { toLinkRow, toNodeRow, type LinkRow, type NodeRow } from "../handlers/replica-payload"
import type { TenantDb } from "../tenancy-db"

/**
 * How many ids one statement names. D1 binds at most 100 parameters per
 * statement and `:tenant` takes one of them, so a longer list is read in
 * several passes and the results concatenated — which is sound for every
 * loader here, since each is a union over its seeds.
 */
const CHUNK = 80

const NODE_COLUMNS = "id, type, text, props, updated_at, notes_id"

/**
 * A link, and the node at its FAR end.
 *
 * Every traversal here already joins `nodes` at that end to check the node is
 * live, so its columns cost nothing more to return — and returning them is
 * what keeps a walk to ONE statement. Fetching the endpoints afterwards by id
 * would be a second round trip per 80 of them, which on a wide read is a dozen
 * sequential queries for rows the walk had already read.
 */
const linkAndNode = (far: string) =>
  `l.source_id, l.destination_id, l.kind, l.sort_key, l.updated_at, ` +
  `${far}.id AS far_id, ${far}.type AS far_type, ${far}.text AS far_text, ` +
  `${far}.props AS far_props, ${far}.updated_at AS far_updated_at, ` +
  `${far}.notes_id AS far_notes_id`

/** `?1, ?2, …` for `count` parameters. */
const holes = (count: number): string =>
  Array.from({ length: count }, (_, at) => `?${at + 1}`).join(", ")

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

const asNodes = (rows: Record<string, SqlValue>[]): NodeRow[] => rows.map(toNodeRow)

/** Split rows selected with `linkAndNode` into the two row shapes they carry. */
const asFragment = (rows: Record<string, SqlValue>[]): Fragment => ({
  links: rows.map(toLinkRow),
  nodes: rows.map((row) =>
    toNodeRow({
      id: row.far_id,
      type: row.far_type,
      text: row.far_text,
      props: row.far_props,
      updated_at: row.far_updated_at,
      notes_id: row.far_notes_id,
    }),
  ),
})

// -----------------------------------------------------------------------------
// Point reads
// -----------------------------------------------------------------------------

/** The live node rows for these ids — an index seek per id on `nodes`'
 * `(user_id, id)` primary key. */
export const nodesByIds = async (tenant: TenantDb, ids: string[]): Promise<NodeRow[]> =>
  (
    await inChunks(ids, async (batch) => ({
      links: [],
      nodes: asNodes(
        await tenant.exec(
          `SELECT ${NODE_COLUMNS} FROM nodes ` +
            `WHERE user_id = :tenant AND deleted_at IS NULL AND id IN (${holes(batch.length)})`,
          batch,
        ),
      ),
    }))
  ).nodes

/** Every live NOTE node, and nothing beneath any of them — on
 * `nodes_tenant_type`. Enough to order and page a note list, because a note's
 * place in that order is a fact about its own row. */
export const noteNodes = async (tenant: TenantDb): Promise<NodeRow[]> =>
  asNodes(
    await tenant.exec(
      `SELECT ${NODE_COLUMNS} FROM nodes ` +
        "WHERE user_id = :tenant AND deleted_at IS NULL AND type = ?1",
      [NOTE_TYPE],
    ),
  )

/** Every live block written in this note (`notes_id`) — the candidates for its
 * Unassigned section, on `nodes_tenant_notes`. */
export const nodesWrittenIn = async (tenant: TenantDb, noteId: string): Promise<NodeRow[]> =>
  asNodes(
    await tenant.exec(
      `SELECT ${NODE_COLUMNS} FROM nodes ` +
        "WHERE user_id = :tenant AND deleted_at IS NULL AND notes_id = ?1",
      [noteId],
    ),
  )

/** The child links OUT of these nodes, and the children themselves — on
 * `link_tenant_source`. */
export const linksFrom = (tenant: TenantDb, ids: string[]): Promise<Fragment> =>
  inChunks(ids, async (batch) =>
    asFragment(
      await tenant.exec(
        `SELECT ${linkAndNode("n")} FROM link l ` +
          "JOIN nodes n ON n.user_id = :tenant AND n.id = l.destination_id " +
          "AND n.deleted_at IS NULL " +
          "WHERE l.user_id = :tenant AND l.deleted_at IS NULL AND l.kind = 'child' " +
          `AND l.source_id IN (${holes(batch.length)})`,
        batch,
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
    const seeds = holes(batch.length)
    // Unbounded: the walk carries ids only, so `UNION` collapses a revisit and
    // a loop terminates.
    const unbounded =
      `WITH RECURSIVE below (id) AS ( ` +
      `SELECT n.id FROM nodes n ` +
      `WHERE n.user_id = :tenant AND n.deleted_at IS NULL AND n.id IN (${seeds}) ` +
      `UNION ` +
      `SELECT l.destination_id FROM below b ` +
      `JOIN link l ON l.user_id = :tenant AND l.source_id = b.id ` +
      `AND l.kind = 'child' AND l.deleted_at IS NULL ` +
      `JOIN nodes c ON c.user_id = :tenant AND c.id = l.destination_id ` +
      `AND c.deleted_at IS NULL ) ` +
      `SELECT ${linkAndNode("c")} FROM below b ` +
      `JOIN link l ON l.user_id = :tenant AND l.source_id = b.id ` +
      `AND l.kind = 'child' AND l.deleted_at IS NULL ` +
      `JOIN nodes c ON c.user_id = :tenant AND c.id = l.destination_id AND c.deleted_at IS NULL`
    // Bounded: the depth column makes a revisited node a NEW row, so the bound
    // — not `UNION` — is what stops a loop. `MAX_DEPTH` keeps it small.
    const bounded =
      `WITH RECURSIVE below (id, depth) AS ( ` +
      `SELECT n.id, 0 FROM nodes n ` +
      `WHERE n.user_id = :tenant AND n.deleted_at IS NULL AND n.id IN (${seeds}) ` +
      `UNION ` +
      `SELECT l.destination_id, b.depth + 1 FROM below b ` +
      `JOIN link l ON l.user_id = :tenant AND l.source_id = b.id ` +
      `AND l.kind = 'child' AND l.deleted_at IS NULL ` +
      `JOIN nodes c ON c.user_id = :tenant AND c.id = l.destination_id ` +
      `AND c.deleted_at IS NULL ` +
      `WHERE b.depth < ?${batch.length + 1} ) ` +
      `SELECT ${linkAndNode("c")} FROM below b ` +
      `JOIN link l ON l.user_id = :tenant AND l.source_id = b.id ` +
      `AND l.kind = 'child' AND l.deleted_at IS NULL ` +
      `JOIN nodes c ON c.user_id = :tenant AND c.id = l.destination_id AND c.deleted_at IS NULL`

    return asFragment(
      maxDepth === null
        ? await tenant.exec(unbounded, batch)
        : await tenant.exec(bounded, [...batch, maxDepth]),
    )
  })
}

/**
 * Every child link INTO a node that reaches one of these ids — the upward
 * closure, on `link_tenant_destination`.
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
        `WITH RECURSIVE above (id) AS ( ` +
          `SELECT n.id FROM nodes n ` +
          `WHERE n.user_id = :tenant AND n.deleted_at IS NULL ` +
          `AND n.id IN (${holes(batch.length)}) ` +
          `UNION ` +
          `SELECT l.source_id FROM above a ` +
          `JOIN link l ON l.user_id = :tenant AND l.destination_id = a.id ` +
          `AND l.kind = 'child' AND l.deleted_at IS NULL ` +
          `JOIN nodes p ON p.user_id = :tenant AND p.id = l.source_id ` +
          `AND p.deleted_at IS NULL ) ` +
          `SELECT ${linkAndNode("p")} FROM above a ` +
          `JOIN link l ON l.user_id = :tenant AND l.destination_id = a.id ` +
          `AND l.kind = 'child' AND l.deleted_at IS NULL ` +
          `JOIN nodes p ON p.user_id = :tenant AND p.id = l.source_id AND p.deleted_at IS NULL`,
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
        `WITH RECURSIVE granted (id) AS ( ` +
          `SELECT n.id FROM nodes n ` +
          `WHERE n.user_id = :tenant AND n.deleted_at IS NULL AND n.type = ?${batch.length + 1} ` +
          `AND n.id IN (${holes(batch.length)}) ), ` +
          `seed (id) AS ( ` +
          `SELECT id FROM granted ` +
          `UNION ` +
          `SELECT n.id FROM nodes n JOIN granted g ON g.id = n.notes_id ` +
          `WHERE n.user_id = :tenant AND n.deleted_at IS NULL ), ` +
          `visible (id) AS ( ` +
          `SELECT id FROM seed ` +
          `UNION ` +
          `SELECT l.destination_id FROM visible v ` +
          `JOIN link l ON l.user_id = :tenant AND l.source_id = v.id ` +
          `AND l.kind = 'child' AND l.deleted_at IS NULL ` +
          `JOIN nodes c ON c.user_id = :tenant AND c.id = l.destination_id ` +
          `AND c.deleted_at IS NULL ) ` +
          `SELECT id FROM visible`,
        [...batch, NOTE_TYPE],
      )
      return rows.map((row) => String(row.id))
    }),
  )
  return walks.flat()
}
