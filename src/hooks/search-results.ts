import { useAtomValue } from "jotai"
import React from "react"
import { blockIndexAtom } from "../global-state"
import type { Note } from "../schema"
import { hasBlockTypeFilter, notesFromBlockHits, type BlockHit } from "../utils/block-search"
import { inMemoryBlockSearchSource, type BlockSearchSource } from "../utils/block-search-source"
import { parseQuery } from "../utils/search"
import { useSearchNotes } from "./search-notes"

/**
 * What a query resolves to. Search results ARE the matching blocks: a query
 * with text or a block-scoped `type:` resolves at block granularity, so a
 * heading nested six levels down is a first-class result row rather than a
 * filename.
 *
 * A query that only names NOTES — `tag:recipe`, `date:2026-01-01`, a bare
 * frontmatter qualifier, or nothing at all — stays a note listing: every block
 * in every tagged note is not a search result, it's the corpus. That rule is
 * what keeps the tags page (which drives its list with a `tag:` base query)
 * browsing notes, while typing text into it narrows to blocks.
 */
function resolvesToBlocks(query: string): boolean {
  const parsed = parseQuery(query)
  return parsed.fuzzy.trim() !== "" || hasBlockTypeFilter(parsed.filters)
}

/**
 * THE swap point. Everything block-search in the UI reaches its data through
 * this one hook; replacing the body with an async (server-backed) source is
 * the entire migration — see `BlockSearchSource`.
 */
export function useBlockSearchSource(): BlockSearchSource {
  const index = useAtomValue(blockIndexAtom)
  return React.useMemo(() => inMemoryBlockSearchSource(index), [index])
}

/**
 * Resolve a value the source may have returned either directly or as a
 * promise. A plain value is returned in the same render (no state, no extra
 * pass); a promise falls back to `empty` until it settles, keyed on the
 * promise itself so a superseded query can never paint stale results.
 */
function useAwaited<T>(result: T | Promise<T>, empty: T): T {
  const isPending = typeof (result as Promise<T> | undefined)?.then === "function"
  const [settled, setSettled] = React.useState<{ from: unknown; value: T } | null>(null)

  React.useEffect(() => {
    if (!isPending) return
    let cancelled = false
    void Promise.resolve(result as Promise<T>).then((value) => {
      if (!cancelled) setSettled({ from: result, value })
    })
    return () => {
      cancelled = true
    }
  }, [result, isPending])

  if (!isPending) return result as T
  return settled?.from === result ? settled.value : empty
}

export interface SearchResults {
  mode: "blocks" | "notes"
  /** The matching blocks, in result order. Empty in "notes" mode. */
  hits: BlockHit[]
  /** The notes to list ("notes"), or the notes the hits live in ("blocks") —
   * either way what tag frequencies and the dice roll are computed from. */
  notes: Note[]
}

const NO_HITS: BlockHit[] = []

/** Resolve a query to result rows — blocks when it discriminates blocks, notes
 * otherwise (see `resolvesToBlocks`). */
export function useSearchResults(query: string): SearchResults {
  const searchNotes = useSearchNotes()
  const source = useBlockSearchSource()
  const showBlocks = resolvesToBlocks(query)

  // Memoized so an async source is asked once per query, not once per render.
  const result = React.useMemo(
    () => (showBlocks ? source.search(query) : NO_HITS),
    [showBlocks, source, query],
  )
  const hits = useAwaited(result, NO_HITS)

  return React.useMemo(() => {
    if (!showBlocks) return { mode: "notes", hits: NO_HITS, notes: searchNotes(query) }
    return { mode: "blocks", hits, notes: notesFromBlockHits(hits) }
  }, [showBlocks, hits, query, searchNotes])
}
