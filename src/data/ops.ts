import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import type { BlockDoc } from "../blocks/types"
import type { NoteId } from "../schema"
import { imagePropsOf } from "../blocks/image"
import {
  CHILD_KIND,
  PAGE_TYPE,
  docToParts,
  parseProps,
  reconcileSortKeys,
  type GraphSnapshot,
} from "./graph"

/**
 * Graph ops: the one vocabulary every change
 * to the graph is expressed in. An op is a row mutation — a node created or
 * changed, a child link put in place (with its sort key) or taken away, a
 * node tombstoned — so the same batch applies identically to the in-memory
 * snapshot (`applyOps`, synchronously, what the screen shows) and to the
 * store (`NoteStore.applyOps`, the rows that persist and replicate). Nothing
 * in here is markdown.
 *
 * The editor still edits a doc (the walk of its page); `docToOps` turns the
 * doc it hands back into the batch that makes the graph agree with it —
 * creating a block is one `create` and one `link`, typing is one `setText`,
 * a reorder is the links whose keys had to move, and a block the doc no longer
 * names is unlinked — and kept: it keeps its note (`notes_id`) and turns up
 * in that note's Unassigned basket (`basket.ts`) with everything beneath it,
 * unless it is blank (no text but whitespace, nothing beneath it, no
 * picture), which is deleted. Only the basket (`basketToOps`), the context
 * menu's Delete (`deleteBlockOps`) and deleting the note (`deletePageOps`)
 * delete a block that has something in it, and no delete ever cascades.
 */
export type Op =
  | {
      op: "create"
      id: string
      type: string
      text: string
      props: string | null
      /** The note the block is written in (the `notes_id` column); absent for a page. */
      notesId?: NoteId
    }
  | { op: "setText"; id: string; text: string }
  | { op: "setType"; id: string; type: string }
  | { op: "setProps"; id: string; props: string | null }
  | { op: "link"; source: string; destination: string; sortKey: string }
  | { op: "unlink"; source: string; destination: string }
  | { op: "delete"; id: string }

/** Sibling order: by sort key, destination id breaking a tie. */
const byOrder = (a: LinkRow, b: LinkRow) =>
  a.sort_key < b.sort_key
    ? -1
    : a.sort_key > b.sort_key
      ? 1
      : a.destination_id < b.destination_id
        ? -1
        : a.destination_id > b.destination_id
          ? 1
          : 0

/**
 * Apply a batch to a snapshot — pure; the input is untouched. Ops on nodes
 * the snapshot does not hold are ignored (a `set*` on a deleted node), links
 * are kept whether or not their endpoints exist (the walk skips a dangling
 * one, as `buildGraphSnapshot` does), and a deleted node takes its links out
 * of the snapshot with it, exactly as read-time discard would.
 */
export function applyOps(snapshot: GraphSnapshot, ops: readonly Op[], now: number): GraphSnapshot {
  if (ops.length === 0) return snapshot
  const nodes = new Map(snapshot.nodes)
  const childLinks = new Map(snapshot.childLinks)
  // Copy a source's list once per batch, however many of its links change.
  const touched = new Set<string>()
  const listOf = (source: string): LinkRow[] => {
    let list = childLinks.get(source)
    if (!list) {
      list = []
      childLinks.set(source, list)
      touched.add(source)
    } else if (!touched.has(source)) {
      list = [...list]
      childLinks.set(source, list)
      touched.add(source)
    }
    return list
  }

  for (const op of ops) {
    switch (op.op) {
      case "create":
        nodes.set(op.id, {
          id: op.id,
          type: op.type,
          text: op.text,
          props: op.props,
          updated_at: now,
          ...(op.notesId ? { notes_id: op.notesId } : {}),
        })
        break
      case "setText":
      case "setType":
      case "setProps": {
        const node = nodes.get(op.id)
        if (!node) break
        const next: NodeRow = { ...node, updated_at: now }
        if (op.op === "setText") next.text = op.text
        else if (op.op === "setType") next.type = op.type
        else next.props = op.props
        nodes.set(op.id, next)
        break
      }
      case "link": {
        const list = listOf(op.source)
        const at = list.findIndex((link) => link.destination_id === op.destination)
        if (at !== -1) list.splice(at, 1)
        list.push({
          source_id: op.source,
          destination_id: op.destination,
          kind: CHILD_KIND,
          sort_key: op.sortKey,
          updated_at: now,
        })
        list.sort(byOrder)
        break
      }
      case "unlink": {
        if (!childLinks.has(op.source)) break
        const list = listOf(op.source)
        const at = list.findIndex((link) => link.destination_id === op.destination)
        if (at !== -1) list.splice(at, 1)
        if (list.length === 0) childLinks.delete(op.source)
        break
      }
      case "delete": {
        if (!nodes.delete(op.id)) break
        childLinks.delete(op.id)
        for (const [source, list] of childLinks) {
          if (!list.some((link) => link.destination_id === op.id)) continue
          const kept = list.filter((link) => link.destination_id !== op.id)
          if (kept.length === 0) childLinks.delete(source)
          else childLinks.set(source, kept)
        }
        break
      }
    }
  }
  return { nodes, childLinks }
}

