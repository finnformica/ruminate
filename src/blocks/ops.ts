import { blockId } from "./id"
import type { Block, BlockDoc, BlockProps, BlockType } from "./types"
import { hasOccurrence, idOfKey, keyOf, parentKeyOf } from "./view"

/**
 * Immutable operations on a BlockDoc. Each returns a new doc; the original is
 * untouched. Page props are carried through unchanged. Collapse state is a
 * UI-only concern and lives in the editor component, not here.
 *
 * A block's own fields (text, type) are addressed by **id**: they belong to
 * the node wherever it appears. Anything positional — insert beside, move,
 * indent, remove, duplicate — is addressed by **occurrence key** (the path of
 * ids from a root, `src/blocks/view.ts`), because a block reachable from two
 * parents has two positions and the key says which one is meant. The parent
 * is read off the key, never searched for.
 */

export function emptyBlock(type: BlockType = "text", text = ""): Block {
  return { id: blockId(), type, text, children: [] }
}

/** Nothing worth saving: no page props and no block carrying any text. */
export function isEmptyDoc(doc: BlockDoc): boolean {
  if (doc.props !== null && Object.keys(doc.props).length > 0) return false
  return Object.values(doc.blocks).every(
    (block) => block.type === "text" && block.text === "" && !block.props,
  )
}

function clone(doc: BlockDoc): BlockDoc {
  return {
    props: doc.props,
    rootBlockIds: [...doc.rootBlockIds],
    blocks: { ...doc.blocks },
  }
}

/** The ordered children of a parent (null = the root list). */
function siblingList(doc: BlockDoc, parentId: string | null): string[] {
  return parentId === null ? doc.rootBlockIds : doc.blocks[parentId].children
}

/** Replace a parent's child list (null = the root list) in a cloned doc. */
function setSiblingList(next: BlockDoc, parentId: string | null, list: string[]): void {
  if (parentId === null) next.rootBlockIds = list
  else next.blocks[parentId] = { ...next.blocks[parentId], children: list }
}

/**
 * An occurrence's place in the tree: the key and id of its parent (null at
 * the root), the ordered ids of its sibling group, and its own index within
 * them. `null` when the key is not a path the document has.
 */
export function siblingsOf(
  doc: BlockDoc,
  key: string,
): { parentKey: string | null; parentId: string | null; siblings: string[]; index: number } | null {
  if (!hasOccurrence(doc, key)) return null
  const parentKey = parentKeyOf(key)
  const parentId = parentKey === null ? null : idOfKey(parentKey)
  const siblings = siblingList(doc, parentId)
  return { parentKey, parentId, siblings, index: siblings.indexOf(idOfKey(key)) }
}

/** Replace a block's text (its type and children untouched). */
export function updateText(doc: BlockDoc, id: string, text: string): BlockDoc {
  const block = doc.blocks[id]
  if (!block || block.text === text) return doc
  const next = clone(doc)
  next.blocks[id] = { ...block, text }
  return next
}

/** Change a block's type (its text and children untouched). */
export function updateType(doc: BlockDoc, id: string, type: BlockType): BlockDoc {
  const block = doc.blocks[id]
  if (!block || block.type === type) return doc
  const next = clone(doc)
  next.blocks[id] = { ...block, type }
  return next
}

/** A change to a block's own fields (never its children). */
export interface BlockPatch {
  text?: string
  type?: BlockType
  /** The block's props (a code block's `language`); `null` clears them. */
  props?: BlockProps | null
}

/** Apply a text, type and/or props change to one block; the doc is returned
 * as-is when nothing would change. */
export function updateBlock(doc: BlockDoc, id: string, patch: BlockPatch): BlockDoc {
  const block = doc.blocks[id]
  if (!block) return doc
  const text = patch.text ?? block.text
  const type = patch.type ?? block.type
  const props = patch.props === undefined ? block.props : patch.props
  if (text === block.text && type === block.type && props === block.props) return doc
  const next = clone(doc)
  const updated: Block = { ...block, text, type }
  if (props) updated.props = props
  else delete updated.props
  next.blocks[id] = updated
  return next
}

/** Insert `block` as a sibling immediately after the occurrence `refKey`. */
export function insertAfter(doc: BlockDoc, refKey: string, block: Block): BlockDoc {
  return insertRelative(doc, refKey, block, 1)
}

