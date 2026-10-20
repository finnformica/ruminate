import { levelBeneath, queryAt, type LinkPivots } from "../blocks/query"
import { serialize } from "../blocks/serialize"
import type { Block, BlockDoc } from "../blocks/types"
import {
  keyOf,
  rootQueryOf,
  rowsBeneath,
  type Direction,
  type ExpandedRule,
  type RowRule,
} from "../blocks/view"
import type { ViewNarrowing } from "../utils/view-narrowing"
import { blockView, noteView, type GraphSnapshot, type GraphView } from "./graph"

/**
 * **Filtering and sorting a view, without leaving the view.**
 *
 * A note's page and a focused block's page draw the same walk of the graph
 * (`noteView` / `blockView`). This narrows that walk in place: the rows that
 * match stay, the branches that hold nothing matching go, and the rows kept
 * only to say where a match lives — a match's ancestors — are reported as
 * `context`, which the editor draws dimmed. So a filtered view is the note,
 * shorter: the same markers, the same typography, the same keys, because it
 * is the same doc drawn by the same editor. Nothing here knows about the
 * results list, and nothing sets `fixedRoots`.
 *
 * **What matched, and in what order, is not decided here.** Both arrive as a
 * `ViewNarrowing` (`src/utils/view-narrowing.ts`), which resolves the
 * header's query-language strings through `searchBlocks` — the one engine
 * that knows what a query means over blocks. So this module holds the shape
 * of a narrowed view and nothing about the vocabulary, and a note's filter
 * can never drift from what the same query does in the search box.
 *
 * The sort reorders SIBLINGS in place and leaves the nesting alone: a
 * filtered outline is still an outline, and a global order over a tree is
 * not a thing a reader can follow. Document order is the default and the
 * absence of a sort.
 *
 * The walk this narrows must be EAGER — every row present, not just the
 * unfolded ones — because whether a branch survives depends on what is
 * beneath it, and whether a sort is right depends on the siblings it can
 * see. `useNoteDoc` walks eagerly exactly when a filter or a sort is on.
 *
 * **Pivots** (docs/graph-walk.md, 3.9): the filter and the sort apply to
 * down rows only. An up region — the rows beneath a row whose query is up,
 * and every row reached up — is kept whole, in holder order, as Pensive's
 * prune keeps a pivoted subtree whole. A row whose query is up stands
 * whatever the filter says, as the place its region hangs from. The rows of
 * an up region are context unless they matched.
 */

/** A narrowed view: the doc, the folds, and the rows kept only as context. */
export interface FilteredView extends GraphView {
  /** Rows that did not match and are shown only because a descendant did —
   * drawn dimmed. Empty when nothing is filtered. */
  context: ReadonlySet<string>
  /** How many rows matched the filter. Null when no filter is on (every row
   * is simply itself, and there is nothing to count). */
  matches: number | null
}

/** Is there anything to do — a filter to apply, or a sort to impose? */
export function isNarrowed({ matched, compare }: ViewNarrowing): boolean {
  return matched !== null || compare !== null
}

const NO_CONTEXT: ReadonlySet<string> = new Set()

/**
 * `view`, narrowed by `narrowing`. With nothing to apply the view is handed
 * back untouched (and `matches` is null), so a page can call this
 * unconditionally.
 */
export function filteredView(
  view: GraphView,
  narrowing: ViewNarrowing,
  {
    keepRoots = false,
    expanded,
    startLevel = 1,
    keep,
    pivots = NO_PIVOTS,
    rootId = null,
    directions = "downstream",
  }: RowRule & {
    /**
     * Keep the view's roots whatever the filter says. A focused block is its
     * view's root and is drawn as the view's TITLE, not as one of its rows
     * (`blockView`), so filtering it away would leave the page with nothing
     * to be a view of. A note's roots are ordinary rows and are pruned like
     * any other.
     */
    keepRoots?: boolean
    /**
     * The fold rule the narrowed rows are drawn by — the narrowed view's own
     * (`useFoldRule` with the narrowing, src/data/view-state.ts), which
     * opens everything the reader has not folded themselves. Absent, nothing
     * is folded. The walk handed in was eager, so the rule is applied here,
     * over what survived, exactly as a lazy walk would have applied it.
     */
    expanded?: ExpandedRule
    /** The level of the view's roots, as the walk counts them (1 for a
     * note's rows, 0 for a focused block). */
    startLevel?: number
    /**
     * Rows kept whatever the filter says — the row being edited. A row is
     * judged by the filter when the editing leaves it, not on every
     * keystroke: a line retyped, a bullet made a to-do or a row outdented
     * would otherwise vanish from under the caret the moment it stopped
     * matching, and a row could never be made that did not match from its
     * first character. Kept the way a match is — its ancestors as context,
     * what hangs beneath it with it — and drawn as one, but not counted as
     * one (`matches` is the filter's own count).
     */
    keep?: ReadonlySet<string>
  } = {},
): FilteredView {
  const { matched, compare } = narrowing
  if (matched === null && compare === null) return { ...view, context: NO_CONTEXT, matches: null }

  // The rule the view was walked by (`RowRule`): its pivots, the note as
  // `rootId` (absent in focus, where the block reads its own pivot), and
  // the "Show links" setting, "downstream" when absent as in `walkGraph`.
  const rows: Required<RowRule> = { pivots, rootId, directions }
  const rootQuery = rootQueryOf(pivots, rootId)
  const sorted = compare ? sortSiblings(view.doc, compare, pivots, rootQuery) : view.doc
  const { doc, context } =
    matched === null
      ? { doc: sorted, context: new Set<string>() }
      : prune(sorted, matched, pivots, rootQuery, keepRoots, keep)
  const collapsed = expanded ? foldsOf(doc, expanded, startLevel, rows) : new Set<string>()
  return { doc, collapsed, context, matches: matched === null ? null : matched.size }
}