/** Every node's parents (sources of the child links into it). */
export function parentsIndex(snapshot: GraphSnapshot): Map<string, Set<string>> {
  const parentsOf = new Map<string, Set<string>>()
  for (const [source, list] of snapshot.childLinks) {
    for (const link of list) {
      let parents = parentsOf.get(link.destination_id)
      if (!parents) parentsOf.set(link.destination_id, (parents = new Set()))
      parents.add(source)
    }
  }
  return parentsOf
}

/** Ids reachable from `rootIds` through child links (the roots excluded
 * unless reached again). Path-safe: a node is visited once. */
export function reachableFrom(snapshot: GraphSnapshot, rootIds: Iterable<string>): Set<string> {
  const seen = new Set<string>()
  const stack = [...rootIds]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const link of snapshot.childLinks.get(id) ?? []) {
      if (seen.has(link.destination_id)) continue
      seen.add(link.destination_id)
      stack.push(link.destination_id)
    }
  }
  return seen
}

/** Every page node's id. */
export function pageIds(snapshot: GraphSnapshot): string[] {
  const ids: string[] = []
  for (const node of snapshot.nodes.values()) if (node.type === PAGE_TYPE) ids.push(node.id)
  return ids
}

/**
 * Delete a page: its node, and its content — every block the page reaches
 * that no other page reaches, plus the blocks written in it that nothing
 * reaches at all (its Unassigned basket). A block another page also holds
 * survives (the page's link to it is simply gone).
 */
export function deletePageOps(pageId: NoteId, snapshot: GraphSnapshot): Op[] {
  const page = snapshot.nodes.get(pageId)
  if (!page || page.type !== PAGE_TYPE) return []
  const others = reachableFrom(
    snapshot,
    pageIds(snapshot).filter((id) => id !== pageId),
  )
  const doomed = new Set<string>([pageId])
  for (const id of reachableFrom(snapshot, [pageId])) if (!others.has(id)) doomed.add(id)
  for (const node of snapshot.nodes.values()) {
    if (node.notes_id === pageId && !others.has(node.id)) doomed.add(node.id)
  }
  return [...doomed].map((id) => ({ op: "delete", id }))
}

/** How many parents hold a block — the number of places it appears across
 * the corpus (0 for an unknown or orphaned node). */
export function parentCount(snapshot: GraphSnapshot, id: string): number {
  let count = 0
  for (const list of snapshot.childLinks.values()) {
    for (const link of list) if (link.destination_id === id) count += 1
  }
  return count
}

/**
 * Delete a block from every place it appears: unlink it from each parent and
 * delete it — and nothing more. Its children keep their note and, no longer
 * reached, show in that note's Unassigned basket. The graph-level counterpart
 * of removing a row in the editor (which only unlinks the row's own
 * occurrence and keeps a block still held elsewhere).
 */
export function deleteBlockOps(blockId: string, snapshot: GraphSnapshot): Op[] {
  const node = snapshot.nodes.get(blockId)
  if (!node || node.type === PAGE_TYPE) return []
  const unlinks: Op[] = []
  for (const [source, list] of snapshot.childLinks) {
    if (list.some((link) => link.destination_id === blockId)) {
      unlinks.push({ op: "unlink", source, destination: blockId })
    }
  }
  return [...unlinks, { op: "delete", id: blockId }]
}

/**
 * Delete a block and everything beneath it that nothing else holds: the
 * block itself from every place it appears (as `deleteBlockOps`), and each
 * block reachable from it that no page, and no other block outside the
 * subtree, still reaches once it is gone. A block that also hangs from
 * another note, or from another Unassigned root, is only unlinked from the
 * subtree and survives. The basket's "Delete with contents".
 */
