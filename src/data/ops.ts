import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import type { BlockDoc } from "../blocks/types"
import type { NoteId } from "../schema"
import { linkPropsOf } from "../blocks/link"
import { imagePropsOf } from "../blocks/image"
import {
  CHILD_KIND,
  NOTE_TYPE,
  docToParts,
  parseProps,
  reconcileSortKeys,
  sortKeyBetween,
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
 * The editor still edits a doc (the walk of its note); `docToOps` turns the
 * doc it hands back into the batch that makes the graph agree with it —
 * creating a block is one `create` and one `link`, typing is one `setText`,
 * a reorder is the links whose keys had to move, and a block the doc no longer
 * names is unlinked — and kept: it keeps its note (`notes_id`) and turns up
 * in that note's Unassigned basket (`basket.ts`) with everything beneath it,
 * unless it is blank (no text but whitespace, nothing beneath it, no
 * picture), which is deleted. Only the basket (`basketToOps`), the context
 * menu's Delete (`deleteBlockOps`) and deleting the note (`deleteNoteOps`)
 * delete a block that has something in it, and no delete ever cascades.
 */
export type Op =
  | {
      op: "create"
      id: string
      type: string
      text: string
      props: string | null
      /** The note the block is written in (the `notes_id` column); absent for a note root. */
      notesId?: NoteId
    }
  | { op: "setText"; id: string; text: string }
  | { op: "setType"; id: string; type: string }
  | { op: "setProps"; id: string; props: string | null }
  | { op: "link"; source: string; destination: string; sortKey: string }
  | { op: "unlink"; source: string; destination: string }
  | { op: "delete"; id: string }

/** Parent order: by source id (unique per destination). */
const byParent = (a: LinkRow, b: LinkRow) =>
  a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0

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
  const parentLinks = new Map(snapshot.parentLinks)
  // Copy a list once per batch, however many of its links change. Both
  // directions are kept in step per op: a link row lands in its source's
  // child list and its destination's parent list, and leaves both together.
  const touched = new Set<string>()
  const touchedParents = new Set<string>()
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
  const parentsOf = (destination: string): LinkRow[] => {
    let list = parentLinks.get(destination)
    if (!list) {
      list = []
      parentLinks.set(destination, list)
      touchedParents.add(destination)
    } else if (!touchedParents.has(destination)) {
      list = [...list]
      parentLinks.set(destination, list)
      touchedParents.add(destination)
    }
    return list
  }
  const dropChild = (source: string, destination: string) => {
    if (!childLinks.has(source)) return
    const list = listOf(source)
    const at = list.findIndex((link) => link.destination_id === destination)
    if (at !== -1) list.splice(at, 1)
    if (list.length === 0) childLinks.delete(source)
  }
  const dropParent = (source: string, destination: string) => {
    if (!parentLinks.has(destination)) return
    const list = parentsOf(destination)
    const at = list.findIndex((link) => link.source_id === source)
    if (at !== -1) list.splice(at, 1)
    if (list.length === 0) parentLinks.delete(destination)
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
        const row: LinkRow = {
          source_id: op.source,
          destination_id: op.destination,
          kind: CHILD_KIND,
          sort_key: op.sortKey,
          updated_at: now,
        }
        const list = listOf(op.source)
        const at = list.findIndex((link) => link.destination_id === op.destination)
        if (at !== -1) list.splice(at, 1)
        list.push(row)
        list.sort(byOrder)
        const parents = parentsOf(op.destination)
        const up = parents.findIndex((link) => link.source_id === op.source)
        if (up !== -1) parents.splice(up, 1)
        parents.push(row)
        parents.sort(byParent)
        break
      }
      case "unlink": {
        dropChild(op.source, op.destination)
        dropParent(op.source, op.destination)
        break
      }
      case "delete": {
        if (!nodes.delete(op.id)) break
        // Its links go with it in both directions: the ones it holds leave
        // their destinations' parent lists, the ones holding it leave their
        // sources' child lists — each found through the index, never by scan.
        for (const link of childLinks.get(op.id) ?? []) dropParent(op.id, link.destination_id)
        for (const link of parentLinks.get(op.id) ?? []) dropChild(link.source_id, op.id)
        childLinks.delete(op.id)
        parentLinks.delete(op.id)
        break
      }
    }
  }
  return { nodes, childLinks, parentLinks }
}

