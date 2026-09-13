import { useAtomValue } from "jotai"
import React from "react"
import { blockIndexAtom, noteTitleSearcherAtom } from "../global-state"
import type { Note } from "../schema"
import { hasBlockTypeFilter, notesFromBlockHits, type BlockHit } from "../utils/block-search"
import { inMemoryBlockSearchSource, type BlockSearchSource } from "../utils/block-search-source"
import { rankResultRows, type ResultRow, type ScoredNote } from "../utils/rank-results"
import { parseQuery } from "../utils/search"
import { filterNotes, sortNotes } from "../utils/search-notes"
import { useSearchNotes } from "./search-notes"

/**
 * What a query resolves to. Search results ARE the matching blocks: a query
 * with text or a block-scoped `type:` resolves at block granularity, so a
 * heading nested six levels down is a first-class result row rather than a
 * filename.
 *
 * A query that only names NOTES — `date:2026-01-01`, a bare property
 * qualifier, or nothing at all — stays a note listing: every block in every
 * matching note is not a search result, it's the corpus. That rule is what
 * keeps the notes page browsing notes, while typing text into it narrows to
 * blocks.
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
function useBlockSearchSource(): BlockSearchSource {
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
  /** The matching blocks, best first. Empty in "notes" mode. */
  hits: BlockHit[]
  /** The notes to list ("notes"), or the notes the hits live in ("blocks") —
   * either way what the result count is computed from. */
  notes: Note[]
  /** "blocks" mode: the notes whose TITLE matched the query's text, each a
   * row among the hits. Empty when the query asks for blocks of a type or
   * scopes with `in:` (a note is neither), and in "notes" mode. */
  titleMatches: Note[]
  /** The rows to draw, in order: "blocks" mode ranks the title matches and
   * the hits together by score (`rankResultRows`); "notes" mode lists the
   * notes. */
  rows: ResultRow[]
}

const NO_HITS: BlockHit[] = []
const NO_NOTES: Note[] = []

/**
 * The notes whose title matches the query's text, scored, and filtered by
 * whatever note-level qualifiers the query carries (a date, a property).
 * None when the query names a block type or an `in:` scope: it asks for
 * blocks, and a note row would not be one.
 */
function useTitleMatches(query: string, showBlocks: boolean): ScoredNote[] {
  const searcher = useAtomValue(noteTitleSearcherAtom)
  return React.useMemo(() => {
    if (!showBlocks) return []
    const parsed = parseQuery(query)
    const text = parsed.fuzzy.trim()
    if (!text) return []
    if (hasBlockTypeFilter(parsed.filters)) return []
    if (parsed.filters.some((filter) => filter.key === "in")) return []
    const matches = searcher.search(text, { returnMatchData: true })
    const scores = new Map(matches.map((match) => [match.item.id, match.score]))
    let notes = filterNotes(
      matches.map((match) => match.item),
      parsed.filters,
    )
    if (parsed.sorts.length) notes = sortNotes(notes, parsed.sorts)
    return notes.map((note) => ({ note, score: scores.get(note.id) ?? 0 }))
  }, [searcher, query, showBlocks])
}

/** Resolve a query to result rows — blocks when it discriminates blocks, notes
 * otherwise (see `resolvesToBlocks`). */
export function useSearchResults(query: string): SearchResults {
  const searchNotes = useSearchNotes()
  const source = useBlockSearchSource()
  const showBlocks = resolvesToBlocks(query)
  const titleMatches = useTitleMatches(query, showBlocks)

  // Memoized so an async source is asked once per query, not once per render.
  const result = React.useMemo(
    () => (showBlocks ? source.search(query) : NO_HITS),
    [showBlocks, source, query],
  )
  const hits = useAwaited(result, NO_HITS)

  return React.useMemo(() => {
    if (!showBlocks) {
      const notes = searchNotes(query)
      return {
        mode: "notes",
        hits: NO_HITS,
        notes,
        titleMatches: NO_NOTES,
        rows: notes.map((note) => ({ id: note.id, noteId: note.id, kind: "note" })),
      }
    }
    const sorted = parseQuery(query).sorts.length > 0
    return {
      mode: "blocks",
      hits,
      notes: notesFromBlockHits(hits),
      titleMatches: titleMatches.map((match) => match.note),
      rows: rankResultRows(titleMatches, hits, sorted),
    }
  }, [showBlocks, hits, query, searchNotes, titleMatches])
}
