import { olPositions } from "./ops"
import type { BlockDoc } from "./types"

/**
 * The view: the flat list of rows a document renders as.
 *
 * A block is a node; where it shows up on screen is an **occurrence** — one
 * per path from a root to the block, so a node reachable from two parents is
 * two rows sharing one block. Everything positional keys by the occurrence:
 * React keys, folds, the guide lines. (Selection and focus still key by block
 * id while the commands do — see docs/graph-native-app.md.)
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
    const key = firstOccurrenceKey(doc, zoomRoot.id) ?? zoomRoot.id
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