export function deleteSubtreeOps(blockId: string, snapshot: GraphSnapshot): Op[] {
  const node = snapshot.nodes.get(blockId)
  if (!node || node.type === PAGE_TYPE) return []
  const below = reachableFrom(snapshot, [blockId])
  below.delete(blockId)
  // What the rest of the graph still reaches without going through the
  // block: every page, and every parentless block (an Unassigned root of
  // any note) other than this one, walked around the block.
  const parentsOf = parentsIndex(snapshot)
  const roots = pageIds(snapshot).filter((id) => id !== blockId)
  for (const other of snapshot.nodes.values()) {
    if (other.id === blockId || other.type === PAGE_TYPE) continue
    if ((parentsOf.get(other.id)?.size ?? 0) === 0) roots.push(other.id)
  }
  const kept = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const link of snapshot.childLinks.get(id) ?? []) {
      const child = link.destination_id
      if (child === blockId || kept.has(child)) continue
      kept.add(child)
      stack.push(child)
    }
  }
  const doomed = new Set<string>([blockId])
  for (const id of below) if (!kept.has(id)) doomed.add(id)
  // Links into the doomed from outside are tombstoned so the removal
  // replicates; links among the doomed are retained, as a delete's always are.
  const unlinks: Op[] = []
  for (const [source, list] of snapshot.childLinks) {
    if (doomed.has(source)) continue
    for (const link of list) {
      if (doomed.has(link.destination_id)) {
        unlinks.push({ op: "unlink", source, destination: link.destination_id })
      }
    }
  }
  return [...unlinks, ...[...doomed].map((id) => ({ op: "delete", id }) as Op)]
}
/**
 * The batch that makes the graph hold `doc` as page `pageId`'s content:
 *
 * - the page node created or retitled/re-propped;
 * - every block the doc holds created if the graph lacks it — with this page
 *   as its `notes_id` — else its text, type or props set where they differ; a block the
 *   graph already has (pasted as a link from elsewhere) is simply linked, one
 *   node, two links;
 * - each parent's child order reconciled against its current links, so an
 *   unchanged sibling produces nothing, an insert produces one `link` with a
 *   key between its neighbours, a removal one `unlink`;
 * - a block the page reached before but the doc no longer names, that nothing
 *   holds any more, is kept, out of reach: it and everything beneath it show
 *   in the note's Unassigned basket (`basket.ts`), from which a paste links
 *   it back. Removing a row is an unlink, never a delete — except a blank
 *   block (`isBlankNode`), which is deleted so an abandoned empty line leaves
 *   nothing behind. A block another page also holds survives untouched.
 *
 * Block ids that collide with a page id are re-minted (`docToParts`), and a
 * block is never linked under itself; any other loop is a shape the graph
 * holds (docs/graph-schema-v2.md, "Loops"). Applying the result to
 * `snapshot` yields a graph whose walk of `pageId` is `doc` (modulo those
 * two repairs); applying the ops for that walk again yields nothing.
 */
export function docToOps(
  pageId: NoteId,
  doc: BlockDoc,
  snapshot: GraphSnapshot,
  discard?: Iterable<string>,
): Op[] {
  const { nodes, childrenOf } = docToParts(pageId, doc, 0, reservedPageIds(snapshot, pageId))
  return partsToOps(
    pageId,
    nodes,
    childrenOf,
    snapshot,
    reachableFrom(snapshot, [pageId]),
    "keep",
    new Set(discard ?? []),
  )
}

/**
 * A block with nothing in it: no text but whitespace, nothing beneath it, and
 * no picture (an image row's text is its caption; its picture is in its
 * props, and a placeholder whose upload failed has none). Blank blocks are
 * what backing out of an empty line leaves behind, so the outline deletes
 * them rather than parking them in the basket.
 */
function isBlankNode(snapshot: GraphSnapshot, id: string): boolean {
  const node = snapshot.nodes.get(id)
  if (!node) return true
  if (node.text.trim() !== "") return false
  if ((snapshot.childLinks.get(id)?.length ?? 0) > 0) return false
  if (node.type === "image") {
    const image = imagePropsOf({ props: parseProps(node.props) })
    if (image.image || image.src) return false
  }
  return true
}

/** Every other page's id — ids a block row must never take (`docToParts`). */
export function reservedPageIds(snapshot: GraphSnapshot, pageId: string): Set<string> {
  const reserved = new Set<string>()
  for (const node of snapshot.nodes.values()) {
    if (node.type === PAGE_TYPE && node.id !== pageId) reserved.add(node.id)
  }
  return reserved
}

