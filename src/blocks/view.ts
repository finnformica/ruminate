import type { Block, BlockDoc } from "./types"

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
  /**
   * This occurrence closes a loop: the block is already on the path above it
   * (`a/b/a`). It is shown once here, as a leaf — nothing beneath it is
   * walked, so the outline ends where the loop closes. Zooming into it starts
   * a fresh path, which is how a reader descends deliberately.
   */
  looped?: boolean
}

/** One step of `walkDoc`. */
export interface DocWalkStep {
  block: Block
  key: string
  parentKey: string | null
  depth: number
  index: number
  /** The block is already on the current path: shown here, not descended. */
  looped: boolean
}

/**
 * Depth-first over a doc's occurrences from `ids`: every path from a root
 * to a block, a block reached by two paths visited twice. The one rule every
 * walk over a doc shares: a block already on the current path is visited
 * once more as a leaf (`looped`) and never descended, so a doc holding a
 * loop (docs/graph-schema-v2.md, "Loops") ends where the loop closes rather
 * than hanging. Return `false` from `visit` to skip a block's children.
 */
export function walkDoc(
  doc: BlockDoc,
  ids: string[],
  visit: (step: DocWalkStep) => boolean | void,
  parentKey: string | null = null,
  depth = 0,
  path: Set<string> = new Set(),
): void {
  ids.forEach((id, index) => {
    const block = doc.blocks[id]
    if (!block) return
    const looped = path.has(id)
    const key = keyOf(parentKey, id)
    const descend = visit({ block, key, parentKey, depth, index, looped })
    if (looped || descend === false) return
    path.add(id)
    walkDoc(doc, block.children, visit, key, depth + 1, path)
    path.delete(id)
  })
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
 * reachable twice yields two keys; a loop's closing occurrence is one key
 * (`walkDoc`).
 */
export function occurrenceKeys(doc: BlockDoc): string[] {
  const keys: string[] = []
  walkDoc(doc, doc.rootBlockIds, ({ key }) => {
    keys.push(key)
  })
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
export function olPositions(doc: BlockDoc, ids: string[]): number[] {
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
      if (!block) return
      // The block is already on the path above: this row closes a loop. It is
      // a leaf here — no toggle, nothing beneath — so the outline ends where
      // the loop closes (zoom into it to go round again).
      const looped = path.has(id)
      const key = keyOf(parentKey, id)
      const hasChildren = !looped && block.children.length > 0
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
        ...(looped ? { looped: true } : {}),
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
