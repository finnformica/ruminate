import { useNavigate } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React, { useState } from "react"
import { useDebounce } from "use-debounce"
import { useSearchResults } from "../hooks/search-results"
import type { ResultRoot } from "../hooks/results-doc"
import { ownSortedNotesAtom, pinnedRootsAtom, sharedNotesAtom } from "../global-state"
import type { Note, NoteId } from "../schema"
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
 *
 * **With no query the listing is split into the sidebar's sections** —
 * Views, Notes, Shared — because one undifferentiated list of everything
 * gave no way to tell your own note from one someone shared with you, or to
 * find a pinned note among the rest. The sections, their order and their
 * contents are the sidebar's exactly, so the two surfaces read the same
 * way — **Views** included, which means the pinned blocks as well as the
 * pinned notes (`pinnedRootsAtom`). A pinned note is in **Notes** below as
 * well, in its sorted place.
 *
 * A query is *not* sectioned: results are ranked by score across the whole
 * corpus (docs/query-language.md), and cutting that ranking into bands would
 * bury a better match beneath a worse one in a band above it.
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
  const browsing = fullQuery === ""

  const ownNotes = useAtomValue(ownSortedNotesAtom)
  const sharedNotes = useAtomValue(sharedNotesAtom)
  const pinnedRoots = useAtomValue(pinnedRootsAtom)

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

  // The three bands, each the roots its own results block draws. Views
  // leads (it leads the sidebar too) and holds both kinds of pin; then all
  // of your own notes in the chosen sort — the pinned ones among them, since
  // a pin adds a place to reach a note rather than moving it; then what
  // other people shared with you.
  const sections = React.useMemo(() => {
    if (!browsing) return []
    const rootsOf = (notes: Note[]) => notes.map((note) => ({ id: note.id, noteId: note.id }))
    const shared = sharedNotes.map(({ note }) => note)
    return [
      { key: "views", heading: "Views", roots: pinnedRoots },
      // Named "Notes" only when it is one band among several; on its own it
      // is the whole list and a heading over it says nothing.
      {
        key: "own",
        heading: pinnedRoots.length + shared.length > 0 ? "Notes" : null,
        roots: rootsOf(ownNotes),
      },
      { key: "shared", heading: "Shared", roots: rootsOf(shared) },
    ].filter((section) => section.roots.length > 0)
  }, [browsing, ownNotes, sharedNotes, pinnedRoots])

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
      {browsing ? (
        <NoteSections
          sections={sections}
          onOpen={openNote}
          focusFirstSignal={focusFirstSignal}
          onExitTop={() => inputRef.current?.focus()}
        />
      ) : (
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
      )}
    </div>
  )
}

interface NoteSection {
  key: string
  /** Null for a band that is the whole list, which needs no name. */
  heading: string | null
  /** What the band draws — notes, or (under Views) blocks too, each opening
   * its note focused on it. */
  roots: readonly ResultRoot[]
}

/**
 * The browse listing as its bands, each a results block under its heading.
 *
 * The keyboard walks them as one list: `↓` past the last row of a band hands
 * the highlight to the first row of the next, `↑` past the first row hands it
 * back to the band above — and out of the top band, back to the query box.
 * This is how the ⌘K palette chains its Recent and Views lists
 * (`command-menu.tsx`); the signals are the same ones.
 */
function NoteSections({
  sections,
  onOpen,
  focusFirstSignal,
  onExitTop,
}: {
  sections: NoteSection[]
  onOpen: (noteId: NoteId, blockId?: string) => void
  focusFirstSignal: number
  onExitTop: () => void
}) {
  // One "enter this band from above / from below" signal per band. Bumping a
  // signal is what moves the highlight across a boundary.
  const [enterTop, setEnterTop] = useState<Record<string, number>>({})
  const [enterBottom, setEnterBottom] = useState<Record<string, number>>({})
  const bump = (set: React.Dispatch<React.SetStateAction<Record<string, number>>>, key: string) =>
    set((signals) => ({ ...signals, [key]: (signals[key] ?? 0) + 1 }))

  const emptyResults = React.useMemo(
    () => ({ mode: "notes" as const, hits: [], notes: [], titleMatches: [], rows: [] }),
    [],
  )

  return (
    <div className="flex flex-col gap-4">
      {sections.map((section, index) => {
        const previous = sections[index - 1]
        const next = sections[index + 1]
        return (
          <div key={section.key} className="flex flex-col gap-2">
            {section.heading ? (
              <h2 className="text-sm text-text-secondary">{section.heading}</h2>
            ) : null}
            <ResultsList
              query=""
              results={emptyResults}
              browseRoots={section.roots}
              limit={PAGE_SIZE}
              more
              readOnly
              onOpen={onOpen}
              // The top band takes the hand-off from the query box; the rest
              // take it from the band above them.
              focusFirstSignal={index === 0 ? focusFirstSignal : enterTop[section.key]}
              focusLastSignal={enterBottom[section.key]}
              onExitTop={previous ? () => bump(setEnterBottom, previous.key) : onExitTop}
              onExitBottom={next ? () => bump(setEnterTop, next.key) : undefined}
              // One highlight on the page, in the first band: three lists
              // each highlighting their own first row would read as three
              // separate selections.
              initialSelection={index === 0 ? "first" : "none"}
            />
          </div>
        )
      })}
    </div>
  )
}
