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
 *
 * A path may step **upstream**: a row showing one of a block's parents
 * beneath it (the graph, not just the tree — docs/graph-schema-v2.md,
 * "Upstream"). That segment is marked `^`: `root/child/^parent` is the
 * parent of `child` shown under it. The mark keeps the two directions apart
 * (a block that is both above and below another has two rows, two keys),
 * and every helper here reads the direction off the key.
 */

/** Which way a row hangs off the row above it: a child, or a parent. */
export type Direction = "down" | "up"

/** The mark an upstream segment carries. Ids never start with it. */
const UP = "^"
export interface Occurrence {
  key: string
  id: string
  /** A parent of the row above, shown beneath it (`^` in the key). */
  direction: Direction
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
  /**
   * This occurrence closes a loop: the block is already on the path above it
   * (`a/b/a`). It is shown once here, as a leaf — nothing beneath it is
   * walked, so the outline ends where the loop closes. Zooming into it starts
   * a fresh path, which is how a reader descends deliberately.
   */
  looped?: boolean
}

/**
 * The fold rule a walk descends by: is the occurrence `key`, `level` steps
 * below the walk's root, open? A note's roots are level 1; a zoomed block is
 * level 0 and its children level 1. The rule is the reader's explicit folds
 * over the depth setting (`src/data/view-state.ts`), and the graph walk
 * (`walkGraph`, src/data/graph.ts) only descends where it says so.
 */
export type ExpandedRule = (key: string, level: number) => boolean

/** One step of `walkDoc`. */
export interface DocWalkStep {
  block: Block
  key: string
  direction: Direction
  parentKey: string | null
  depth: number
  index: number
  /** The block is already on the current path: shown here, not descended. */
  looped: boolean
}

/**
 * The rows beneath an occurrence, in the order they are shown: the block's
 * children, then its parents that are not already on the path above it (a
 * block's own parent is never listed under it — that is where it came
 * from). Beneath a parent row (`direction` up) a child on the path is
 * skipped too: the block it was reached up from is not something it holds
 * beneath it, but where the row came from. `path` holds the ids on the
 * path, the view's root included.
 */
export function rowsBeneath(
  doc: BlockDoc,
  block: Block | null,
  path: ReadonlySet<string>,
  direction: Direction = "down",
): { id: string; direction: Direction }[] {
  const children = block ? block.children : doc.rootBlockIds
  const upstream = block ? (block.upstream ?? []) : (doc.upstream ?? [])
  const down = direction === "up" ? children.filter((id) => !path.has(id)) : children
  return [
    ...down.map((id) => ({ id, direction: "down" as const })),
    ...upstream.filter((id) => !path.has(id)).map((id) => ({ id, direction: "up" as const })),
  ]
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
  direction: Direction = "down",
): void {
  ids.forEach((id, index) => {
    const block = doc.blocks[id]
    if (!block) return
    const looped = path.has(id)
    const key = keyOf(parentKey, id, direction)
    const descend = visit({ block, key, direction, parentKey, depth, index, looped })
    if (looped || descend === false) return
    path.add(id)
    // Beneath a parent row, the block it was reached up from is not a row.
    const down =
      direction === "up" ? block.children.filter((child) => !path.has(child)) : block.children
    walkDoc(doc, down, visit, key, depth + 1, path)
    // Its parents beneath its children, those on the path above skipped.
    const up = (block.upstream ?? []).filter((parent) => !path.has(parent))
    if (up.length > 0) walkDoc(doc, up, visit, key, depth + 1, path, "up")
    path.delete(id)
  })
  // At the top level, the root's own parents after the roots.
  if (parentKey === null && direction === "down" && doc.upstream && ids === doc.rootBlockIds) {
    const up = doc.upstream.filter((parent) => !path.has(parent))
    if (up.length > 0) walkDoc(doc, up, visit, null, depth, path, "up")
  }
}

/** The key of `id` occurring under `parentKey` (null = a root), as a child
 * or — `"up"` — as one of the parent row's parents. */
export function keyOf(parentKey: string | null, id: string, direction: Direction = "down"): string {
  const segment = direction === "up" ? `${UP}${id}` : id
  return parentKey === null ? segment : `${parentKey}/${segment}`
}

/** The key of `id` as a sibling of the occurrence `key`: same parent, same
 * direction. */
