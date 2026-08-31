import { searchBlocks, type BlockHit, type BlockIndex } from "./block-search"
import { parseQuery } from "./search"

/**
 * **The data source behind block search results.**
 *
 * Everything the results UI needs, and nothing else: resolve a query to hits,
 * and resolve one hit to its direct children (for lazy expansion). Components
 * and hooks talk to this interface only — they never reach into the block
 * index, the atoms behind it, or a store.
 *
 * Both methods are **await-tolerant**: they may return a value or a promise of
 * one. Today's implementation (`inMemoryBlockSearchSource`) is synchronous and
 * the UI renders its results in the same pass — no loading state, no extra
 * render. A future implementation that answers over the network (server-side
 * search across a corpus too large to hold client-side) returns promises
 * instead, and the *hooks* absorb the difference: `useSearchResults` and
 * `useBlockResultTree` already handle both shapes. That is the whole swap —
 * one factory, at the single call site in `src/hooks/search-results.ts`.
 *
 * The contract an async implementation must keep:
 * - `search` returns hits in result order; each hit carries its own text,
 *   type, breadcrumb `ancestors`, containing `note`, and `childCount` (the
 *   has-downstream flag the expand chevron is drawn from).
 * - `children` returns direct children in document order, each itself a hit
 *   with a correct `childCount`, so the next level expands the same way.
 * - `children` is expected to be cheap on repeat: memoize it (see
 *   `createChildResolver`, which caches promises just as well as arrays).
 */
export interface BlockSearchSource {
  /** Blocks matching a query, in result order. */
  search(query: string): BlockHit[] | Promise<BlockHit[]>
  /** One hit's direct children, in document order. Empty for a leaf. */
  children(hit: BlockHit): BlockHit[] | Promise<BlockHit[]>
}

/**
 * The source the app runs on: the client-side block index (`blockIndexAtom`),
 * queried synchronously. The index is incremental — only notes whose content
 * changed are re-parsed — so this costs nothing per keystroke beyond the
 * filter itself.
 */
export function inMemoryBlockSearchSource(index: BlockIndex): BlockSearchSource {
  return {
    search: (query) => searchBlocks(parseQuery(query), index),
    // Already memoized per block by the index (see `createChildResolver`).
    children: (hit) => index.getChildren(hit),
  }
}