/** Insert `block` as a sibling immediately before the occurrence `refKey`. */
export function insertBefore(doc: BlockDoc, refKey: string, block: Block): BlockDoc {
  return insertRelative(doc, refKey, block, 0)
}

/** Insert `block` as the FIRST child of `parentId` (used by the zoom view,
 * where "below the title" means the top of the zoomed subtree). */
export function insertFirstChild(doc: BlockDoc, parentId: string, block: Block): BlockDoc {
  const parent = doc.blocks[parentId]
  if (!parent) return doc
  const next = clone(doc)
  next.blocks[block.id] = block
  next.blocks[parentId] = { ...parent, children: [block.id, ...parent.children] }
  return next
}

/** Splice `block` into `refKey`'s sibling list at `refIndex + offset`. */
function insertRelative(doc: BlockDoc, refKey: string, block: Block, offset: 0 | 1): BlockDoc {
  const at = siblingsOf(doc, refKey)
  if (!at) return doc
  const next = clone(doc)
  next.blocks[block.id] = block
  const list = [...at.siblings]
  list.splice(at.index + offset, 0, block.id)
  setSiblingList(next, at.parentId, list)
  return next
}

/**
 * Replace the occurrence `key` with the blocks of `sub` (a freshly parsed
 * doc), in order, at its position among its siblings. Any children of the
 * replaced block are re-parented onto the last inserted block so nothing is
 * lost. Used by paste, which parses the clipboard markdown into `sub`.
 * Returns the new doc and the id of the last inserted block (to place the
 * caret), or `null` if the key is unknown or `sub` is empty.
 */
export function spliceBlocks(
  doc: BlockDoc,
  key: string,
  sub: BlockDoc,
): { doc: BlockDoc; lastId: string } | null {
  const at = siblingsOf(doc, key)
  if (!at || sub.rootBlockIds.length === 0) return null
  const id = idOfKey(key)
  const next = clone(doc)
  for (const [bid, block] of Object.entries(sub.blocks)) next.blocks[bid] = block

  const lastId = sub.rootBlockIds[sub.rootBlockIds.length - 1]
  const orphans = next.blocks[id]?.children ?? []
  if (orphans.length > 0) {
    const last = next.blocks[lastId]
    next.blocks[lastId] = { ...last, children: [...last.children, ...orphans] }
  }

  const list = [...at.siblings]
  list.splice(at.index, 1, ...sub.rootBlockIds)
  setSiblingList(next, at.parentId, list)
  return { doc: prune(next), lastId }
}

/**
 * Insert `sub`'s root blocks as siblings immediately AFTER the occurrence
 * `targetKey`, merging `sub.blocks` into the doc. Unlike `spliceBlocks` the
 * target block survives untouched. Returns the new doc and the id of the last
 * inserted root block, or `null` if the key is unknown or `sub` is empty.
 */
export function insertBlocksAfter(
  doc: BlockDoc,
  targetKey: string,
  sub: BlockDoc,
): { doc: BlockDoc; lastId: string } | null {
  const at = siblingsOf(doc, targetKey)
  if (!at || sub.rootBlockIds.length === 0) return null
  const next = clone(doc)
  for (const [bid, block] of Object.entries(sub.blocks)) next.blocks[bid] = block
  const list = [...at.siblings]
  list.splice(at.index + 1, 0, ...sub.rootBlockIds)
  setSiblingList(next, at.parentId, list)
  return { doc: next, lastId: sub.rootBlockIds[sub.rootBlockIds.length - 1] }
}

/**
 * Insert `sub`'s root blocks as the leading children of `parentId`, merging
 * `sub.blocks` into the doc. The zoomed-view sibling of `insertBlocksAfter`:
 * pasting "after the title" means the top of its body. Returns the new doc and
 * the last inserted root id, or `null` if `parentId` is unknown or `sub` empty.
 */
