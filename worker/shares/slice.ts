// The slice: which of the owner's rows a share reaches, and what a grantee's
// write to them may contain (docs/sharing.md).
//
// A share names the owner's VIEW (migrations/0017), and the view names a
// ROOT — a note, or a block. What the grantee may see beneath it is derived
// from the owner's rows on every request, never sent by anyone:
//
// > A node is in the slice when it is the granted root and live, or when it
// > is reachable from it through live child links.
//
// The view's filter and sort ride along as presentation — how the grantee
// opens the root — and never narrow the slice.
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

import {
  toLinkRow,
  toNodeRow,
  type LinkRow,
  type NodeRow,
  type ReplicaPutPayload,
} from "../handlers/replica-payload"
import { writeRows } from "../handlers/event-log"
import type { TenantDb } from "../tenancy-db"
import { shareAllows, type Permission, type ShareGrant } from "./grant"
import type { ShareView } from "./wire"

/** `?1, ?2, …` for `count` parameters. */
const holes = (count: number): string =>
  Array.from({ length: count }, (_, at) => `?${at + 1}`).join(", ")

/**
 * The recursive walk, as a CTE prefix every slice statement shares:
 * `granted` is the root if it is live, `visible` everything reachable from
 * it. Written out in full in each statement rather than assembled at
 * runtime, so the string the guard checks is the string that runs. The
 * root is `?1`.
 */
const closureCte =
  `WITH RECURSIVE granted (id) AS ( ` +
  `SELECT n.id FROM nodes n ` +
  `WHERE n.user_id = :tenant AND n.deleted_at IS NULL ` +
  `AND n.id = ?1 ), ` +
  `visible (id) AS ( ` +
  `SELECT id FROM granted ` +
  `UNION ` +
  `SELECT l.destination_id FROM visible v ` +
  `CROSS JOIN link l ON l.user_id = :tenant AND l.source_id = v.id ` +
  `AND l.kind = 'child' AND l.deleted_at IS NULL ` +
  `JOIN nodes c ON c.user_id = :tenant AND c.id = l.destination_id ` +
  `AND c.deleted_at IS NULL ) `

/**
 * A view as it resolves when the owner has no row under that id: rooted at
 * the id itself, since a view's id IS its root's (src/data/views.ts), and
 * showing everything. The create endpoint writes the row, so this is for a
 * share older than the row, not the ordinary case.
 */
const bareView = (id: string): ShareView => ({ id, rootId: id, filter: null, sort: null })

/**
 * The owner's views by id — what each share is of. Read INCLUDING tombstones:
 * a view the owner cleared (unpinned, nothing saved) is a tombstone that
 * still names its root, and the share it backs keeps serving that root, in
 * document order, until a view is saved again and revives the row. Only a
 * live row lends its filter and sort.
 */
export async function resolveShareViews(
  owner: TenantDb,
  viewIds: readonly string[],
): Promise<Map<string, ShareView>> {
  const views = new Map<string, ShareView>()
  const wanted = [...new Set(viewIds)].filter((id) => id !== "")
  const all = owner.includingDeleted()
  for (let at = 0; at < wanted.length; at += 80) {
    const batch = wanted.slice(at, at + 80)
    const rows = await all.exec(
      `SELECT id, root_id, filter, sort, deleted_at FROM views ` +
        `WHERE user_id = :tenant AND id IN (${holes(batch.length)}) ` +
        `/* includes-deleted: a cleared view still names the root its share is of */`,
      batch,
    )
    for (const row of rows) {
      const live = row.deleted_at === null || row.deleted_at === undefined
      views.set(String(row.id), {
        id: String(row.id),
        rootId: String(row.root_id),
        filter: live && typeof row.filter === "string" ? row.filter : null,
        sort: live && typeof row.sort === "string" ? row.sort : null,
      })
    }
  }
  for (const id of wanted) if (!views.has(id)) views.set(id, bareView(id))
  return views
}

