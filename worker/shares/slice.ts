// The slice: which of the owner's rows a share reaches (docs/sharing.md).
//
// A share names ROOT NOTES. What the grantee may see beneath them is derived
// from the owner's rows on every request, never sent by anyone:
//
// > A node is in the slice when it is a granted root that is a live note, or
// > when it is reachable from one through live child links.
//
// That is the reachability closure, and it is why the share is live by
// construction: a block added under a shared note joins the slice the moment
// it is linked, and a block unlinked from it leaves. It is also least-
// privilege by construction — ids outside the closure are never serialized,
// so the grantee cannot even name them.
//
// Two rules every statement here obeys (the same two as the MCP loaders):
//
// 1. **Tenancy**: `user_id` + `:tenant`, on every table reference including
//    the ones inside a CTE. The handle is the OWNER's, minted by the handler
//    from the share row; this module never sees a user id.
// 2. **A traversal follows a link only between two LIVE nodes** — the rule
//    `buildGraphSnapshot` applies at read time, restated in SQL, so the walk
//    over rows and the walk over a snapshot cross the same edges. `UNION`
//    (not `UNION ALL`) is what makes it terminate on a graph with a loop.

import { toLinkRow, toNodeRow, type LinkRow, type NodeRow } from "../handlers/replica-payload"
import { NOTE_TYPE } from "../../src/data/graph"
import type { TenantDb } from "../tenancy-db"
import type { ShareGrant } from "./grant"

/**
 * How many roots a share may name. D1 binds at most 100 parameters per
 * statement and the closure walk names every root in one statement (plus
 * the note type and the tenant), so this stays well under.
 */
export const MAX_SHARE_ROOTS = 50

/** `?1, ?2, …` for `count` parameters. */
const holes = (count: number): string =>
  Array.from({ length: count }, (_, at) => `?${at + 1}`).join(", ")

/**
 * The recursive walk, as a CTE prefix every slice statement shares:
 * `granted` is the roots that are live notes, `visible` everything reachable
 * from them. Written out in full in each statement rather than assembled at
 * runtime, so the string the guard checks is the string that runs.
 */
const closureCte = (rootCount: number) =>
  `WITH RECURSIVE granted (id) AS ( ` +
  `SELECT n.id FROM nodes n ` +
  `WHERE n.user_id = :tenant AND n.deleted_at IS NULL AND n.type = ?${rootCount + 1} ` +
  `AND n.id IN (${holes(rootCount)}) ), ` +
  `visible (id) AS ( ` +
  `SELECT id FROM granted ` +
  `UNION ` +
  `SELECT l.destination_id FROM visible v ` +
  `JOIN link l ON l.user_id = :tenant AND l.source_id = v.id ` +
  `AND l.kind = 'child' AND l.deleted_at IS NULL ` +
  `JOIN nodes c ON c.user_id = :tenant AND c.id = l.destination_id ` +
  `AND c.deleted_at IS NULL ) `

/** The roots as a bindable list, capped. An empty grant walks nothing. */
const rootsOf = (grant: ShareGrant): string[] => [...grant.rootIds].slice(0, MAX_SHARE_ROOTS)

/** The slice as rows: every live node in it, and every live child link
 * with BOTH ends in it. Nothing else is ever serialized for a grantee. */
export async function sliceRows(
  owner: TenantDb,
  grant: ShareGrant,
): Promise<{ nodes: NodeRow[]; links: LinkRow[] }> {
  const roots = rootsOf(grant)
  if (roots.length === 0) return { nodes: [], links: [] }
  const params = [...roots, NOTE_TYPE]
  const nodes = (
    await owner.exec(
      closureCte(roots.length) +
        // `notes_id` names where a block was born, which can be a note outside
        // the share (a block the owner mirrored in from elsewhere). An id
        // outside the closure is never serialized, so it is blanked here.
        `SELECT n.id, n.type, n.text, n.props, n.updated_at, ` +
        `CASE WHEN n.notes_id IN (SELECT id FROM visible) THEN n.notes_id END AS notes_id ` +
        `FROM nodes n JOIN visible v ON v.id = n.id ` +
        `WHERE n.user_id = :tenant AND n.deleted_at IS NULL`,
      params,
    )
  ).map(toNodeRow)
  const links = (
    await owner.exec(
      closureCte(roots.length) +
        `SELECT l.source_id, l.destination_id, l.kind, l.sort_key, l.updated_at ` +
        `FROM link l ` +
        `JOIN visible a ON a.id = l.source_id ` +
        `JOIN visible b ON b.id = l.destination_id ` +
        `WHERE l.user_id = :tenant AND l.deleted_at IS NULL AND l.kind = 'child'`,
      params,
    )
  ).map(toLinkRow)
  return { nodes, links }
}
