import React from "react"
import { blockKey, type BlockHit } from "../utils/block-search"
import type { BlockSearchSource } from "../utils/block-search-source"

/**
 * One visible row of a block-results list: a hit, plus where it sits in the
 * expansion tree. Rows are FLAT — the list renders `rows` in order and shows
 * nesting with an indent — so the same array drives rendering, the roving
 * keyboard highlight, and the ⌘K palette's items without three notions of
 * "which row is that". A row is an occurrence in the editor's sense
 * (`src/blocks/view.ts`): the results view is a view whose roots are the
 * hits, and its rows are drawn by the editor's own row component.
 */
export interface ResultRow {
  /**
   * Stable identity for this row *in this tree* — its occurrence key. A
   * top-level row is keyed by the block (note-scoped — the same block id can
   * exist in two notes); a revealed child is keyed by its path beneath the
   * hit, so the same block expanded under two different parents keeps
   * independent open/closed state.
   */
  key: string
  hit: BlockHit
  /** 0 for a matched hit; 1+ for children revealed by expanding. */
  depth: number
  parentKey: string | null
  /** Position among its siblings: a hit's rank among the hits, a revealed
   * child's place among its parent's children. */
  index: number
  /** The keys of the rows this one is indented under, outermost first —
   * exactly `depth` of them; each owns a guide line beside this row. */
  guideKeys: string[]
  /** Whether the block has anything downstream (drives the chevron). */
  hasChildren: boolean
  expanded: boolean
}

/**
 * Flatten hits into visible rows, walking into a row's children only where it
 * is expanded AND its children have been resolved. Pure: this never asks the
 * source for anything (expansion does that — see `expand` below), so a render
 * can't start a fetch.
 */
function flattenResultRows(
  hits: BlockHit[],
  expandedKeys: ReadonlySet<string>,
  childrenByKey: ReadonlyMap<string, BlockHit[]>,
): ResultRow[] {
  const rows: ResultRow[] = []

  const push = (
    hit: BlockHit,
    depth: number,
    parentKey: string | null,
    index: number,
    guideKeys: string[],
  ) => {
    const key = parentKey === null ? blockKey(hit) : `${parentKey}/${hit.blockId}`
    const hasChildren = hit.childCount > 0
    const expanded = hasChildren && expandedKeys.has(key)
    rows.push({ key, hit, depth, parentKey, index, guideKeys, hasChildren, expanded })
    if (!expanded) return
    const children = childrenByKey.get(key) ?? []
    children.forEach((child, i) => push(child, depth + 1, key, i, [...guideKeys, key]))
  }

  hits.forEach((hit, i) => push(hit, 0, null, i, []))
  return rows
}

const NO_CHILDREN: ReadonlyMap<string, BlockHit[]> = new Map()

/**
 * Expansion state for a block-results list. Expanding a row asks the source
 * for that row's children — only then, only once (the source memoizes), and
 * only for rows the reader actually opened — and reveals them beneath it;
 * expanding one of *those* resolves the next level the same way.
 *
 * The source is await-tolerant, so this hook is too: a synchronous source
 * lands its children in the same state update as the expansion (nothing
 * flickers), while a promise fills them in when it settles.
 *
 * `limit` caps how many top-level hits are rendered — revealed children are
 * never capped, since they only exist because the reader asked for them.
 */
export function useBlockResultTree({
  hits,
  source,
  limit,
  resetKey,
}: {
  hits: BlockHit[]
  source: BlockSearchSource
  /** Render at most this many top-level hits (the rest paginate in). */
  limit?: number
  /** The query. Changing it collapses everything — the tree described a
   * different set of results. */
  resetKey?: string
}) {
  const [expandedKeys, setExpandedKeys] = React.useState<ReadonlySet<string>>(() => new Set())
  const [childrenByKey, setChildrenByKey] =
    React.useState<ReadonlyMap<string, BlockHit[]>>(NO_CHILDREN)

  const prevResetKey = React.useRef(resetKey)
  if (prevResetKey.current !== resetKey) {
    prevResetKey.current = resetKey
    // Render-phase reset (no effect round-trip): the rows below are derived in
    // this same render, so the first paint of a new query is never stale.
    if (expandedKeys.size > 0) setExpandedKeys(new Set())
    if (childrenByKey.size > 0) setChildrenByKey(NO_CHILDREN)
  }

  // Late arrivals from a superseded query must not resurrect rows.
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const putChildren = React.useCallback((key: string, children: BlockHit[]) => {
    setChildrenByKey((current) => {
      if (current.get(key) === children) return current
      const next = new Map(current)
      next.set(key, children)
      return next
    })
  }, [])

  const expand = React.useCallback(
    (row: ResultRow) => {
      if (!row.hasChildren) return
      setExpandedKeys((keys) => (keys.has(row.key) ? keys : new Set(keys).add(row.key)))
      const resolved = source.children(row.hit)
      if (Array.isArray(resolved)) {
        // Synchronous source: batched with the expansion above, so the
        // children are on screen in the very next paint.
        putChildren(row.key, resolved)
        return
      }
      void Promise.resolve(resolved).then((children) => {
        if (mounted.current) putChildren(row.key, children)
      })
    },
    [source, putChildren],
  )

  const collapse = React.useCallback((row: ResultRow) => {
    setExpandedKeys((keys) => {
      if (!keys.has(row.key)) return keys
      const next = new Set(keys)
      next.delete(row.key)
      return next
    })
  }, [])

  const toggle = React.useCallback(
    (row: ResultRow) => (row.expanded ? collapse(row) : expand(row)),
    [collapse, expand],
  )

  const visibleHits = React.useMemo(
    () => (limit === undefined ? hits : hits.slice(0, limit)),
    [hits, limit],
  )

  const rows = React.useMemo(
    () => flattenResultRows(visibleHits, expandedKeys, childrenByKey),
    [visibleHits, expandedKeys, childrenByKey],
  )

  return { rows, expand, collapse, toggle }
}