/** The view one share is of. Null for a grant that names no view at all. */
async function shareView(owner: TenantDb, grant: ShareGrant): Promise<ShareView | null> {
  if (grant.viewId === "") return null
  return (await resolveShareViews(owner, [grant.viewId])).get(grant.viewId) ?? null
}

/** What a slice node is now — the parts of it a push may not change. */
export interface SliceNode {
  type: string
  notes_id: string | null
  props: string | null
}

/** Every node in the slice, by id, and which of them is the live root (a
 * set, for the write planner: empty when the root is not live). */
export async function closureIds(
  owner: TenantDb,
  grant: ShareGrant,
): Promise<{ nodes: Map<string, SliceNode>; roots: Set<string> }> {
  const view = await shareView(owner, grant)
  if (view === null) return { nodes: new Map(), roots: new Set() }
  const rows = await owner.exec(
    closureCte +
      `SELECT v.id AS id, n.type, n.notes_id, n.props, (g.id IS NOT NULL) AS is_root ` +
      `FROM visible v ` +
      `JOIN nodes n ON n.user_id = :tenant AND n.id = v.id AND n.deleted_at IS NULL ` +
      `LEFT JOIN granted g ON g.id = v.id`,
    [view.rootId],
  )
  const nodes = new Map<string, SliceNode>()
  const liveRoots = new Set<string>()
  for (const row of rows) {
    const id = String(row.id)
    nodes.set(id, {
      type: String(row.type),
      notes_id: row.notes_id === null || row.notes_id === undefined ? null : String(row.notes_id),
      props: row.props === null || row.props === undefined ? null : String(row.props),
    })
    if (Number(row.is_root) === 1) liveRoots.add(id)
  }
  return { nodes, roots: liveRoots }
}

/** The slice as rows: every live node in it, and every live child link
 * with BOTH ends in it, and the view it is of. Nothing else is ever
 * serialized for a grantee. Null for a grant that names no view. */
export async function sliceRows(
  owner: TenantDb,
  grant: ShareGrant,
): Promise<{ nodes: NodeRow[]; links: LinkRow[]; view: ShareView } | null> {
  const view = await shareView(owner, grant)
  if (view === null) return null
  const params = [view.rootId]
  const nodes = (
    await owner.exec(
      closureCte +
        // `notes_id` names where a block was born, which can be a note outside
        // the share (a block the owner mirrored in from elsewhere). An id
        // outside the closure is never serialized, so it is blanked here.
        `SELECT n.id, n.type, n.text, n.props, n.updated_at, ` +
        `CASE WHEN n.notes_id IN (SELECT id FROM visible) THEN n.notes_id END AS notes_id ` +
        `FROM visible v CROSS JOIN nodes n ON n.id = v.id ` +
        `WHERE n.user_id = :tenant AND n.deleted_at IS NULL`,
      params,
    )
  ).map(toNodeRow)
  const links = (
    await owner.exec(
      closureCte +
        `SELECT l.source_id, l.destination_id, l.kind, l.sort_key, l.updated_at ` +
        `FROM visible a CROSS JOIN link l ON l.source_id = a.id ` +
        `JOIN visible b ON b.id = l.destination_id ` +
        `WHERE l.user_id = :tenant AND l.deleted_at IS NULL AND l.kind = 'child'`,
      params,
    )
  ).map(toLinkRow)
  return { nodes, links, view }
}

/** Which of these ids already exist in the owner's partition, live OR
 * tombstoned — a tombstoned id is still taken, and reviving it from outside
 * the slice would be a write to a row the grantee cannot see. */
