import { useAtomValue } from "jotai"
import React from "react"
import type { FullOptions, Searcher as FuzzySearcher } from "fast-fuzzy"
import { noteSearcherAtom, searchBlocksAtom, sortedNotesAtom } from "../global-state"
import { hasBlockTypeFilter, notesFromBlockHits, type BlockHit } from "../utils/block-search"
import { parseQuery } from "../utils/search"
import { filterNotes, sortNotes } from "../utils/search-notes"
import type { Note } from "../schema"

// Shared search routine used by both hooks
function runSearch(
  query: string,
  sortedNotes: Note[],
  noteSearcher: FuzzySearcher<Note, FullOptions<Note>>,
  searchBlocks: (query: ReturnType<typeof parseQuery>) => BlockHit[],
) {
  if (!query) return sortedNotes
  const parsed = parseQuery(query)
  // A block-scoped `type:` (e.g. `type:todo`) resolves the query at block
  // granularity: the list shows the notes containing matching blocks, in hit
  // order. Queries without one behave exactly as before.
  if (hasBlockTypeFilter(parsed.filters)) {
    return notesFromBlockHits(searchBlocks(parsed))
  }
  const { fuzzy, filters, sorts } = parsed
  const results = fuzzy ? noteSearcher.search(fuzzy) : sortedNotes
  const filtered = filterNotes(results, filters)
  return sorts.length ? sortNotes(filtered, sorts) : filtered
}

export function useSearchNotes() {
  const sortedNotes = useAtomValue(sortedNotesAtom)
  const noteSearcher = useAtomValue(noteSearcherAtom)
  const searchBlocks = useAtomValue(searchBlocksAtom)

  const searchNotes = React.useCallback(
    (query: string) => {
      return runSearch(query, sortedNotes, noteSearcher, searchBlocks)
    },
    [sortedNotes, noteSearcher, searchBlocks],
  )

  return searchNotes
}
