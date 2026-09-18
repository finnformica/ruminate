import { Searcher } from "fast-fuzzy"
import type { Block, BlockDoc } from "../blocks/types"
import { blockTypeMatches, isBlockTypeValue } from "../utils/block-search"
import { parseQuery, type Filter, type Sort } from "../utils/search"
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
 * The filter is written in the query language (docs/query-language.md), so
 * the header's menus and the search box share one vocabulary — but only the
 * part of it that means something inside a single note:
 *
 * - `type:` with block-type values (`type:todo`, `-type:done`, `type:todo,done`)
 *   tests the block's own type.
 * - Free text fuzzy-matches the block's own text, at the same threshold the
 *   corpus-wide block search uses, so `type:todo milk` narrows the same way
 *   in both places.
 * - Note-level qualifiers (`date:`, a property, `has:` / `no:`) are ignored:
 *   every block in the view is in the same note, so they would either match
 *   everything or nothing. `in:` is not a filter here either — it names the
 *   view's ROOT, which the page handles by focusing (`?block=`).
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
export function isNarrowed({ filter, sort }: { filter?: string; sort?: string }): boolean {
  return (filter ?? "").trim() !== "" || (sort ?? "").trim() !== ""
}

const NO_CONTEXT: ReadonlySet<string> = new Set()

/**
 * `view`, narrowed by `filter` and ordered by `sort`. Either may be empty:
 * with both empty the view is handed back untouched (and `matches` is null),
 * so a page can call this unconditionally.
 */
export function filteredView(
  view: GraphView,
  {
    filter = "",
    sort = "",
    keepRoots = false,
  }: {
    filter?: string
    sort?: string
    /**
     * Keep the view's roots whatever the filter says. A focused block is its
     * view's root and is drawn as the view's TITLE, not as one of its rows
     * (`blockView`), so filtering it away would leave the page with nothing
     * to be a view of. A note's roots are ordinary rows and are pruned like
     * any other.
     */
    keepRoots?: boolean
  },
): FilteredView {
  const hasFilter = filter.trim() !== ""
  const hasSort = sort.trim() !== ""
  if (!hasFilter && !hasSort) return { ...view, context: NO_CONTEXT, matches: null }

  const sorted = hasSort ? sortSiblings(view.doc, sort) : view.doc
  if (!hasFilter) return { ...view, doc: sorted, context: NO_CONTEXT, matches: null }

  const matched = matchingBlocks(sorted, filter)
  const { doc, context } = prune(sorted, matched, keepRoots)
  // A filtered view shows what survived, open: the reader asked for the
  // matches, so making them unfold to find them would be a riddle. The
  // page's fold rule is left alone — it comes back the moment the filter does.
  return { doc, collapsed: new Set(), context, matches: matched.size }
}

/**
 * The ids in `doc` whose own text and type satisfy `filter`. A block is
 * tested on its own; nothing about its parents or its note is consulted.
 */
function matchingBlocks(doc: BlockDoc, filter: string): Set<string> {
  const { filters, fuzzy } = parseQuery(filter)
  // Only the qualifiers that mean something about a block itself; the rest
  // are a note's business (see the module comment).
  const typeFilters = filters.filter(
    (f) => f.key === "type" && f.values.some((value) => isBlockTypeValue(value)),
  )

  const candidates: Block[] = []
  for (const block of Object.values(doc.blocks)) {
    if (typeFilters.every((f) => testTypeFilter(f, block))) candidates.push(block)
  }
  if (fuzzy === "") return new Set(candidates.map((block) => block.id))

  // The same matcher and threshold the corpus-wide block search uses, so
  // `type:todo milk` narrows a note the way it narrows the corpus.
  const searcher = new Searcher(candidates, {
    keySelector: (block: Block) => block.text,
    threshold: 0.8,
  })
  return new Set(searcher.search(fuzzy).map((block) => block.id))
}

/** One `type:` qualifier against a block's own type; `-type:` inverts. */
function testTypeFilter(filter: Filter, block: Block): boolean {
  const hit = filter.values.some((value) => blockTypeMatches(value, block.type))
  return filter.exclude ? !hit : hit
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
 * `doc` with each parent's children reordered by `sort`, the nesting
 * untouched. Several keys apply left to right, as they do in a search
 * (`sort:type,text:desc`).
 */
function sortSiblings(doc: BlockDoc, sort: string): BlockDoc {
  const parsed = parseSort(sort)
  if (parsed.length === 0) return doc

  const order = (ids: string[]): string[] =>
    [...ids].sort((a, b) => {
      const left = doc.blocks[a]
      const right = doc.blocks[b]
      if (!left || !right) return 0
      for (const key of parsed) {
        const result = compareBlocks(left, right, key)
        if (result !== 0) return result
      }
      return 0
    })

  const blocks: Record<string, Block> = {}
  for (const [id, block] of Object.entries(doc.blocks)) {
    blocks[id] = { ...block, children: order(block.children) }
  }
  return { ...doc, rootBlockIds: order(doc.rootBlockIds), blocks }
}

/**
 * The sort as the header's menu writes it: `text`, `text:desc`, or several
 * comma-separated (`type,text:desc`). The query language's own `sort:` form
 * is accepted too, so a sort copied out of the search box works here.
 */
export function parseSort(sort: string): Sort[] {
  const body = sort.trim().replace(/^sort:/, "")
  if (body === "") return []
  const parsed: Sort[] = []
  for (const part of body.split(",")) {
    const [key, direction] = part.trim().split(":")
    if (!key) continue
    parsed.push({ key, direction: direction === "desc" ? "desc" : "asc" })
  }
  return parsed
}

/** Two blocks on one sort key. Unknown keys read the block's props, the way
 * an unrecognized qualifier is a property key everywhere else. */
function compareBlocks(left: Block, right: Block, sort: Sort): number {
  const a = sortValue(left, sort.key)
  const b = sortValue(right, sort.key)
  // A row with nothing to sort on goes last whichever way the sort runs, so
  // the direction is applied to the comparison, never to the absence.
  if (a === "" || b === "") return a === b ? 0 : a === "" ? 1 : -1
  return (sort.direction === "desc" ? -1 : 1) * compareValues(a, b)
}

function sortValue(block: Block, key: string): string {
  switch (key) {
    case "text":
      return block.text
    case "type":
      return block.type
    default: {
      const value = block.props?.[key]
      return value === undefined || value === null ? "" : String(value)
    }
  }
}

function compareValues(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
}