/** Every node's parents (sources of the child links into it), as sets the
 * caller may mutate while planning a batch (`partsToOps`). */
export function parentsIndex(snapshot: GraphSnapshot): Map<string, Set<string>> {
  const parentsOf = new Map<string, Set<string>>()
  for (const [destination, list] of snapshot.parentLinks) {
    parentsOf.set(destination, new Set(list.map((link) => link.source_id)))
  }
  return parentsOf
}

/** Ids reachable from `rootIds` through child links — down, what the roots
 * hold; or up, what holds them — the roots excluded unless reached again.
 * Path-safe: a node is visited once. The one reachability helper: the
 * basket, deletes, the notes a batch touches and the walk's guards all
 * ask this. */
export function reachableFrom(
  snapshot: GraphSnapshot,
  rootIds: Iterable<string>,
  direction: "down" | "up" = "down",
): Set<string> {
  const seen = new Set<string>()
  const stack = [...rootIds]
  while (stack.length > 0) {
    const id = stack.pop() as string
    const links = direction === "down" ? snapshot.childLinks.get(id) : snapshot.parentLinks.get(id)
    for (const link of links ?? []) {
      const next = direction === "down" ? link.destination_id : link.source_id
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  return seen
}

/** Every note node's id. */
export function noteIds(snapshot: GraphSnapshot): string[] {
  const ids: string[] = []
  for (const node of snapshot.nodes.values()) if (node.type === NOTE_TYPE) ids.push(node.id)
  return ids
}

/**
 * Delete a note: its node, and its content — every block the note reaches
 * that no other note reaches, plus the blocks written in it that nothing
 * reaches at all (its Unassigned basket). A block another note also holds
 * survives (the note's link to it is simply gone).
 */
export function deleteNoteOps(noteId: NoteId, snapshot: GraphSnapshot): Op[] {
  const note = snapshot.nodes.get(noteId)
  if (!note || note.type !== NOTE_TYPE) return []
  const others = reachableFrom(
    snapshot,
    noteIds(snapshot).filter((id) => id !== noteId),
  )
  const doomed = new Set<string>([noteId])
  for (const id of reachableFrom(snapshot, [noteId])) if (!others.has(id)) doomed.add(id)
  for (const node of snapshot.nodes.values()) {
    if (node.notes_id === noteId && !others.has(node.id)) doomed.add(node.id)
  }
  return [...doomed].map((id) => ({ op: "delete", id }))
}

/** How many parents hold a block — the number of places it appears across
 * the corpus (0 for an unknown or orphaned node). */
export function parentCount(snapshot: GraphSnapshot, id: string): number {
  return snapshot.parentLinks.get(id)?.length ?? 0
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
  if (!node || node.type === NOTE_TYPE) return []
  const unlinks: Op[] = (snapshot.parentLinks.get(blockId) ?? []).map((link) => ({
    op: "unlink",
    source: link.source_id,
    destination: blockId,
  }))
  // What it held goes to the basket — except the blank ones, which have
  // nothing in them to rescue (`strandedBlankOps`).
  const parents = parentLookup(snapshot)
  for (const link of snapshot.parentLinks.get(blockId) ?? [])
    parents(blockId).delete(link.source_id)
  const deleted = new Set([blockId])
  return [
    ...unlinks,
    { op: "delete", id: blockId },
    ...strandedBlankOps(snapshot, parents, deleted),
  ]
}

/**
 * Delete a block and everything beneath it that nothing else holds: the
 * block itself from every place it appears (as `deleteBlockOps`), and each
 * block reachable from it that no note, and no other block outside the
 * subtree, still reaches once it is gone. A block that also hangs from
 * another note, or from another Unassigned root, is only unlinked from the
 * subtree and survives. The basket's "Delete with contents".
 */
export function deleteSubtreeOps(blockId: string, snapshot: GraphSnapshot): Op[] {
  const node = snapshot.nodes.get(blockId)
  if (!node || node.type === NOTE_TYPE) return []
  const below = reachableFrom(snapshot, [blockId])
  below.delete(blockId)
  // What the rest of the graph still reaches without going through the
  // block: every note, and every parentless block (an Unassigned root of
  // any note) other than this one, walked around the block.
  const parentsOf = parentsIndex(snapshot)
  const roots = noteIds(snapshot).filter((id) => id !== blockId)
  for (const other of snapshot.nodes.values()) {
    if (other.id === blockId || other.type === NOTE_TYPE) continue
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
  // The survivors these deletes set loose head for the basket; the blank
  // ones do not (`strandedBlankOps`).
  const parents = parentLookup(snapshot)
  const deleted = new Set(doomed)
  const blanks = strandedBlankOps(snapshot, parents, deleted, kept)
  return [...unlinks, ...[...doomed].map((id) => ({ op: "delete", id }) as Op), ...blanks]
}
/**
 * The batch that makes the graph hold `doc` as note `noteId`'s content:
 *
 * - the note node created or retitled/re-propped;
 * - every block the doc holds created if the graph lacks it — with this note
 *   as its `notes_id` — else its text, type or props set where they differ; a block the
 *   graph already has (pasted as a link from elsewhere) is simply linked, one
 *   node, two links;
 * - each parent's child order reconciled against its current links, so an
 *   unchanged sibling produces nothing, an insert produces one `link` with a
 *   key between its neighbours, a removal one `unlink`;
 * - a block the note reached before but the doc no longer names, that nothing
 *   holds any more, is kept, out of reach: it and everything beneath it show
 *   in the note's Unassigned basket (`basket.ts`), from which a paste links
 *   it back. Removing a row is an unlink, never a delete — except a blank
 *   block (`isBlankNode`), which is deleted so an abandoned empty line leaves
 *   nothing behind. A block another note also holds survives untouched.
 *
 * Block ids that collide with a note id are re-minted (`docToParts`), and a
 * block is never linked under itself; any other loop is a shape the graph
 * holds (docs/graph-schema-v2.md, "Loops"). Applying the result to
 * `snapshot` yields a graph whose walk of `noteId` is `doc` (modulo those
 * two repairs); applying the ops for that walk again yields nothing.
 *
 * The doc may be a lazy walk (`walkGraph`): a block whose children were not
 * walked in still carries their ids, so its child order is the graph's and
 * reconciles to nothing, and the blocks beneath it, absent from `nodes`,
 * keep their parent and are never dropped. `rootId` names the doc's root
 * when it is a block rather than the note (the focused page).
 */
export function docToOps(
  noteId: NoteId,
  doc: BlockDoc,
  snapshot: GraphSnapshot,
  discard?: Iterable<string>,
  rootId: string = noteId,
): Op[] {
  const { nodes, childrenOf, upstreamOf } = docToParts(
    noteId,
    doc,
    0,
    reservedNoteIds(snapshot, noteId),
  )
  if (rootId !== noteId) {
    // A doc rooted at a block (the focused page, `blockView`): its one root is
    // the block, walked as a block, so its own text and children are diffed
    // like any other's — a rename of the focus title is a `setText` on it.
    // The note node and the note's root order are not this doc's to say
    // anything about: dropped, as the basket drops them (`basketToOps`).
    const blocks = nodes.filter((node) => node.id !== noteId)
    childrenOf.delete(noteId)
    return partsToOps(
      noteId,
      blocks,
      childrenOf,
      snapshot,
      reachableFrom(snapshot, [rootId]),
      "keep",
      new Set(discard ?? []),
      upstreamOf,
    )
  }
  return partsToOps(
    noteId,
    nodes,
    childrenOf,
    snapshot,
    reachableFrom(snapshot, [noteId]),
    "keep",
    new Set(discard ?? []),
    upstreamOf,
  )
}

/**
 * A block with nothing in it: no text but whitespace, and no picture (an
 * image row's text is its caption; its picture is in its props, and a
 * placeholder whose upload failed has none) or address (a link block's text
 * is its title; its address is in its props). Blank blocks are what backing
 * out of an empty line leaves behind, so the outline deletes them rather
 * than parking them in the basket.
 *
 * What a block HOLDS is not what is in it. A blank block that holds
 * something is still blank — an empty line that happens to have a line
 * indented under it — and parking one in the basket puts an empty row
 * there, saying nothing, with the rows that actually needed rescuing hidden
 * beneath it. `strandedBlankOps` deletes it and lets what it held stand in
 * the basket in its own right.
 */
function isBlankNode(snapshot: GraphSnapshot, id: string): boolean {
  const node = snapshot.nodes.get(id)
  if (!node) return true
  if (node.text.trim() !== "") return false
  if (node.type === "image") {
    const image = imagePropsOf({ props: parseProps(node.props) })
    if (image.image || image.src) return false
  }
  if (node.type === "link" && linkPropsOf({ props: parseProps(node.props) }).url !== "") {
    return false
  }
  return true
}

/**
 * The deletes that keep a batch from stranding blank blocks in the basket.
 *
 * A delete takes the node's links with it, so every block a batch deletes
 * sets loose whatever it held: those blocks keep their note and show in its
 * Unassigned basket, which is exactly the rescue the basket is for. A blank
 * block is not worth rescuing — there is nothing in it — so it is deleted
 * instead, and what IT held is considered in turn, down as far as the blanks
 * go. A block anything still holds, and a block with something in it, are
 * both left alone: only blanks, and only ones nothing holds.
 *
 * `parentsOf` is what holds each block once the batch's own links are
 * applied (mutated as these deletes take more links away), `deleted` what
 * the batch already deletes (added to here, so nothing is deleted twice) and
 * `kept` the blocks the caller's document still names.
 */
function strandedBlankOps(
  snapshot: GraphSnapshot,
  parentsOf: (id: string) => Set<string>,
  deleted: Set<string>,
  kept: ReadonlySet<string> = new Set(),
): Op[] {
  const ops: Op[] = []
  const loose: string[] = []
  const loosen = (id: string) => {
    for (const link of snapshot.childLinks.get(id) ?? []) {
      parentsOf(link.destination_id).delete(id)
      loose.push(link.destination_id)
    }
  }
  for (const id of [...deleted]) loosen(id)
  for (let i = 0; i < loose.length; i += 1) {
    const id = loose[i]
    if (deleted.has(id) || kept.has(id) || !snapshot.nodes.has(id)) continue
    if (parentsOf(id).size > 0 || !isBlankNode(snapshot, id)) continue
    deleted.add(id)
    ops.push({ op: "delete", id })
    loosen(id)
  }
  return ops
}

/** The mutable parent index a batch plans against: `parentsIndex`, with a
 * reader that makes an entry for a block that had no parents. */
function parentLookup(snapshot: GraphSnapshot): (id: string) => Set<string> {
  const index = parentsIndex(snapshot)
  return (id: string): Set<string> => {
    let set = index.get(id)
    if (!set) index.set(id, (set = new Set()))
    return set
  }
}

/** Every other note's id — ids a block row must never take (`docToParts`). */
export function reservedNoteIds(snapshot: GraphSnapshot, noteId: string): Set<string> {
  const reserved = new Set<string>()
  for (const node of snapshot.nodes.values()) {
    if (node.type === NOTE_TYPE && node.id !== noteId) reserved.add(node.id)
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
 *
 * `upstreamOf` is what each block walked upstream names as its parents
 * (`Block.upstream`). The child lists are the truth of an edge wherever
 * both ends are in the doc — the doc maths keep the two lists as mirrors
 * (src/blocks/ops.ts) — so a parent list only speaks for a parent whose
 * own child list is not here to speak: a parent row removed from beneath
 * a block, and gone from the doc with it, is unlinked from it; a parent
 * named that the doc does not hold is linked, after its last child.
 */
export function partsToOps(
  noteId: NoteId,
  nodes: NodeRow[],
  childrenOf: Map<string, string[]>,
  snapshot: GraphSnapshot,
  reachedBefore: Set<string>,
  dropped: "keep" | "delete",
  discard: ReadonlySet<string> = new Set(),
  upstreamOf: Map<string, string[]> = new Map(),
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
        ...(node.type === NOTE_TYPE ? {} : { notesId: noteId }),
      })
      continue
    }
    if (old.text !== node.text) sets.push({ op: "setText", id: node.id, text: node.text })
    if (old.type !== node.type) sets.push({ op: "setType", id: node.id, type: node.type })
    if (old.props !== node.props) sets.push({ op: "setProps", id: node.id, props: node.props })
  }

  // Parents after this batch: the snapshot's links, minus what is unlinked
  // here, plus what is linked — what decides the deletes below.
  const parents = parentLookup(snapshot)

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

  for (const [id, wanted] of upstreamOf) {
    const wantedSet = new Set(wanted.filter((parentId) => parentId !== id))
    const existing = (snapshot.parentLinks.get(id) ?? []).map((link) => link.source_id)
    for (const parentId of existing) {
      if (wantedSet.has(parentId) || childrenOf.has(parentId)) continue
      linkOps.push({ op: "unlink", source: parentId, destination: id })
      parents(id).delete(parentId)
    }
    for (const parentId of wantedSet) {
      if (existing.includes(parentId) || childrenOf.has(parentId)) continue
      const last = snapshot.childLinks.get(parentId)?.at(-1)?.sort_key ?? null
      linkOps.push({
        op: "link",
        source: parentId,
        destination: id,
        sortKey: sortKeyBetween(last, null),
      })
      parents(id).add(parentId)
    }
  }

  // What was reached before, is no longer named, and nothing holds: dropped.
  // No cascade — a deleted block's children keep their links from it (the
  // store retains them, the walk skips them) and their note, and turn up in
  // the basket.
  const kept = new Set(nodes.map((node) => node.id))
  const deleted = new Set<string>()
  for (const id of reachedBefore) {
    if (kept.has(id) || !snapshot.nodes.has(id) || parents(id).size > 0) continue
    if (dropped === "delete" || discard.has(id) || isBlankNode(snapshot, id)) deleted.add(id)
  }
  for (const id of deleted) deletes.push({ op: "delete", id })
  // The blocks those deletes set loose: blank ones go too, rather than
  // standing in the basket in front of what they held.
  deletes.push(...strandedBlankOps(snapshot, parents, deleted, kept))

  return [...creates, ...sets, ...linkOps, ...deletes]
}

/** The note ids a batch touches — the notes whose rollups changed (every
 * note that reaches a node the batch names). */
export function notesTouchedBy(snapshot: GraphSnapshot, ops: readonly Op[]): Set<NoteId> {
  const ids = new Set<string>()
  for (const op of ops) {
    if (op.op === "link" || op.op === "unlink") {
      ids.add(op.source)
      ids.add(op.destination)
    } else ids.add(op.id)
  }
  const notes = new Set<NoteId>()
  for (const id of [...ids, ...reachableFrom(snapshot, ids, "up")]) {
    if (snapshot.nodes.get(id)?.type === NOTE_TYPE) notes.add(id)
  }
  return notes
}
