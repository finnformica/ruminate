import { useNavigate } from "@tanstack/react-router"
import React, { useState } from "react"
import { useDebounce } from "use-debounce"
import { useSearchResults } from "../hooks/search-results"
import { pluralize } from "../utils/pluralize"
import { QueryBox } from "./query-box"
import { ResultsList } from "./results-list"

type NoteListProps = {
  baseQuery?: string
  query: string
  onQueryChange: (query: string) => void
  /**
   * `↓` in the search box hands the keyboard to the rows (and `↑` past the
   * first row hands it back). The rows' own keys are the block editor's
   * whatever this says; only the notes *index* page turns the hand-off on.
   */
  enableKeyboardNav?: boolean
}

/** How many rows the page draws before **Load more**. */
const PAGE_SIZE = 10

/** How long typing settles before the query runs — the palette's too. */
export const QUERY_DEBOUNCE_MS = 150

/**
 * The notes page: the query box over the results block (`QueryBox`,
 * `ResultsList` — the same two the ⌘K palette is made of). A query with
 * text (or a block-scoped `type:`) resolves to BLOCKS: the results are the
 * matching blocks themselves, at any depth. A query that only names notes
 * (a date, a property, nothing at all) keeps the note listing — see
 * `resolvesToBlocks`. A filtered view edits in place; the plain notes list
 * is browsed (for now — it could edit too).
 */
export function NoteList({
  baseQuery = "",
  query,
  onQueryChange,
  enableKeyboardNav = false,
}: NoteListProps) {
  const navigate = useNavigate()
  const [deferredQuery] = useDebounce(query, QUERY_DEBOUNCE_MS)
  const fullQuery = `${baseQuery} ${deferredQuery}`.trim()
  const results = useSearchResults(fullQuery)
  const readOnly = fullQuery === ""

  // The keyboard hand-off between the search box and the rows.
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [focusFirstSignal, setFocusFirstSignal] = useState(0)
  const hasRows = results.mode === "blocks" ? results.hits.length > 0 : results.notes.length > 0
  const handOff = () => {
    if (!enableKeyboardNav || !hasRows) return false
    inputRef.current?.blur()
    setFocusFirstSignal((n) => n + 1)
    return true
  }

  const openNote = React.useCallback(
    (noteId: string, block?: string) =>
      navigate({ to: "/notes/$", params: { _splat: noteId }, search: { query: undefined, block } }),
    [navigate],
  )

  return (
    <div className="flex flex-col gap-4">
      <QueryBox
        inputRef={inputRef}
        placeholder={`Search ${pluralize(results.notes.length, "note")}…`}
        shortcut={["/"]}
        value={query}
        onChange={onQueryChange}
        onHandOff={handOff}
      />
      <ResultsList
        query={fullQuery}
        results={results}
        limit={PAGE_SIZE}
        more
        readOnly={readOnly}
        onOpen={openNote}
        focusFirstSignal={focusFirstSignal}
        onExitTop={() => inputRef.current?.focus()}
      />
    </div>
  )
}