const NO_PIVOTS: LinkPivots = new Map()

/**
 * The markdown of a filtered view — what **Copy markdown** takes while a
 * filter is on: the rows the view shows, nested as it nests them, a match's
 * ancestors (the dimmed context) included. The note's (or, focused, the
 * block's) rollup, pruned as `filteredView` prunes the page. Folds play no
 * part, as they play none in the unfiltered rollup. Null when the view's
 * root is not in the graph.
 */
export function filteredRollup(
  noteId: string,
  focusBlockId: string | null,
  matched: ReadonlySet<string>,
  graph: GraphSnapshot,
): string | null {
  const focused = focusBlockId ? blockView(focusBlockId, graph) : null
  const base = focused ?? noteView(noteId, graph)
  if (!base) return null
  const { doc } = filteredView(base, { matched, compare: null }, { keepRoots: focused !== null })
  return serialize(doc)
}

/**
 * `doc` with every branch that holds no match removed. A block is kept when
 * it matched, or when anything beneath it did; the kept-but-unmatched are
 * returned as `context` for the editor to dim.
 *
 * A match's own children are kept whether or not they matched — a to-do you
 * filtered to is still the to-do with its notes underneath — but they are
 * context, not matches, so the dimming says which row the filter found.
 *
 * A row in `kept` (the one being edited) stands as a match does, whatever
 * the filter made of it.
 *
 * The filter prunes down rows only. A row whose query is up (its block's
 * pivot, or the query it inherits) stands with its region whole, as a match
 * stands with its body. Beneath any kept row, its up rows are kept whole
 * too, but they do not keep the row: they are not the note's to match.
 */
function prune(
  doc: BlockDoc,
  matched: ReadonlySet<string>,
  pivots: LinkPivots,
  rootQuery: Direction,
  keepRoots: boolean,
  kept?: ReadonlySet<string>,
): { doc: BlockDoc; context: Set<string> } {
  const blocks: Record<string, Block> = {}
  const context = new Set<string>()
  const path = new Set<string>()
  const held = (id: string): boolean => matched.has(id) || (kept?.has(id) ?? false)

  // Whether `id` survives — it matched, or something beneath it did, or its
  // query is up — and, on the way, the pruned block itself. Loops end the
  // descent, as they do in the walk (docs/graph-schema-v2.md).
  const keep = (id: string, inherited: Direction): boolean => {
    if (blocks[id]) return true
    const block = doc.blocks[id]
    if (!block || path.has(id)) return false
    const query = pivots.get(id) ?? inherited
    // Beneath a match, and in an up region, every row is kept.
    if (held(id) || query === "up") return keepAll(id)
    path.add(id)
    const children = block.children.filter((childId) => keep(childId, query))
    const upstream = children.length > 0 ? keepUpstream(block) : undefined
    path.delete(id)
    if (children.length === 0) return false
    context.add(id)
    blocks[id] = { ...block, children, ...(upstream && { upstream }) }
    return true
  }

  // Everything beneath a match or an up row, unconditionally: down and up.
  const keepAll = (id: string): boolean => {
    if (blocks[id]) return true
    const block = doc.blocks[id]
    if (!block || path.has(id)) return false
    path.add(id)
    const children = block.children.filter((childId) => keepAll(childId))
    const upstream = keepUpstream(block)
    path.delete(id)
    if (!held(id)) context.add(id)
    blocks[id] = { ...block, children, ...(upstream && { upstream }) }
    return true
  }

  // A block's holders, each kept whole. A holder on the path above stays
  // listed (the rows decide where a loop closes); it is kept on the way back.
  const keepUpstream = (block: Pick<Block, "upstream">): string[] | undefined =>
    block.upstream?.filter((parentId) =>
      path.has(parentId) ? parentId in doc.blocks : keepAll(parentId),
    )

  // A root the filter emptied still stands when the view is rooted on it:
  // the page's title, with nothing beneath it, which is the honest way to
  // say the filter found nothing in here.
  const keepEmptyRoot = (id: string): boolean => {
    if (keep(id, "down")) return true
    const block = doc.blocks[id]
    if (!block) return false
    blocks[id] = { ...block, children: [] }
    if (!held(id)) context.add(id)
    return true
  }

  const rootBlockIds = doc.rootBlockIds.filter((id) =>
    keepRoots ? keepEmptyRoot(id) : keep(id, rootQuery),
  )
  const upstream = keepUpstream(doc)
  return { doc: { ...doc, rootBlockIds, blocks, ...(upstream && { upstream }) }, context }
}