export function insertBlocksAsFirstChildren(
  doc: BlockDoc,
  parentId: string,
  sub: BlockDoc,
): { doc: BlockDoc; lastId: string } | null {
  const parent = doc.blocks[parentId]
  if (!parent || sub.rootBlockIds.length === 0) return null
  const next = clone(doc)
  for (const [bid, block] of Object.entries(sub.blocks)) next.blocks[bid] = block
  next.blocks[parentId] = { ...parent, children: [...sub.rootBlockIds, ...parent.children] }
  return { doc: next, lastId: sub.rootBlockIds[sub.rootBlockIds.length - 1] }
}

/**
 * Remint any block ids in `sub` (a freshly parsed clipboard fragment) that
 * already exist in `doc`, so merging the two never clobbers an existing block —
 * pasting a block that still carries its `id::` line must create a copy, not
 * overwrite the original. Child references are remapped along with the ids.
 * Returns `sub` unchanged when there are no collisions.
 */
export function remintCollidingIds(sub: BlockDoc, doc: BlockDoc): BlockDoc {
  const colliding = Object.keys(sub.blocks).filter((id) => id in doc.blocks)
  if (colliding.length === 0) return sub
  const mapping = new Map<string, string>()
  for (const id of colliding) {
    let fresh = blockId()
    while (fresh in doc.blocks || fresh in sub.blocks) fresh = blockId()
    mapping.set(id, fresh)
  }
  const rename = (id: string) => mapping.get(id) ?? id
  const blocks: Record<string, Block> = {}
  for (const block of Object.values(sub.blocks)) {
    const id = rename(block.id)
    blocks[id] = { ...block, id, children: block.children.map(rename) }
  }
  return { ...sub, rootBlockIds: sub.rootBlockIds.map(rename), blocks }
}

/** Deep-copy `id`'s subtree into `into` with fresh ids; returns the copy's root id. */
function cloneSubtree(doc: BlockDoc, id: string, into: Record<string, Block>): string {
  const block = doc.blocks[id]
  const fresh = blockId()
  into[fresh] = {
    ...block,
    id: fresh,
    children: block.children.map((child) => cloneSubtree(doc, child, into)),
  }
  return fresh
}

/**
 * Duplicate the subtrees at `keys` (selection roots, in document order) with
 * fresh ids throughout, inserting the copies as one contiguous group of
 * siblings immediately after the last original (`below`) or before the first
 * (`above`) — beside the anchor's own occurrence. Returns the new doc and the
 * copies' keys, or `null` if nothing could be duplicated.
 */
export function duplicateBlocks(
  doc: BlockDoc,
  keys: string[],
  direction: "above" | "below",
): { doc: BlockDoc; copies: string[] } | null {
  const known = keys.filter((key) => hasOccurrence(doc, key))
  if (known.length === 0) return null
  const anchor = siblingsOf(doc, direction === "below" ? known[known.length - 1] : known[0])
  if (!anchor) return null
  const next = clone(doc)
  const added: Record<string, Block> = {}
  const copies = known.map((key) => cloneSubtree(doc, idOfKey(key), added))
  Object.assign(next.blocks, added)
  const list = [...anchor.siblings]
  list.splice(direction === "below" ? anchor.index + 1 : anchor.index, 0, ...copies)
  setSiblingList(next, anchor.parentId, list)
  return { doc: next, copies: copies.map((id) => keyOf(anchor.parentKey, id)) }
}

/**
 * Move a contiguous group of sibling occurrences one position up or down
 * among their shared parent's children (subtrees ride along). A no-op when
 * the keys span parents, aren't contiguous siblings, or are already at the
 * boundary.
 */
export function moveBlocks(doc: BlockDoc, keys: string[], direction: "up" | "down"): BlockDoc {
  if (keys.length === 0) return doc
  const first = siblingsOf(doc, keys[0])
  if (!first) return doc
  for (const key of keys.slice(1)) if (parentKeyOf(key) !== first.parentKey) return doc
  const list = first.siblings
  const indices = keys.map((key) => list.indexOf(idOfKey(key))).sort((a, b) => a - b)
  if (indices[0] === -1) return doc
  for (let k = 1; k < indices.length; k++) if (indices[k] !== indices[0] + k) return doc
  const lo = indices[0]
  const hi = indices[indices.length - 1]
  if (direction === "up" ? lo === 0 : hi === list.length - 1) return doc
  const next = clone(doc)
  const newList = [...list]
  const group = newList.splice(lo, indices.length)
  newList.splice(direction === "up" ? lo - 1 : lo + 1, 0, ...group)
  setSiblingList(next, first.parentId, newList)
  return next
}

