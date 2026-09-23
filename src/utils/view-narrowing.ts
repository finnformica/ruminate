import type { NoteId } from "../schema"
import { compareBlockHits, searchBlocks, type BlockHit, type BlockIndex } from "./block-search"
import { parseQuery } from "./search"
import { parseSort } from "./view-filter"

/**
 * **What a note's Filter and Sort resolve to — through the search engine,
 * not beside it.**
 *
 * A note's header narrows the note in place (`src/data/filter-view.ts`), and
 * what it narrows BY is a query-language string. There is exactly one thing
 * in the app that knows what such a string means over blocks — `searchBlocks`,
 * the engine behind `type:todo` in the ⌘K palette and on the Views page — so
 * that is what answers here too. The filter is run as a corpus query scoped
 * to the note, and the hits it returns are the rows that matched.
 *
 * The gain is not brevity, it is that the two can never disagree. Every
 * qualifier the query language has works in a note's filter on the day it
 * works in the search box: `type:` on the block, `in:` on its ancestry, a
 * property or `has:`/`no:`/`date:` on the containing note, `-` to exclude,
 * comma lists to OR, and free text fuzzy-matched over the block's own text.
 * The sort is the same comparator a search sorts by (`compareBlockHits`), so
 * `sort:text:desc` orders a note's rows exactly as it orders results.
 *
 * Note-level qualifiers are kept rather than dropped, and they behave
 * honestly: inside one note they hold for every row or for none, so
 * `area:work` shows the whole note or nothing at all. That is what the same
 * query means in a search, which is the point.
 */

/** What a filter and a sort come to, for a view to apply. */
export interface ViewNarrowing {
  /** The ids the filter matched; null when nothing is filtered. */
  matched: ReadonlySet<string> | null
  /** How two sibling rows order, by id; null for the note's own order. */
  compare: ((a: string, b: string) => number) | null
}

const NO_NARROWING: ViewNarrowing = { matched: null, compare: null }

/**
 * `filter` and `sort` resolved against the corpus block index, scoped to
 * `noteId`. A row of another note never matches: a note's header narrows
 * that note.
 */
export function viewNarrowing({
  filter = "",
  sort = "",
  noteId,
  index,
}: {
  filter?: string
  sort?: string
  noteId: NoteId | undefined
  index: BlockIndex
}): ViewNarrowing {
  if (noteId === undefined) return NO_NARROWING
  const hasFilter = filter.trim() !== ""
  const sorts = parseSort(sort)
  if (!hasFilter && sorts.length === 0) return NO_NARROWING

  // The block's hit in this note — what both halves below are read off.
  const hitsById = new Map<string, BlockHit>()
  for (const hit of index.hits) {
    if (hit.noteId === noteId && !hitsById.has(hit.blockId)) hitsById.set(hit.blockId, hit)
  }

  let matched: ReadonlySet<string> | null = null
  if (hasFilter) {
    // The filter IS a query — run by the engine that runs every other one.
    // Its own `sort:` is ignored here: a view's order is the Sort menu's,
    // and ordering hits would not order the tree anyway.
    const query = parseQuery(filter)
    const hits = searchBlocks({ ...query, sorts: [] }, index)
    const ids = new Set<string>()
    for (const hit of hits) if (hit.noteId === noteId) ids.add(hit.blockId)
    matched = ids
  }

  let compare: ((a: string, b: string) => number) | null = null
  if (sorts.length > 0) {
    compare = (a, b) => {
      const left = hitsById.get(a)
      const right = hitsById.get(b)
      // A row the index has not got (one written a moment ago) keeps its
      // place rather than jumping to an end.
      if (!left || !right) return 0
      return compareBlockHits(left, right, sorts)
    }
  }

  return { matched, compare }
}