export function siblingKey(key: string, id: string): string {
  return keyOf(parentKeyOf(key), id, directionOfKey(key))
}

/** Which way an occurrence hangs off the row above it. */
export function directionOfKey(key: string): Direction {
  return key.charAt(key.lastIndexOf("/") + 1) === UP ? "up" : "down"
}

/** The block id an occurrence key names (its last segment, unmarked). */
export function idOfKey(key: string): string {
  const segment = key.slice(key.lastIndexOf("/") + 1)
  return segment.startsWith(UP) ? segment.slice(1) : segment
}

/** The id a key segment names. */
const idOfSegment = (segment: string) => (segment.startsWith(UP) ? segment.slice(1) : segment)

/** The key of the occurrence this one hangs under, or null for a root. */
export function parentKeyOf(key: string): string | null {
  const at = key.lastIndexOf("/")
  return at === -1 ? null : key.slice(0, at)
}

/** The ids on an occurrence's path, root first, the occurrence's own last. */
export function pathIdsOf(key: string): string[] {
  return key.split("/").map(idOfSegment)
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
  const segments = key.split("/")
  const rootId = idOfSegment(segments[0])
  const rootList = segments[0].startsWith(UP) ? (doc.upstream ?? []) : doc.rootBlockIds
  if (!rootList.includes(rootId)) return false
  for (let i = 1; i < segments.length; i += 1) {
    const parent = doc.blocks[idOfSegment(segments[i - 1])]
    if (!parent) return false
    const list = segments[i].startsWith(UP) ? (parent.upstream ?? []) : parent.children
    if (!list.includes(idOfSegment(segments[i]))) return false
  }
  return doc.blocks[idOfSegment(segments[segments.length - 1])] !== undefined
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
 * again at depth 0, so the zoomed subtree reads as a note of its own. The
 * root's key is its first occurrence in the document, so a fold made while
 * zoomed is the same fold un-zoomed.
 */
export function buildRows(
  doc: BlockDoc,
  {
    zoomRootId = null,
    folds,
    rootId = null,
  }: {
    zoomRootId?: string | null
    folds: ReadonlySet<string>
    /** The id of the view's own root when it is not a block in the doc (the
     * note): on the path from the start, so a block's parent that is the
     * note is never listed beneath it. */
    rootId?: string | null
  },
): Occurrence[] {
  const rows: Occurrence[] = []
  const path = new Set<string>()
  const walk = (
    block: Block | null,
    parentKey: string | null,
    depth: number,
    guideKeys: string[],
    direction: Direction,
  ) => {
    const beneath = rowsBeneath(doc, block, path, direction)
    const numbers = olPositions(
      doc,
      beneath.map((row) => row.id),
    )
    beneath.forEach(({ id, direction }, index) => {
      const row = doc.blocks[id]
      if (!row) return
      // The block is already on the path above: this row closes a loop. It is
      // a leaf here — no toggle, nothing beneath — so the outline ends where
      // the loop closes (zoom into it to go round again).
      const looped = path.has(id)
      const key = keyOf(parentKey, id, direction)
      path.add(id)
      const hasChildren = !looped && rowsBeneath(doc, row, path, direction).length > 0
      path.delete(id)
      const collapsed = hasChildren && folds.has(key)
      rows.push({
        key,
        id,
        direction,
        parentKey,
        depth,
        index,
        olNumber: numbers[index],
        hasChildren,
        collapsed,
        guideKeys,
        ...(looped ? { looped: true } : {}),
      })
      if (hasChildren && !collapsed) {
        path.add(id)
        walk(row, key, depth + 1, [...guideKeys, key], direction)
        path.delete(id)
      }
    })
  }

  const zoomRoot = zoomRootId ? doc.blocks[zoomRootId] : undefined
  if (zoomRoot) {
    // Zoomed, the rows are the zoom root's children (and parents), from
    // depth 0: the root itself is not a row but the view's title (the
    // editor draws it as the note title, above the rows), always open.
    const key = zoomRootKey(doc, zoomRoot.id)
    path.add(zoomRoot.id)
    walk(zoomRoot, key, 0, [], "down")
  } else {
    if (rootId) path.add(rootId)
    walk(null, null, 0, [], "down")
  }
  return rows
}
