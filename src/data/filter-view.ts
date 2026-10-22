import type { LinkPivots } from "../blocks/query"
import { serialize } from "../blocks/serialize"
import type { ExpandedRule } from "../blocks/view"
import type { ViewNarrowing } from "../utils/view-narrowing"
import {
  ancestorClosure,
  blockView,
  noteView,
  type GraphSnapshot,
  type GraphView,
  type LinkDirections,
  type WalkNarrowing,
} from "./graph"

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
 * **The walk narrows itself** (`walkGraph`, `WalkNarrowing`,
 * docs/graph-walk.md, 4.5). Whether a branch survives is read off the
 * filter's ancestor closure (`ancestorClosure`), not off a walk beneath it,
 * and the sort orders a row's children as the walk builds the row. So a
 * narrowed view is as lazy as the note: a closed row is not walked, and the
 * fold rule is the walk's own. This module is the thin wrapper that builds
 * the closure and counts what the walk kept.
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
 * The filter's ancestor closure for a note's view: the matched ids and every
 * node above them, up to the note (`ancestorClosure`). Built once per filter
 * and snapshot; a focused view of the same note reads the same set.
 */
export function filterReach(
  graph: GraphSnapshot,
  noteId: string,
  matched: ReadonlySet<string>,
): ReadonlySet<string> {
  return ancestorClosure(graph, matched, noteId)
}

/**
 * The note's view — or, in focus, the focused block's — walked by `graph`
 * and narrowed by `narrowing`. With nothing to apply it is the plain walk
 * (and `matches` is null), so a page can call this unconditionally. Null
 * when the view's root is not in the graph.
 *
 * Focused, the root block is the view's title rather than one of its rows,
 * so the filter runs over what is inside it and never takes it away: an
 * emptied root stands with nothing beneath it.
 */
export function filteredView(
  graph: GraphSnapshot,
  noteId: string,
  focusBlockId: string | null,
  narrowing: ViewNarrowing,
  {
    expanded,
    keep,
    pivots,
    directions = "downstream",
    reach,
  }: {
    /** The fold rule the rows are drawn by — the narrowed view's own
     * (`useFoldRule` with the narrowing, src/data/view-state.ts). Absent,
     * nothing is folded. */
    expanded?: ExpandedRule
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
    /** The frame's link pivots; the filter keeps their up regions whole. */
    pivots?: LinkPivots
    /** Which links the walk follows (Settings → Editor, "Show links"). */
    directions?: LinkDirections
    /** `filterReach` of the filter's matches, when the caller holds it;
     * built here when absent. */
    reach?: ReadonlySet<string>
  } = {},
): FilteredView | null {
  const { matched, compare } = narrowing
  const walk: WalkNarrowing | undefined = isNarrowed(narrowing)
    ? {
        matched,
        compare,
        keep,
        reach: matched === null ? NO_CONTEXT : (reach ?? filterReach(graph, noteId, matched)),
      }
    : undefined
  const focused = focusBlockId
    ? blockView(
        focusBlockId,
        graph,
        expanded,
        directions,
        pivots,
        walk && { ...walk, keepRoots: true },
      )
    : null
  const view = focused ?? noteView(noteId, graph, expanded, directions, pivots, walk)
  if (!view) return null
  if (matched === null) return { ...view, context: NO_CONTEXT, matches: null }
  // Every row the walk kept is a match, a kept row, or context.
  const context = new Set(
    Object.keys(view.doc.blocks).filter((id) => !matched.has(id) && !(keep?.has(id) ?? false)),
  )
  return { ...view, context, matches: matched.size }
}

/**
 * The markdown of a filtered view — what **Copy markdown** takes while a
 * filter is on: the rows the view shows, nested as it nests them, a match's
 * ancestors (the dimmed context) included. The note's (or, focused, the
 * block's) rollup, narrowed as `filteredView` narrows the page. Folds play
 * no part, as they play none in the unfiltered rollup. Null when the view's
 * root is not in the graph.
 */
export function filteredRollup(
  noteId: string,
  focusBlockId: string | null,
  matched: ReadonlySet<string>,
  graph: GraphSnapshot,
): string | null {
  const view = filteredView(graph, noteId, focusBlockId, { matched, compare: null })
  return view ? serialize(view.doc) : null
}