export async function takenIds(owner: TenantDb, ids: string[]): Promise<Set<string>> {
  const taken = new Set<string>()
  const all = owner.includingDeleted()
  for (let at = 0; at < ids.length; at += 80) {
    const batch = ids.slice(at, at + 80)
    const rows = await all.exec(
      `SELECT id FROM nodes WHERE user_id = :tenant AND id IN (${holes(batch.length)}) ` +
        `/* includes-deleted: a tombstoned id is still taken */`,
      batch,
    )
    for (const row of rows) taken.add(String(row.id))
  }
  return taken
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

/** Why a grantee's push was refused. Each names the field a person can act on. */
type SliceWriteRefusal =
  | { status: 403; error: "permission_denied"; detail: string }
  | { status: 403; error: "outside_share"; detail: string }
  | { status: 400; error: "invalid_request"; detail: string }

export type SliceWritePlan =
  { ok: true; nodes: NodeRow[]; links: LinkRow[] } | { ok: false; refusal: SliceWriteRefusal }

const refuse = (refusal: SliceWriteRefusal): SliceWritePlan => ({ ok: false, refusal })

const isTombstone = (row: { deleted_at?: number }) =>
  row.deleted_at !== undefined && row.deleted_at !== null

/** The stored note-root type (migrations/0008): a grantee never makes one. */
const NOTE_TYPE = "note"

/**
 * The props that are the OWNER's to set (docs/metadata.md): how a note is
 * laid out. A push may carry them unchanged — every row carries its props
 * whole — but never change them. (A pin is a view, not a prop, since
 * migrations/0016, and the grantee's own to set.)
 */
const OWNER_PROPS = ["font", "width"] as const

const propsOf = (raw: string | null | undefined): Record<string, unknown> => {
  if (raw === null || raw === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Which owner-only prop a push would change, if any. */
const changedOwnerProp = (
  pushed: string | null | undefined,
  stored: string | null | undefined,
): string | null => {
  const next = propsOf(pushed)
  const current = propsOf(stored)
  for (const key of OWNER_PROPS) {
    if (JSON.stringify(next[key] ?? null) !== JSON.stringify(current[key] ?? null)) return key
  }
  return null
}

/**
 * Decide what a grantee's push may land, given the slice as it stands. Pure,
 * so the boundary rules are pinned by unit tests without a database:
 *
 * - **Every row stays inside the slice.** A node row must name a node in
 *   the closure, or a NEW id (one the owner's partition has never held) that
 *   is anchored to the slice: written in a shared note (`notes_id` names a
 *   live root) or linked beneath a slice node in the same push. A link row
 *   must have both ends in the closure or among those new ids. Anything
 *   else — an id outside the slice, a tombstoned id revived from outside,
 *   an unanchored new row — refuses the WHOLE push, so nothing lands
 *   half-applied.
 * - **A row keeps its shape.** A slice node keeps its type, its home note
 *   (`notes_id`, which lands only on a new row) and the owner's own props
 *   (`OWNER_PROPS`); a new row is never a note and never carries them. The
 *   verbs say what a grantee may write, not what the owner's rows are.
 * - **Verbs.** A node tombstone needs `delete`; every other row needs
 *   `write`. Unlinking (a link tombstone) is an edit, not a delete: the
 *   block stays, in the owner's Unassigned basket.
 * - **Time is the server's.** A pushed `updated_at` (and `deleted_at`) is
 *   clamped to `now`, so a grantee's clock cannot claim a row into the
 *   future and win every edit the owner makes after it.
 * - **The owner's cursor is theirs.** A cursor in the payload is ignored,
 *   and the legacy purge channel is refused.
 */
export function planSliceWrite(
  grant: ShareGrant,
  slice: {
    nodes: ReadonlyMap<string, SliceNode>
    roots: ReadonlySet<string>
    taken: ReadonlySet<string>
  },
  payload: ReplicaPutPayload,
  now: number = Date.now(),
): SliceWritePlan {
  if ((payload.deleteNodes?.length ?? 0) > 0 || (payload.deleteLinks?.length ?? 0) > 0) {
    return refuse({
      status: 400,
      error: "invalid_request",
      detail: "A shared note cannot be purged; push tombstoned rows instead.",
    })
  }

  const needs = (permission: Permission, what: string): SliceWriteRefusal | null =>
    shareAllows(grant, permission)
      ? null
      : {
          status: 403,
          error: "permission_denied",
          detail: `This share does not allow you to ${what}.`,
        }

  const newIds = new Set<string>()
  for (const node of payload.nodes) {
    if (slice.nodes.has(node.id)) continue
    if (slice.taken.has(node.id)) {
      return refuse({
        status: 403,
        error: "outside_share",
        detail: `Block ${node.id} is not part of this share.`,
      })
    }
    newIds.add(node.id)
  }

  const inside = (id: string) => slice.nodes.has(id) || newIds.has(id)

  for (const link of payload.links) {
    if (!inside(link.source_id) || !inside(link.destination_id)) {
      return refuse({
        status: 403,
        error: "outside_share",
        detail: `Link ${link.source_id} → ${link.destination_id} leaves this share.`,
      })
    }
  }

  // A new node must be anchored: born in a shared note, or linked beneath
  // the slice in this very push. Otherwise it would be an orphan the grantee
  // dropped into the owner's corpus, visible to nobody.
  for (const node of payload.nodes) {
    if (!newIds.has(node.id) || isTombstone(node)) continue
    const bornInSlice = node.notes_id !== undefined && slice.roots.has(node.notes_id)
    const linkedIn = payload.links.some(
      (link) => !isTombstone(link) && link.destination_id === node.id && inside(link.source_id),
    )
    if (!bornInSlice && !linkedIn) {
      return refuse({
        status: 403,
        error: "outside_share",
        detail: `Block ${node.id} is not attached to anything in this share.`,
      })
    }
  }

  // The shape rules: what a row IS stays the owner's.
  for (const node of payload.nodes) {
    const stored = slice.nodes.get(node.id)
    if (stored === undefined) {
      if (node.type === NOTE_TYPE) {
        return refuse({
          status: 403,
          error: "permission_denied",
          detail: `Block ${node.id} cannot be a note: a share does not make notes.`,
        })
      }
      const key = changedOwnerProp(node.props, null)
      if (key !== null) {
        return refuse({
          status: 403,
          error: "permission_denied",
          detail: `Block ${node.id} cannot set \`${key}\`: that is the owner's.`,
        })
      }
      continue
    }
    if (node.type !== stored.type) {
      return refuse({
        status: 403,
        error: "permission_denied",
        detail: `Block ${node.id} cannot change type here.`,
      })
    }
    const key = changedOwnerProp(node.props, stored.props)
    if (key !== null) {
      return refuse({
        status: 403,
        error: "permission_denied",
        detail: `Block ${node.id} cannot change \`${key}\`: that is the owner's.`,
      })
    }
  }

  for (const node of payload.nodes) {
    const denied = isTombstone(node)
      ? needs("delete", "delete blocks")
      : needs("write", "edit these notes")
    if (denied) return refuse(denied)
  }
  if (payload.links.length > 0) {
    const denied = needs("write", "edit these notes")
    if (denied) return refuse(denied)
  }

  const clamp = (at: number) => Math.min(at, now)
  const nodes = payload.nodes.map((node) => {
    const landed: NodeRow = { ...node, updated_at: clamp(node.updated_at) }
    if (isTombstone(node)) landed.deleted_at = clamp(node.deleted_at as number)
    // An existing row keeps the home note it has; the landing statement
    // keeps the stored value when none is sent.
    if (slice.nodes.has(node.id)) delete landed.notes_id
    return landed
  })
  const links = payload.links.map((link) => {
    const landed: LinkRow = { ...link, updated_at: clamp(link.updated_at) }
    if (isTombstone(link)) landed.deleted_at = clamp(link.deleted_at as number)
    return landed
  })
  return { ok: true, nodes, links }
}

/** Land a planned write in the owner's partition — through the same door a
 * replica push uses (`writeRows`: per-row LWW, server-assigned `seq`), minus
 * the cursor, which is the owner's own. The events land in the OWNER's log
 * with the grantee as their `actor`: whose corpus changed, and who changed it. */
export async function applySliceWrite(
  owner: TenantDb,
  plan: { nodes: NodeRow[]; links: LinkRow[] },
  actor: number,
  now: number = Date.now(),
  writer: { device?: string; client?: string | null } = {},
): Promise<void> {
  await writeRows(
    owner,
    { nodes: plan.nodes, links: plan.links },
    { actor, origin: "share", now, ...writer },
  )
}
