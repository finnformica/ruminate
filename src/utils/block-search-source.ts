import { searchBlocks, type BlockHit, type BlockIndex } from "./block-search"
import { parseQuery } from "./search"

/**
 * **The data source behind block search results.**
 *
 * One method: resolve a query to hits. Components and hooks talk to this
 * interface only — they never reach into the block index, the atoms behind
 * it, or a store. (The rows a result expands into are not fetched through
 * it: a results view is the block editor over the graph, walked lazily —
 * see `src/hooks/results-doc.ts`.)
 *
 * `search` is **await-tolerant**: it may return a value or a promise of one.
 * Today's implementation (`inMemoryBlockSearchSource`) is synchronous and the
 * UI renders its results in the same pass — no loading state, no extra
 * render. A future implementation that answers over the network (server-side
 * search across a corpus too large to hold client-side) returns a promise
 * instead, and `useSearchResults` absorbs the difference. That is the whole
 * swap — one factory, at the single call site in `src/hooks/search-results.ts`.
 *
 * The contract an async implementation must keep: `search` returns hits in
 * result order, each naming its block and note.
 */
export interface BlockSearchSource {
  /** Blocks matching a query, in result order. */
  search(query: string): BlockHit[] | Promise<BlockHit[]>
}

/**
 * The source the app runs on: the client-side block index (`blockIndexAtom`),
 * queried synchronously. The index is incremental — only notes whose content
 * changed are re-parsed — so this costs nothing per keystroke beyond the
 * filter itself.
 */
export function inMemoryBlockSearchSource(index: BlockIndex): BlockSearchSource {
  return { search: (query) => searchBlocks(parseQuery(query), index) }
}