/**
 * `doc` with each parent's children reordered by `compare`, the nesting
 * untouched. The comparator is the one a search sorts its results by
 * (`compareBlockHits`, through `src/utils/view-narrowing.ts`), so a key
 * orders a note's rows exactly as it orders results.
 *
 * Down rows only: the walk stops at a row whose query is up and at the up
 * rows, so holders stay in the order `parentIdsOf` gives them. A block that
 * is a down row anywhere has its children sorted.
 */
function sortSiblings(
  doc: BlockDoc,
  compare: (a: string, b: string) => number,
  pivots: LinkPivots,
  rootQuery: Direction,
): BlockDoc {
  const order = (ids: string[]): string[] => (ids.length > 1 ? [...ids].sort(compare) : ids)
  const blocks: Record<string, Block> = { ...doc.blocks }
  const sorted = new Set<string>()
  const visit = (id: string, inherited: Direction) => {
    const block = doc.blocks[id]
    const query = pivots.get(id) ?? inherited
    if (!block || query === "up" || sorted.has(id)) return
    sorted.add(id)
    blocks[id] = { ...block, children: order(block.children) }
    for (const childId of block.children) visit(childId, query)
  }
  if (rootQuery === "up") return doc
  for (const id of doc.rootBlockIds) visit(id, rootQuery)
  return { ...doc, rootBlockIds: order(doc.rootBlockIds), blocks }
}

/**
 * The occurrence keys the fold rule closes in a narrowed doc: exactly the
 * set the lazy walk (`walkGraph`, src/data/graph.ts) reports for the same
 * rule, pivots and rows. The rows beneath each row are the ones the editor
 * draws (`rowsBeneath`, with the `from` guard), less those the narrowing
 * took away; the fold rule and the pivots decide each row (`queryAt`), and
 * the depth count starts again beneath a pivot (`levelBeneath`). Leaves and
 * looped rows are never closed.
 */
function foldsOf(
  doc: BlockDoc,
  expanded: ExpandedRule,
  startLevel: number,
  { pivots, rootId, directions }: Required<RowRule>,
): Set<string> {
  const rule = { pivots, expanded }
  const collapsed = new Set<string>()
  const path = new Set<string>()
  const beneath = (
    block: Block | null,
    from: string | null,
    direction: Direction,
    query: Direction,
  ) =>
    rowsBeneath(doc, block, from, direction, query, directions, rootId).filter(
      (row) => row.id in doc.blocks,
    )
  const visit = (
    id: string,
    parentKey: string | null,
    level: number,
    direction: Direction,
    inherited: Direction,
    from: string | null,
  ) => {
    const block = doc.blocks[id]
    if (!block || path.has(id)) return
    const key = keyOf(parentKey, id, direction)
    const query = pivots.get(id) ?? inherited
    const rows = beneath(block, from, direction, query)
    if (rows.length === 0) return
    const row = { key, id, level, type: block.type }
    if (queryAt(rule, row, query).type === "collapse") {
      collapsed.add(key)
      return
    }
    const next = levelBeneath(rule, row)
    path.add(id)
    for (const below of rows) visit(below.id, key, next, below.direction, query, id)
    path.delete(id)
  }
  const rootQuery = rootQueryOf(pivots, rootId)
  for (const top of beneath(null, rootId, "down", rootQuery)) {
    visit(top.id, null, startLevel, top.direction, rootQuery, rootId)
  }
  return collapsed
}