/** Reorder an occurrence among its siblings, carrying its subtree with it.
 * Returns the doc unchanged when it's already at the end it's moving toward. */
export function moveBlock(doc: BlockDoc, key: string, direction: "up" | "down"): BlockDoc {
  return moveBlocks(doc, [key], direction)
}

/** `id` plus every descendant, depth-first (just `[id]` for a leaf). */
export function subtreeIds(doc: BlockDoc, id: string): string[] {
  const out: string[] = []
  const walk = (bid: string) => {
    out.push(bid)
    doc.blocks[bid]?.children.forEach(walk)
  }
  walk(id)
  return out
}

/** Drop every block the roots no longer reach. In the graph those are the
 * rows `docToOps` deletes; here they would only be dead weight. Returns the
 * same doc when nothing is unreachable. */
function prune(doc: BlockDoc): BlockDoc {
  const reachable = new Set<string>()
  const walk = (ids: string[]) => {
    for (const id of ids) {
      if (reachable.has(id) || !doc.blocks[id]) continue
      reachable.add(id)
      walk(doc.blocks[id].children)
    }
  }
  walk(doc.rootBlockIds)
  const dead = Object.keys(doc.blocks).filter((id) => !reachable.has(id))
  if (dead.length === 0) return doc
  const next = clone(doc)
  for (const id of dead) delete next.blocks[id]
  return next
}

/**
 * Remove an occurrence: unlink the block from that parent, and drop whatever
 * the document no longer reaches — its subtree, unless another occurrence
 * still holds it (a block twice in one note loses one row and keeps the
 * other). Returns a sensible occurrence to focus next: the previous sibling,
 * else the parent, else null.
 */
export function removeBlock(
  doc: BlockDoc,
  key: string,
): { doc: BlockDoc; focusKey: string | null } {
  const at = siblingsOf(doc, key)
  if (!at) return { doc, focusKey: null }
  const next = clone(doc)
  const list = [...at.siblings]
  const focusKey = at.index > 0 ? keyOf(at.parentKey, list[at.index - 1]) : at.parentKey
  list.splice(at.index, 1)
  setSiblingList(next, at.parentId, list)
  return { doc: prune(next), focusKey }
}

/**
 * Indent an occurrence: make the block the last child of its previous
 * sibling. Returns the new doc and the block's key there (`doc` unchanged,
 * same key, when it cannot indent: first in its list, or the previous
 * sibling already holds it, or the move would close a cycle).
 */
export function indentBlock(doc: BlockDoc, key: string): { doc: BlockDoc; key: string } {
  const at = siblingsOf(doc, key)
  if (!at || at.index <= 0) return { doc, key }
  const id = idOfKey(key)
  const prevId = at.siblings[at.index - 1]
  const prev = doc.blocks[prevId]
  if (prev.children.includes(id) || subtreeIds(doc, id).includes(prevId)) return { doc, key }
  const next = clone(doc)
  const list = [...at.siblings]
  list.splice(at.index, 1)
  setSiblingList(next, at.parentId, list)
  next.blocks[prevId] = { ...prev, children: [...prev.children, id] }
  return { doc: next, key: keyOf(keyOf(at.parentKey, prevId), id) }
}

/**
 * Outdent an occurrence: make the block a sibling of its parent, just after
 * it. Returns the new doc and the block's key there (`doc` unchanged, same
 * key, for a root occurrence or when the grandparent already holds it).
 */
export function outdentBlock(doc: BlockDoc, key: string): { doc: BlockDoc; key: string } {
  const at = siblingsOf(doc, key)
  if (!at || at.parentKey === null || at.parentId === null) return { doc, key }
  const id = idOfKey(key)
  const up = siblingsOf(doc, at.parentKey)
  if (!up || up.siblings.includes(id)) return { doc, key }
  const next = clone(doc)
  setSiblingList(
    next,
    at.parentId,
    at.siblings.filter((c) => c !== id),
  )
  const gList = [...up.siblings]
  gList.splice(up.index + 1, 0, id)
  setSiblingList(next, up.parentId, gList)
  return { doc: next, key: keyOf(up.parentKey, id) }
}
