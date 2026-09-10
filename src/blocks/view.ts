import type { BlockDoc } from "./types"

/**
 * The view: the flat list of rows a document renders as.
 *
 * A block is a node; where it shows up on screen is an **occurrence** — one
 * per path from a root to the block, so a node reachable from two parents is
 * two rows sharing one block. Everything positional keys by the occurrence:
 * React keys, folds, the guide lines, selection and focus, and the position
 * a command acts on (`src/blocks/commands.ts`). A block's own fields — its
 * text and type — are the node's, addressed by id.
 *
 * The key is the path of ids from the root, joined by `/` (ids never contain
 * one): a root's key is its id, its child's is `root/child`, and so on. Keys
 * are stable across edits that leave the path intact, and readable in
 * storage (folds are persisted by key, src/data/view-state.ts).
 */
export interface Occurrence {
  key: string
  id: string
  parentKey: string | null
  /** Indentation: the number of guide lines to the row's left. */
  depth: number
  /** Position among its siblings (0-based). */
  index: number
  /** An ordered item's number — its position in the run of ordered siblings. */
  olNumber: number
  hasChildren: boolean
  /** Folded here: the children are not rows. */
  collapsed: boolean
  /** The keys of the rows this one is indented under, outermost first —
   * exactly `depth` of them; `guideKeys[k]` owns the guide line at level k. */
  guideKeys: string[]
  /** The zoomed block, rendered as the view's title (no toggle, no guides). */
  zoomTitle: boolean
}

/** The key of `id` occurring under `parentKey` (null = a root). */
export function keyOf(parentKey: string | null, id: string): string {
  return parentKey === null ? id : `${parentKey}/${id}`
}

/** The block id an occurrence key names (its last segment). */
export function idOfKey(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1)
}

/** The key of the occurrence this one hangs under, or null for a root. */
export function parentKeyOf(key: string): string | null {
  const at = key.lastIndexOf("/")
  return at === -1 ? null : key.slice(0, at)
}

/** The keys of an occurrence's ancestors, nearest first (empty for a root). */
export function ancestorKeys(key: string): string[] {
  const out: string[] = []
  let parent = parentKeyOf(key)
  while (parent !== null) {
    out.push(parent)
    parent = parentKeyOf(parent)
  }
  return out
}

/** Is `key` the occurrence `ancestor` or one beneath it? */
export function isWithin(key: string, ancestor: string): boolean {
  return key === ancestor || key.startsWith(`${ancestor}/`)
}

/** Does the document have this occurrence — is the key a real path? */
export function hasOccurrence(doc: BlockDoc, key: string): boolean {
  const ids = key.split("/")
  if (!doc.rootBlockIds.includes(ids[0])) return false
  for (let i = 1; i < ids.length; i += 1) {
    const parent = doc.blocks[ids[i - 1]]
    if (!parent || !parent.children.includes(ids[i])) return false
  }
  return doc.blocks[ids[ids.length - 1]] !== undefined
}

/**
 * Every occurrence key of the document, depth-first, folds ignored. A block
 * reachable twice yields two keys. Guards against a cycle (a doc built by
 * hand — the graph walk never produces one) by not re-entering an id already
 * on the current path.
 */
export function occurrenceKeys(doc: BlockDoc): string[] {
  const keys: string[] = []
  const path = new Set<string>()
  const walk = (ids: string[], parentKey: string | null) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block || path.has(id)) continue
      const key = keyOf(parentKey, id)
      keys.push(key)
      path.add(id)
      walk(block.children, key)
      path.delete(id)
    }
  }
  walk(doc.rootBlockIds, null)
  return keys
}

/** The first occurrence (document order) of a block, or null. */
export function firstOccurrenceKey(doc: BlockDoc, id: string): string | null {
  const suffix = `/${id}`
  for (const key of occurrenceKeys(doc)) {
    if (key === id || key.endsWith(suffix)) return key
  }
  return null
}

/** The key the zoomed block is addressed by: its first occurrence in the
 * document (so a fold made while zoomed is the same fold un-zoomed), or its
 * bare id when the document does not reach it. */
export function zoomRootKey(doc: BlockDoc, zoomRootId: string): string {
  return firstOccurrenceKey(doc, zoomRootId) ?? zoomRootId
}

/**
 * The 1-based position of each of `ids` in its run of consecutive ordered
 * siblings (0 for anything that isn't an ordered item) — the number an `ol`
 * block shows, which is a fact of its position, not of its text.
 */
function olPositions(doc: BlockDoc, ids: string[]): number[] {
  let run = 0
  return ids.map((id) => {
    run = doc.blocks[id]?.type === "ol" ? run + 1 : 0
    return run
  })
}

/**
 * The rows of a view: depth-first from the roots (or from the zoomed block),
 * with folds applied — a collapsed occurrence's children are not rows.
 *
 * Zoomed, the zoom root leads as the view's title and its children start
 * again at depth 0, so the zoomed subtree reads as a page of its own. The
 * root's key is its first occurrence in the document, so a fold made while
 * zoomed is the same fold un-zoomed.
 */
export function buildRows(
  doc: BlockDoc,
  { zoomRootId = null, folds }: { zoomRootId?: string | null; folds: ReadonlySet<string> },
): Occurrence[] {
  const rows: Occurrence[] = []
  const path = new Set<string>()
  const walk = (ids: string[], parentKey: string | null, depth: number, guideKeys: string[]) => {
    const numbers = olPositions(doc, ids)
    ids.forEach((id, index) => {
      const block = doc.blocks[id]
      if (!block || path.has(id)) return
      const key = keyOf(parentKey, id)
      const hasChildren = block.children.length > 0
      const collapsed = hasChildren && folds.has(key)
      rows.push({
        key,
        id,
        parentKey,
        depth,
        index,
        olNumber: numbers[index],
        hasChildren,
        collapsed,
        guideKeys,
        zoomTitle: false,
      })
      if (hasChildren && !collapsed) {
        path.add(id)
        walk(block.children, key, depth + 1, [...guideKeys, key])
        path.delete(id)
      }
    })
  }

  const zoomRoot = zoomRootId ? doc.blocks[zoomRootId] : undefined
  if (zoomRoot) {
    const key = zoomRootKey(doc, zoomRoot.id)
    rows.push({
      key,
      id: zoomRoot.id,
      parentKey: null,
      depth: 0,
      index: 0,
      olNumber: 1,
      hasChildren: zoomRoot.children.length > 0,
      // The title is always open — its children are the page.
      collapsed: false,
      guideKeys: [],
      zoomTitle: true,
    })
    path.add(zoomRoot.id)
    walk(zoomRoot.children, key, 0, [])
  } else {
    walk(doc.rootBlockIds, null, 0, [])
  }
  return rows
}
