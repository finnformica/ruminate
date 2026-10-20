import type { LinkDirections } from "../data/graph"
import { rootDirection, type LinkPivots } from "./query"
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
   * walked, so the outline ends where the loop closes. Focusing on it starts
   * a fresh path, which is how a reader descends deliberately.
   */
  looped?: boolean
  /** The row's block has a link pivot (src/blocks/query.ts): the rows
   * beneath walk this way. The editor draws the marker from it. Absent on a
   * looped row, which has nothing beneath it. */
  pivot?: Direction
}

/**
 * What the rows read to follow the walk (`walkGraph`, src/data/graph.ts),
 * so a view's rows are the rows the walk drew. Each row has a query: its
 * block's link pivot, or the query of the row above (the root query at the
 * top: the pivot on `rootId`, down when there is none). An up row lists its
 * holders only; a down row lists what `directions` names.
 */
export interface RowRule {
  /** The frame's link pivots. None by default. */
  pivots?: LinkPivots
  /** Which links a row whose query is down follows: the "Show links"
   * setting, as the walk took it (`WalkOptions.directions`). Absent: what the
   * doc carries, a block's children and its `upstream` list when it has one,
   * which is right only with no pivots. Retires with the setting (GW-18). */
  directions?: LinkDirections
  /** The id of the view's own root when it is not a block in the doc (the
   * note): on the path from the start, and the root query's block. */
  rootId?: string | null
}

const NO_PIVOTS: LinkPivots = new Map()

/** A row's query: its block's pivot, or the query of the row above. */
const queryOf = (pivots: LinkPivots, id: string, inherited: Direction): Direction =>
  pivots.get(id) ?? inherited

/** The root query of a view rooted at `rootId` (the note): the pivot on it,
 * down when there is none or no root is named. */
export const rootQueryOf = (pivots: LinkPivots, rootId: string | null | undefined): Direction =>
  rootId ? rootDirection(pivots, rootId) : "down"

/** The query of the row at the end of a path of ids (`pathIdsOf`): the
 * pivots along it, from `inherited` (the root query) down. The rows beneath
 * that row walk this way. */
export function queryOfPath(
  ids: readonly string[],
  pivots: LinkPivots,
  inherited: Direction = "down",
): Direction {
  return ids.reduce<Direction>((query, id) => queryOf(pivots, id, query), inherited)
}

/**
 * The fold rule a walk descends by: is the occurrence `key`, `level` steps
 * below the walk's root, open? A note's roots are level 1; a focused block is
 * level 0 and its children level 1. The rule is the reader's explicit folds
 * over the depth setting (`src/data/view-state.ts`), and the graph walk
 * (`walkGraph`, src/data/graph.ts) only descends where it says so. The
 * row's stored type comes too, for the one kind the rule reads by type: a
 * board's row, which is a card standing for what is beneath it
 * (docs/boards.md, "A board in a note"), and so starts closed.
 */
