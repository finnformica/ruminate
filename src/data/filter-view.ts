import type { Block, BlockDoc } from "../blocks/types"
import type { ViewNarrowing } from "../utils/view-narrowing"
import type { GraphView } from "./graph"

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
  }: {
    /**
     * Keep the view's roots whatever the filter says. A focused block is its
     * view's root and is drawn as the view's TITLE, not as one of its rows
     * (`blockView`), so filtering it away would leave the page with nothing
     * to be a view of. A note's roots are ordinary rows and are pruned like
     * any other.
     */
    keepRoots?: boolean
  } = {},
): FilteredView {
  const { matched, compare } = narrowing
  if (matched === null && compare === null) return { ...view, context: NO_CONTEXT, matches: null }

  const sorted = compare ? sortSiblings(view.doc, compare) : view.doc
  if (matched === null) return { ...view, doc: sorted, context: NO_CONTEXT, matches: null }

  const { doc, context } = prune(sorted, matched, keepRoots)
  // A filtered view shows what survived, open: the reader asked for the
  // matches, so making them unfold to find them would be a riddle. The
  // page's fold rule is left alone — it comes back the moment the filter does.
  return { doc, collapsed: new Set(), context, matches: matched.size }
}

/**
 * `doc` with every branch that holds no match removed. A block is kept when
 * it matched, or when anything beneath it did; the kept-but-unmatched are
 * returned as `context` for the editor to dim.
 *
 * A match's own children are kept whether or not they matched — a to-do you
 * filtered to is still the to-do with its notes underneath — but they are
 * context, not matches, so the dimming says which row the filter found.
 */
function prune(
  doc: BlockDoc,
  matched: ReadonlySet<string>,
  keepRoots: boolean,
): { doc: BlockDoc; context: Set<string> } {
  const blocks: Record<string, Block> = {}
  const context = new Set<string>()
  const path = new Set<string>()

  // Whether `id` survives — it matched, or something beneath it did — and,
  // on the way, the pruned block itself. Loops end the descent, as they do
  // in the walk (docs/graph-schema-v2.md).
  const keep = (id: string): boolean => {
    if (blocks[id]) return true
    const block = doc.blocks[id]
    if (!block || path.has(id)) return false
    const isMatch = matched.has(id)
    path.add(id)
    // Beneath a match every row is kept; elsewhere only the branches that
    // lead to one.
    const children = isMatch
      ? block.children.filter((childId) => keepAll(childId))
      : block.children.filter((childId) => keep(childId))
    path.delete(id)
    if (!isMatch && children.length === 0) return false
    if (!isMatch) context.add(id)
    blocks[id] = { ...block, children }
    return true
  }

  // Everything beneath a match, unconditionally — it is the match's content.
  const keepAll = (id: string): boolean => {
    if (blocks[id]) return true
    const block = doc.blocks[id]
    if (!block || path.has(id)) return false
    path.add(id)
    const children = block.children.filter((childId) => keepAll(childId))
    path.delete(id)
    if (!matched.has(id)) context.add(id)
    blocks[id] = { ...block, children }
    return true
  }

  // A root the filter emptied still stands when the view is rooted on it:
  // the page's title, with nothing beneath it, which is the honest way to
  // say the filter found nothing in here.
  const keepEmptyRoot = (id: string): boolean => {
    if (keep(id)) return true
    const block = doc.blocks[id]
    if (!block) return false
    blocks[id] = { ...block, children: [] }
    if (!matched.has(id)) context.add(id)
    return true
  }

  const rootBlockIds = doc.rootBlockIds.filter((id) => (keepRoots ? keepEmptyRoot(id) : keep(id)))
  return { doc: { ...doc, rootBlockIds, blocks }, context }
}

/**
 * `doc` with each parent's children reordered by `compare`, the nesting
 * untouched. The comparator is the one a search sorts its results by
 * (`compareBlockHits`, through `src/utils/view-narrowing.ts`), so a key
 * orders a note's rows exactly as it orders results.
 */
function sortSiblings(doc: BlockDoc, compare: (a: string, b: string) => number): BlockDoc {
  const order = (ids: string[]): string[] => (ids.length > 1 ? [...ids].sort(compare) : ids)
  const blocks: Record<string, Block> = {}
  for (const [id, block] of Object.entries(doc.blocks)) {
    blocks[id] = { ...block, children: order(block.children) }
  }
  return { ...doc, rootBlockIds: order(doc.rootBlockIds), blocks }
}
