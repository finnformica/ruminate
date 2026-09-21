import React, { useState } from "react"
import { useInView } from "react-intersection-observer"
import type { ResultRoot } from "../hooks/results-doc"
import type { SearchResults } from "../hooks/search-results"
import type { NoteId } from "../schema"
import { cx } from "../utils/cx"
import { pluralize } from "../utils/pluralize"
import { Button } from "./ui/button"
import { ResultsEditor } from "./results-editor"

/**
 * **The results block** — what a query resolves to, drawn the one way on
 * the notes page and in the ⌘K palette: the count line ("3 matching blocks
 * in 2 notes", "12 results", or that nothing matched), then the rows — the
 * block editor over the matched blocks or notes (`ResultsEditor`) — and,
 * where the surface wants it, a way to the rest.
 *
 * The rows are the roots the results name (`results.rows`): a query with
 * text resolves to blocks — and the notes whose title matched, ranked among
 * them purely by score (`rankResultRows`; a note is a node whose children
 * are its blocks, so it is a root row like any other); one that only names
 * notes lists notes; with no query at all the surface says what to browse
 * (`browseRoots`: the palette's recent notes, and its pinned notes and
 * blocks; the page leaves it to the empty query, every note).
 *
 * Only `limit` rows are drawn at first. `more` adds a **Load more** button
 * beneath, which also fires as it scrolls into view; a new query starts
 * over from `limit`.
 */
export function ResultsList({
  query,
  results,
  browseRoots,
  limit,
  more = false,
  readOnly = false,
  variant = "page",
  onOpen,
  focusFirstSignal,
  focusLastSignal,
  onExitTop,
  onExitBottom,
  initialSelection,
}: {
  /** The full query the results are for — empty when browsing. */
  query: string
  results: SearchResults
  /** What to list with no query at all (the palette's recent notes, or its
   * pinned notes and blocks — a block root opens its note focused on it);
   * left out, every note the empty query resolved to. */
  browseRoots?: readonly ResultRoot[]
  /** How many rows to draw before **Load more**. */
  limit: number
  /** Offer the rest beneath the rows. */
  more?: boolean
  /** Browse only: rows open rather than edit. */
  readOnly?: boolean
  /** The count line's inset: the page's flush line, or the palette's item
   * gutter. */
  variant?: "page" | "palette"
  /** Open a note — focused on a block, when one is given. */
  onOpen: (noteId: NoteId, blockId?: string) => void
  /** Bump to highlight the first row (↓ from the query box). */
  focusFirstSignal?: number
  /** Bump to highlight the last row (↑ from a list beneath this one). */
  focusLastSignal?: number
  /** ↑ past the first row hands focus back (to the query box). */
  onExitTop?: () => void
  /** ↓ past the last row hands focus on (to a list beneath this one). */
  onExitBottom?: () => void
  /** The first row highlighted on mount (the page), or nothing until the
   * keyboard arrives (the palette's lists). */
  initialSelection?: "first" | "none"
}) {
  const { mode, hits, notes, titleMatches, rows: ranked } = results
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

  // The rows: the ranked results, or what the surface browses with no
  // query — and nothing said to browse is every note the empty query
  // resolved to.
  const browseList = React.useMemo<readonly ResultRoot[]>(
    () => browseRoots ?? notes.map((note) => ({ id: note.id, noteId: note.id })),
    [browseRoots, notes],
  )
  const total = browsing ? browseList.length : ranked.length
  const roots = React.useMemo<ResultRoot[]>(
    () =>
      browsing
        ? browseList.slice(0, visible)
        : ranked.slice(0, visible).map((row) => ({ id: row.id, noteId: row.noteId })),
    [browsing, browseList, ranked, visible],
  )

  const loadMore = React.useCallback(() => {
    setVisible((count) => Math.min(count + limit, total))
  }, [limit, total])
  const [bottomRef, bottomInView] = useInView()
  React.useEffect(() => {
    if (more && bottomInView) loadMore()
  }, [more, bottomInView, loadMore])

  // Counts the MATCHED blocks, and the notes whose title matched. Children
  // revealed by expanding a result are context, not matches, so they never
  // inflate it — which is what makes the number checkable.
  const byTitle = titleMatches.length ? `, ${pluralize(titleMatches.length, "note")} by title` : ""
  const count = browsing
    ? null
    : showBlocks
      ? hits.length === 0 && titleMatches.length === 0
        ? "No matching blocks"
        : `${pluralize(hits.length, "matching block")} in ${pluralize(notes.length, "note")}${byTitle}`
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
          focusLastSignal={focusLastSignal}
          onExitTop={onExitTop}
          onExitBottom={onExitBottom}
          initialSelection={initialSelection}
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