export type ExpandedRule = (key: string, level: number, type?: string) => boolean

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
 * children, then its parents. One guard in both directions
 * (docs/graph-walk.md, 3.3): `from`, the block the row came from (the row
 * above; the view's root at the top), is not listed the other way — a child
 * row's own parent is not listed under it, nor a parent row's own child.
 * Any other block on the path is listed, and the walk shows it as a looped
 * leaf (`walkDoc`, `buildRows`). The view's own root (`rootId`, the note) is
 * not a block in the doc, so it is never listed against the row's direction
 * either.
 *
 * `query` is the row's own query (`RowRule`): up, the rows beneath are its
 * parents only; down, what `directions` names (absent: the children, and
 * the parents the block carries). At the top (`block` null), a down query
 * lists the doc's roots in every setting.
 */
export function rowsBeneath(
  doc: BlockDoc,
  block: Block | null,
  from: string | null,
  direction: Direction = "down",
  query: Direction = "down",
  directions?: LinkDirections,
  rootId: string | null = null,
): { id: string; direction: Direction }[] {
  // The doc's own roots are rows whenever the root query is down, whatever
  // the setting: the walk starts from them.
  const followsDown = query === "down" && (block === null || directions !== "upstream")
  const followsUp = query === "up" || directions !== "downstream"
  const children = !followsDown ? [] : block ? block.children : doc.rootBlockIds
  const upstream = !followsUp ? [] : block ? (block.upstream ?? []) : (doc.upstream ?? [])
  const skip = (id: string) => id === from || id === rootId
  const down = direction === "up" ? children.filter((id) => !skip(id)) : children
  const ups = upstream.filter((id) => (direction === "down" ? !skip(id) : id !== rootId))
  return [
    ...down.map((id) => ({ id, direction: "down" as const })),
    ...ups.map((id) => ({ id, direction: "up" as const })),
  ]
}

/**
 * Depth-first over a doc's occurrences from `ids`: every path from a root
 * to a block, a block reached by two paths visited twice. The one rule every
 * walk over a doc shares: a block already on the current path is visited
 * once more as a leaf (`looped`) and never descended, so a doc holding a
 * loop (docs/graph-schema-v2.md, "Loops") ends where the loop closes rather
 * than hanging. Return `false` from `visit` to skip a block's children.
 * Beneath each block it visits the rows `rowsBeneath` lists for the row's
 * query (`rule`), children before parents. From the doc's own roots, the
 * root's parents (`doc.upstream`) come after them.
 */
export function walkDoc(
  doc: BlockDoc,
  ids: string[],
  visit: (step: DocWalkStep) => boolean | void,
  { pivots = NO_PIVOTS, directions, rootId = null }: RowRule = {},
): void {
  const path = new Set<string>()
  if (rootId) path.add(rootId)
  /** `above`: the block the rows came from (the view's root at the top). */
  const walk = (
    rows: { id: string; direction: Direction }[],
    above: string | null,
    parentKey: string | null,
    depth: number,
    inherited: Direction,
  ) => {
    // Each direction counts its own positions, children and parents apart.
    for (const side of ["down", "up"] as const) {
      rows
        .filter((row) => row.direction === side)
        .forEach(({ id, direction }, index) => {
          const block = doc.blocks[id]
          if (!block) return
          const looped = path.has(id)
          const key = keyOf(parentKey, id, direction)
          const descend = visit({ block, key, direction, parentKey, depth, index, looped })
          if (looped || descend === false) return
          const query = queryOf(pivots, id, inherited)
          path.add(id)
          const beneath = rowsBeneath(doc, block, above, direction, query, directions, rootId)
          walk(beneath, id, key, depth + 1, query)
          path.delete(id)
        })
    }
  }
  const rootQuery = rootQueryOf(pivots, rootId)
  // At the top level, the root's own parents after the roots.
  const top =
    ids === doc.rootBlockIds
      ? rowsBeneath(doc, null, rootId, "down", rootQuery, directions, rootId)
      : ids.map((id) => ({ id, direction: "down" as const }))
  walk(top, rootId, null, 0, rootQuery)
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

/** The roots among a set of rows: those with no ancestor in the set, in
 * the set's order — the rows to act on once each, so a subtree a selection
 * covers is moved, copied or removed as one and never once per row. */
export function rootKeys(keys: readonly string[]): string[] {
  const set = new Set(keys)
  return keys.filter((key) => !ancestorKeys(key).some((ancestor) => set.has(ancestor)))
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
export function occurrenceKeys(doc: BlockDoc, rule?: RowRule): string[] {
  const keys: string[] = []
  walkDoc(
    doc,
    doc.rootBlockIds,
    ({ key }) => {
      keys.push(key)
    },
    rule,
  )
  return keys
}

/** The first occurrence (document order) of a block, or null. */
export function firstOccurrenceKey(doc: BlockDoc, id: string, rule?: RowRule): string | null {
  const suffix = `/${id}`
  for (const key of occurrenceKeys(doc, rule)) {
    if (key === id || key.endsWith(suffix)) return key
  }
  return null
}

/** The key the focused block is addressed by: its first occurrence in the
 * document (so a fold made while focused is the same fold outside focus), or its
 * bare id when the document does not reach it. */
export function focusRootKeyOf(doc: BlockDoc, focusRootId: string): string {
  return firstOccurrenceKey(doc, focusRootId) ?? focusRootId
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
 * The rows of a view: depth-first from the roots (or from the focused block),
 * with folds applied — a collapsed occurrence's children are not rows.
 *
 * In focus, the view takes the focused block one of two ways (`titlesFocus`,
 * src/blocks/markers.ts, is the rule; `focusTitled` carries its answer here):
 *
 * - **Titled** — a heading, which already names what hangs beneath it: the
 *   root is not a row but the view's title, drawn above the rows, and its
 *   children start again at depth 0, so the focused subtree reads as a note
 *   of its own.
 * - **Untitled** — everything else, which is content rather than a name:
 *   the block leads as the view's first row, at depth 0, with what it holds
 *   indented beneath it — the outline exactly as it reads outside focus,
 *   starting here.
 *
 * Either way the root's key is its first occurrence in the document, so a
 * fold made while focused is the same fold outside focus.
 *
 * Given the walk's pivots and `directions` (`RowRule`), the rows are the
 * rows the walk drew: each row lists what its query walks, and its
 * `hasChildren` reads the same lists. In focus, the focused block's query is
 * its own pivot, down when there is none.
 */
export function buildRows(
  doc: BlockDoc,
  {
    focusRootId = null,
    focusTitled = true,
    folds,
    rootId = null,
    pivots = NO_PIVOTS,
    directions,
  }: RowRule & {
    focusRootId?: string | null
    /** Focused: is the root the view's title (a heading) rather than its
     * first row? See the note above. */
    focusTitled?: boolean
    folds: ReadonlySet<string>
  },
): Occurrence[] {
  const rows: Occurrence[] = []
  const path = new Set<string>()
  // `from`: the block the row came from (`rowsBeneath`).
  const beneath = (
    block: Block | null,
    from: string | null,
    direction: Direction,
    query: Direction,
  ) => rowsBeneath(doc, block, from, direction, query, directions, rootId)
  const walk = (
    block: Block | null,
    from: string | null,
    parentKey: string | null,
    depth: number,
    guideKeys: string[],
    direction: Direction,
    query: Direction,
  ) => {
    const list = beneath(block, from, direction, query)
    // The block each row beneath came from: this one, or the view's root.
    const above = block ? block.id : rootId
    const numbers = olPositions(
      doc,
      list.map((row) => row.id),
    )
    list.forEach(({ id, direction }, index) => {
      const row = doc.blocks[id]
      if (!row) return
      // The block is already on the path above: this row closes a loop. It is
      // a leaf here — no toggle, nothing beneath — so the outline ends where
      // the loop closes (focus on it to go round again).
      const looped = path.has(id)
      const key = keyOf(parentKey, id, direction)
      const rowQuery = queryOf(pivots, id, query)
      const hasChildren = !looped && beneath(row, above, direction, rowQuery).length > 0
      const collapsed = hasChildren && folds.has(key)
      const pivot = looped ? undefined : pivots.get(id)
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
        ...(pivot ? { pivot } : {}),
      })
      if (hasChildren && !collapsed) {
        path.add(id)
        walk(row, above, key, depth + 1, [...guideKeys, key], direction, rowQuery)
        path.delete(id)
      }
    })
  }

  const focusRoot = focusRootId ? doc.blocks[focusRootId] : undefined
  const focusQuery = focusRoot ? queryOf(pivots, focusRoot.id, "down") : "down"
  if (focusRoot && focusTitled) {
    // Titled: the rows are the focus root's children (and parents), from
    // depth 0 — the root itself is not a row but the view's title (the
    // editor draws it as the note title, above the rows), always open.
    const key = focusRootKeyOf(doc, focusRoot.id)
    path.add(focusRoot.id)
    walk(focusRoot, null, key, 0, [], "down", focusQuery)
  } else if (focusRoot) {
    // Untitled: the focused block is the view's first row, its own subtree
    // indented beneath it — a row like any other, fold and all.
    const key = focusRootKeyOf(doc, focusRoot.id)
    const hasChildren = beneath(focusRoot, null, "down", focusQuery).length > 0
    const collapsed = hasChildren && folds.has(key)
    const pivot = pivots.get(focusRoot.id)
    rows.push({
      key,
      id: focusRoot.id,
      direction: "down",
      // The view's own root: nothing above it on screen, whatever path its
      // key spells out in the document it was reached through.
      parentKey: null,
      depth: 0,
      index: 0,
      // A numbered item leading a view is the first of its run.
      olNumber: focusRoot.type === "ol" ? 1 : 0,
      hasChildren,
      collapsed,
      guideKeys: [],
      ...(pivot ? { pivot } : {}),
    })
    if (hasChildren && !collapsed) {
      path.add(focusRoot.id)
      walk(focusRoot, null, key, 1, [key], "down", focusQuery)
      path.delete(focusRoot.id)
    }
  } else {
    if (rootId) path.add(rootId)
    walk(null, rootId, null, 0, [], "down", rootQueryOf(pivots, rootId))
  }
  return rows
}
