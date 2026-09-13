import { useNavigate } from "@tanstack/react-router"
import React, { useState } from "react"
import { useInView } from "react-intersection-observer"
import { useDebounce } from "use-debounce"
import type { ResultRoot } from "../hooks/results-doc"
import { useSearchResults } from "../hooks/search-results"
import { parseQuery, removeQualifier } from "../utils/search"
import { pluralize } from "../utils/pluralize"
import { Button } from "./button"
import { ResultsEditor } from "./results-editor"
import { ScopePill } from "./scope-pill"
import { SearchInput } from "./search-input"

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

const initialVisibleItems = 10

export function NoteList({
  baseQuery = "",
  query,
  onQueryChange,
  enableKeyboardNav = false,
}: NoteListProps) {
  const navigate = useNavigate()

  const [deferredQuery] = useDebounce(query, 150)

  // A query with text (or a block-scoped `type:`) resolves to BLOCKS: the
  // results are the matching blocks themselves, at any depth. A query that
  // only names notes (a date, a property, nothing at all) keeps the note listing —
  // see `resolvesToBlocks`.
  const fullQuery = `${baseQuery} ${deferredQuery}`.trim()
  const { mode, hits, notes: noteResults } = useSearchResults(fullQuery)
  const showBlocks = mode === "blocks"

  const [numVisibleItems, setNumVisibleItems] = useState(initialVisibleItems)

  // The two modes differ only in WHICH ROOTS are listed. A note is a node
  // whose children are its blocks (docs/graph-schema-v2.md), so a note is a
  // root row exactly as a matched block is — and from here down there is one
  // editor, one keyboard, one set of rows (`ResultsEditor`).
  const totalResults = showBlocks ? hits.length : noteResults.length
  const roots = React.useMemo<ResultRoot[]>(
    () =>
      showBlocks
        ? hits.slice(0, numVisibleItems).map((hit) => ({ id: hit.blockId, noteId: hit.noteId }))
        : noteResults.slice(0, numVisibleItems).map((note) => ({ id: note.id, noteId: note.id })),
    [showBlocks, hits, noteResults, numVisibleItems],
  )
  // A filtered view edits in place; the plain notes list is browsed (for
  // now — it could edit too).
  const readOnly = fullQuery === ""

  // The keyboard hand-off between the search box and the rows: `↓` in the
  // box highlights the first row; `↑` past the first row returns to the box.
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [focusFirstSignal, setFocusFirstSignal] = useState(0)
  const searchInput = () =>
    containerRef.current?.querySelector<HTMLInputElement>('input[type="search"]') ?? null
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!enableKeyboardNav || event.key !== "ArrowDown" || roots.length === 0) return
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    event.currentTarget.blur()
    setFocusFirstSignal((n) => n + 1)
  }
  const openNote = React.useCallback(
    (noteId: string, block?: string) =>
      navigate({ to: "/notes/$", params: { _splat: noteId }, search: { query: undefined, block } }),
    [navigate],
  )

  const [bottomRef, bottomInView] = useInView()

  const loadMore = React.useCallback(() => {
    setNumVisibleItems((num) => Math.min(num + 10, totalResults))
  }, [totalResults])

  React.useEffect(() => {
    if (bottomInView) {
      // Load more notes when the user scrolls to the bottom of the list
      loadMore()
    }
  }, [bottomInView, loadMore])

  const filters = React.useMemo(() => {
    return parseQuery(query).filters
  }, [query])

  // `in:` scopes — shown as pills naming the note (or block), since the
  // query carries an id.
  const scopeFilters = React.useMemo(() => {
    return filters.filter((filter) => filter.key === "in")
  }, [filters])

  return (
    <>
      <div ref={containerRef}>
        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            <SearchInput
              placeholder={`Search ${pluralize(noteResults.length, "note")}…`}
              shortcut={["/"]}
              value={query}
              autoCapitalize="off"
              spellCheck="false"
              suggest
              onKeyDown={handleSearchKeyDown}
              onChange={(value) => {
                onQueryChange(value)

                // Reset the number of visible notes when the user starts typing
                setNumVisibleItems(initialVisibleItems)
              }}
            />
          </div>
          {scopeFilters.length > 0 || deferredQuery ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2 empty:hidden">
                {scopeFilters.flatMap((filter) =>
                  filter.values.map((value) => (
                    <ScopePill
                      key={`${filter.exclude ? "-" : ""}in:${value}`}
                      value={value}
                      exclude={filter.exclude}
                      // Remove the scope from the query (the whole qualifier:
                      // a comma list goes as one).
                      onRemove={() => onQueryChange(removeQualifier(query, filter))}
                    />
                  )),
                )}
              </div>
              {deferredQuery ? (
                <div data-testid="result-count" className="text-sm text-text-secondary leading-4">
                  {/* Counts the MATCHED blocks. Children revealed by expanding
                      a result are context, not matches, so they never inflate
                      it — which is what makes the number checkable. */}
                  {showBlocks
                    ? `${pluralize(totalResults, "matching block")} in ${pluralize(noteResults.length, "note")}`
                    : pluralize(totalResults, "result")}
                </div>
              ) : null}
            </div>
          ) : null}
          {/* One editor, whatever the roots are: matched blocks, or the
              notes themselves. Open a row to read what is inside it. Set in
              by the rows' own reach (a root's surface extends 4.5px past its
              box), so the surfaces sit flush with the search box. */}
          <div className="px-[4.5px]">
            <ResultsEditor
              roots={roots}
              resetKey={`${mode}:${fullQuery}`}
              readOnly={readOnly}
              onOpen={openNote}
              focusFirstSignal={focusFirstSignal}
              onExitTop={() => searchInput()?.focus()}
            />
          </div>
        </div>

        {totalResults > numVisibleItems ? (
          <Button ref={bottomRef} className="mt-4 w-full" onClick={loadMore}>
            Load more
          </Button>
        ) : null}
      </div>
    </>
  )
}
