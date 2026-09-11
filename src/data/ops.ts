import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import type { BlockDoc } from "../blocks/types"
import type { NoteId } from "../schema"
import { CHILD_KIND, PAGE_TYPE, docToParts, reconcileSortKeys, type GraphSnapshot } from "./graph"

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
 * a reorder is the links whose keys had to move, and what the doc no longer
 * reaches is unlinked and, if nothing else holds it, deleted.
 */
export type Op =
  | { op: "create"; id: string; type: string; text: string; props: string | null }
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
function parentsIndex(snapshot: GraphSnapshot): Map<string, Set<string>> {
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

/**
 * Delete a page: its node, and every node left without a parent by that —
 * cascading down through children that thereby lose theirs. A block another
 * page holds survives (the page's link to it is simply gone).
 */
export function deletePageOps(pageId: NoteId, snapshot: GraphSnapshot): Op[] {
  const page = snapshot.nodes.get(pageId)
  if (!page || page.type !== PAGE_TYPE) return []
  return deleteNodeOps(pageId, snapshot)
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
 * Delete a block from every place it appears: unlink it from each parent,
 * delete it, and cascade through what only it held. The graph-level
 * counterpart of removing a row in the editor (which only unlinks the row's
 * own occurrence and keeps a block still held elsewhere).
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
  return [...unlinks, ...deleteNodeOps(blockId, snapshot)]
}

/** The `delete` ops for a node and everything left without a parent once it
 * is gone — the shared cascade of page and block deletion. */
function deleteNodeOps(rootId: string, snapshot: GraphSnapshot): Op[] {
  const parentsOf = parentsIndex(snapshot)
  const parents = (id: string): Set<string> => {
    let set = parentsOf.get(id)
    if (!set) parentsOf.set(id, (set = new Set()))
    return set
  }
  const ops: Op[] = []
  const deleted = new Set<string>()
  const queue: string[] = []
  const remove = (id: string) => {
    deleted.add(id)
    ops.push({ op: "delete", id })
    for (const link of snapshot.childLinks.get(id) ?? []) {
      parents(link.destination_id).delete(id)
      if (parents(link.destination_id).size === 0) queue.push(link.destination_id)
    }
  }
  remove(rootId)
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (deleted.has(id) || !snapshot.nodes.has(id) || parents(id).size > 0) continue
    remove(id)
  }
  return ops
}

/** Ids reachable from `rootId` through child links, the root excluded. */
function descendantsOf(snapshot: GraphSnapshot, rootId: string): Set<string> {
  const seen = new Set<string>()
  const stack = [rootId]
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

/** Cut any desired edge that would close a loop through the page: DFS the
 * prospective graph (the doc's orders over the snapshot's) and drop
 * back-edges. Reachable only through cross-page id collisions. */
function dropCycles(snapshot: GraphSnapshot, pageId: string, childrenOf: Map<string, string[]>) {
  const childrenFor = (id: string): string[] =>
    childrenOf.get(id) ?? (snapshot.childLinks.get(id) ?? []).map((link) => link.destination_id)
  const onPath = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string) => {
    if (done.has(id)) return
    onPath.add(id)
    const children = childrenFor(id)
    const keep = children.filter((childId) => !onPath.has(childId))
    if (keep.length !== children.length && childrenOf.has(id)) childrenOf.set(id, keep)
    for (const childId of keep) visit(childId)
    onPath.delete(id)
    done.add(id)
  }
  visit(pageId)
}

/**
 * The batch that makes the graph hold `doc` as page `pageId`'s content:
 *
 * - the page node created or retitled/re-propped;
 * - every block the doc holds created if the graph lacks it, else its text,
 *   type or props set where they differ — a block the graph already has
 *   (pasted as a link from elsewhere) is simply linked, one node, two links;
 * - each parent's child order reconciled against its current links, so an
 *   unchanged sibling produces nothing, an insert produces one `link` with a
 *   key between its neighbours, a removal one `unlink`;
 * - what the page reached before but no longer does, and nothing else
 *   holds, is deleted — cascading down through children that thereby lose
 *   their last parent. A block another page also holds survives untouched.
 *
 * Block ids that collide with a page id are re-minted (`docToParts`), and a
 * desired edge that would close a loop is dropped: never-lose-work over
 * rejecting the change. Applying the result to `snapshot` yields a graph
 * whose walk of `pageId` is `doc` (modulo those two repairs); applying the
 * ops for that walk again yields nothing.
 */
export function docToOps(pageId: NoteId, doc: BlockDoc, snapshot: GraphSnapshot): Op[] {
  const reserved = new Set<string>()
  for (const node of snapshot.nodes.values()) {
    if (node.type === PAGE_TYPE && node.id !== pageId) reserved.add(node.id)
  }
  const { nodes, childrenOf } = docToParts(pageId, doc, 0, reserved)
  dropCycles(snapshot, pageId, childrenOf)

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
      })
      continue
    }
    if (old.text !== node.text) sets.push({ op: "setText", id: node.id, text: node.text })
    if (old.type !== node.type) sets.push({ op: "setType", id: node.id, type: node.type })
    if (old.props !== node.props) sets.push({ op: "setProps", id: node.id, props: node.props })
  }

  // Parents after this batch: the snapshot's links, minus what is unlinked
  // here, plus what is linked — the cascade below decides on these.
  const parentsOf = parentsIndex(snapshot)
  const parents = (id: string): Set<string> => {
    let set = parentsOf.get(id)
    if (!set) parentsOf.set(id, (set = new Set()))
    return set
  }

  for (const [parentId, desired] of childrenOf) {
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

  // Cascade: what the page reached but the doc no longer names, and that
  // nothing holds any more — down through children left without a parent.
  const kept = new Set(nodes.map((node) => node.id))
  const queue = [...descendantsOf(snapshot, pageId)].filter((id) => !kept.has(id))
  const deleted = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (deleted.has(id) || !snapshot.nodes.has(id) || parents(id).size > 0) continue
    deleted.add(id)
    deletes.push({ op: "delete", id })
    for (const link of snapshot.childLinks.get(id) ?? []) {
      const child = link.destination_id
      parents(child).delete(id)
      if (parents(child).size === 0 && !kept.has(child)) queue.push(child)
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