/**
 * The shared core of `docToOps` and the basket's `basketToOps`: node rows
 * and per-parent child orders, diffed against the snapshot. `reachedBefore`
 * is what the edited region held before this batch; a node in it that
 * `nodes` no longer names, and that no parent holds once the links are
 * reconciled, is *dropped*, and `dropped` says what that means:
 *
 * - `"keep"` (the outline): the block stays, out of reach, for the note's
 *   Unassigned basket to show — unless it is blank (`isBlankNode`), or named
 *   in `discard` (an undo taking back the edit that created it —
 *   `ChangeHint`), which is deleted, so backing out of an empty line or
 *   undoing a duplicate leaves nothing behind;
 * - `"delete"` (the basket): the block is deleted. There is nothing to
 *   unlink it from, and the basket is where a block is deleted for good.
 *
 * Either way only that block is touched: never what it holds.
 */
export function partsToOps(
  pageId: NoteId,
  nodes: NodeRow[],
  childrenOf: Map<string, string[]>,
  snapshot: GraphSnapshot,
  reachedBefore: Set<string>,
  dropped: "keep" | "delete",
  discard: ReadonlySet<string> = new Set(),
): Op[] {
  const creates: Op[] = []
  const sets: Op[] = []
  const linkOps: Op[] = []
  const deletes: Op[] = []

  for (const node of nodes) {
    const old = snapshot.nodes.get(node.id)
    if (!old) {
      creates.push({
        op: "create",
        id: node.id,
        type: node.type,
        text: node.text,
        props: node.props,
        ...(node.type === PAGE_TYPE ? {} : { notesId: pageId }),
      })
      continue
    }
    if (old.text !== node.text) sets.push({ op: "setText", id: node.id, text: node.text })
    if (old.type !== node.type) sets.push({ op: "setType", id: node.id, type: node.type })
    if (old.props !== node.props) sets.push({ op: "setProps", id: node.id, props: node.props })
  }

  // Parents after this batch: the snapshot's links, minus what is unlinked
  // here, plus what is linked — what decides the deletes below.
  const parentsOf = parentsIndex(snapshot)
  const parents = (id: string): Set<string> => {
    let set = parentsOf.get(id)
    if (!set) parentsOf.set(id, (set = new Set()))
    return set
  }

  for (const [parentId, wanted] of childrenOf) {
    // A block under itself is the one loop refused: it has no closing row to
    // show. Every other loop is kept.
    const desired = wanted.filter((id) => id !== parentId)
    const existing = snapshot.childLinks.get(parentId) ?? []
    const keys = reconcileSortKeys(
      existing.map((link) => ({ id: link.destination_id, sortKey: link.sort_key })),
      desired,
    )
    const desiredSet = new Set(desired)
    for (const link of existing) {
      if (desiredSet.has(link.destination_id)) continue
      linkOps.push({ op: "unlink", source: parentId, destination: link.destination_id })
      parents(link.destination_id).delete(parentId)
    }
    for (const destination of desired) {
      const sortKey = keys.get(destination) as string
      const current = existing.find((link) => link.destination_id === destination)
      if (!current || current.sort_key !== sortKey) {
        linkOps.push({ op: "link", source: parentId, destination, sortKey })
      }
      parents(destination).add(parentId)
    }
  }

  // What was reached before, is no longer named, and nothing holds: dropped.
  // No cascade — a deleted block's children keep their links from it (the
  // store retains them, the walk skips them) and their note, and turn up in
  // the basket.
  const kept = new Set(nodes.map((node) => node.id))
  for (const id of reachedBefore) {
    if (kept.has(id) || !snapshot.nodes.has(id) || parents(id).size > 0) continue
    if (dropped === "delete" || discard.has(id) || isBlankNode(snapshot, id)) {
      deletes.push({ op: "delete", id })
    }
  }

  return [...creates, ...sets, ...linkOps, ...deletes]
}

/** The page ids a batch touches — the pages whose rollups changed (every
 * page that reaches a node the batch names). */
export function pagesTouchedBy(snapshot: GraphSnapshot, ops: readonly Op[]): Set<NoteId> {
  const ids = new Set<string>()
  for (const op of ops) {
    if (op.op === "link" || op.op === "unlink") {
      ids.add(op.source)
      ids.add(op.destination)
    } else ids.add(op.id)
  }
  const parentsOf = new Map<string, string[]>()
  for (const [source, list] of snapshot.childLinks) {
    for (const link of list) {
      const parents = parentsOf.get(link.destination_id)
      if (parents) parents.push(source)
      else parentsOf.set(link.destination_id, [source])
    }
  }
  const pages = new Set<NoteId>()
  const seen = new Set<string>()
  const stack = [...ids]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    if (snapshot.nodes.get(id)?.type === PAGE_TYPE) pages.add(id)
    for (const parent of parentsOf.get(id) ?? []) stack.push(parent)
  }
  return pages
}
