import React, { useState } from "react"
import { useInView } from "react-intersection-observer"
import type { ResultRoot } from "../hooks/results-doc"
import type { SearchResults } from "../hooks/search-results"
import type { Note, NoteId } from "../schema"
import { cx } from "../utils/cx"
import { pluralize } from "../utils/pluralize"
import { Button } from "./button"
import { ResultsEditor } from "./results-editor"

/**
 * **The results block** — what a query resolves to, drawn the one way on
 * the notes page and in the ⌘K palette: the count line ("3 matching blocks
 * in 2 notes", "12 results", or that nothing matched), then the rows — the
 * block editor over the matched blocks or notes (`ResultsEditor`) — and,
 * where the surface wants it, a way to the rest.
 *
 * The rows are the roots the results name. A query with text resolves to
 * blocks; one that only names notes lists notes; with no query at all the
 * surface says what to browse (`browseNotes`: the palette's pinned notes;
 * the page leaves it to the empty query, every note). The palette also
 * lists the notes whose TITLE
 * matched ahead of the blocks (`leading`) — a note is a node whose children
 * are its blocks, so it is a root row like any other.
 *
 * Only `limit` rows are drawn at first. `more` adds a **Load more** button
 * beneath, which also fires as it scrolls into view; a new query starts
 * over from `limit`.
 */
export function ResultsList({
  query,
  results,
  leading = NO_NOTES,
  browseNotes,
  limit,
  more = false,
  readOnly = false,
  variant = "page",
  onOpen,
  focusFirstSignal,
  onExitTop,
}: {
  /** The full query the results are for — empty when browsing. */
  query: string
  results: SearchResults
  /** Notes to list ahead of the hits (title matches); capped at `limit`. */
  leading?: readonly Note[]
  /** What to list with no query at all (the palette's pinned notes); left
   * out, every note the empty query resolved to. */
  browseNotes?: readonly Note[]
  /** How many rows to draw before **Load more**. */
  limit: number
  /** Offer the rest beneath the rows. */
  more?: boolean
  /** Browse only: rows open rather than edit. */
  readOnly?: boolean
  /** The count line's inset: the page's flush line, or the palette's item
   * gutter. */
  variant?: "page" | "palette"
  /** Open a note — zoomed to a block, when one is given. */
  onOpen: (noteId: NoteId, blockId?: string) => void
  /** Bump to highlight the first row (↓ from the query box). */
  focusFirstSignal?: number
  /** ↑ past the first row hands focus back (to the query box). */
  onExitTop?: () => void
}) {
  const { mode, hits, notes } = results
  const showBlocks = mode === "blocks"
  const browsing = query === ""

  // The number of rows on show; back to `limit` for each new query
  // (render-phase reset, so the first paint of a query is never long).
  const [visible, setVisible] = useState(limit)
  const prevQuery = React.useRef(query)
  if (prevQuery.current !== query) {
    prevQuery.current = query
    if (visible !== limit) setVisible(limit)
  }

  // The matched rows: blocks, or notes. Everything else listed (the title
  // matches, the browse roots) is context, and never in the count. With no
  // query and nothing said to browse, the listing is every note the empty
  // query resolved to.
  const browseList = browseNotes ?? notes
  const total = browsing ? browseList.length : showBlocks ? hits.length : notes.length
  const roots = React.useMemo<ResultRoot[]>(() => {
    if (browsing)
      return browseList.slice(0, visible).map((note) => ({ id: note.id, noteId: note.id }))
    const lead = leading.slice(0, limit).map((note) => ({ id: note.id, noteId: note.id }))
    const matched = showBlocks
      ? hits.slice(0, visible).map((hit) => ({ id: hit.blockId, noteId: hit.noteId }))
      : notes.slice(0, visible).map((note) => ({ id: note.id, noteId: note.id }))
    return [...lead, ...matched]
  }, [browsing, browseList, leading, limit, showBlocks, hits, notes, visible])

  const loadMore = React.useCallback(() => {
    setVisible((count) => Math.min(count + limit, total))
  }, [limit, total])
  const [bottomRef, bottomInView] = useInView()
  React.useEffect(() => {
    if (more && bottomInView) loadMore()
  }, [more, bottomInView, loadMore])

  // Counts the MATCHED blocks. Children revealed by expanding a result are
  // context, not matches, so they never inflate it — which is what makes
  // the number checkable.
  const count = browsing
    ? null
    : showBlocks
      ? hits.length === 0
        ? "No matching blocks"
        : `${pluralize(hits.length, "matching block")} in ${pluralize(notes.length, "note")}`
      : notes.length === 0
        ? "No matching notes"
        : pluralize(notes.length, "result")

  return (
    <div className="flex flex-col gap-3">
      {count ? (
        <div
          data-testid="result-count"
          className={cx(
            "text-sm leading-4 text-text-secondary",
            variant === "palette" && "px-1.5 py-2",
          )}
        >
          {count}
        </div>
      ) : null}
      {/* Set in by the rows' own reach (a root's surface extends 4.5px past
          its box), so the surfaces sit flush with what is above. */}
      <div className="px-[4.5px] empty:hidden">
        <ResultsEditor
          roots={roots}
          resetKey={`${mode}:${query}`}
          readOnly={readOnly}
          onOpen={onOpen}
          focusFirstSignal={focusFirstSignal}
          onExitTop={onExitTop}
        />
      </div>
      {more && total > visible ? (
        <Button ref={bottomRef} className="w-full" onClick={loadMore}>
          Load more
        </Button>
      ) : null}
    </div>
  )
}

const NO_NOTES: readonly Note[] = []
