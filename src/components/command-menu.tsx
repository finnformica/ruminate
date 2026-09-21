import { useMatch, useNavigate } from "@tanstack/react-router"
import { parseDate } from "chrono-node"
import { Command } from "cmdk"
import { atom, useAtom, useAtomValue } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useDebounce } from "use-debounce"
import {
  pinnedBlocksAtom,
  pinnedNotesAtom,
  recentTouchesAtom,
  sortedNotesAtom,
} from "../global-state"
import type { ResultRoot } from "../hooks/results-doc"
import { recentNotes as recentTouched } from "../utils/recent-notes"
import { useCreateNote } from "../hooks/note"
import { useSearchResults } from "../hooks/search-results"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS, formatCombo } from "../shortcuts/registry"
import { formatDate, formatDateDistance, toDateString } from "../utils/date"
import { generateNoteId } from "../utils/note-id"
import { composeQuery, parseQuery } from "../utils/search"
import { CalendarDateIcon16, PlusIcon16 } from "./icons"
import { Keys } from "./keys"
import { Surface } from "./ui/surface"
import { QUERY_DEBOUNCE_MS } from "./note-list"
import { QueryBox } from "./query-box"
import { ResultsList } from "./results-list"

export const isCommandMenuOpenAtom = atom(false)

/** The cmdk root the palette's input sits in. */
function paletteRoot(input: HTMLInputElement | null): HTMLElement | null {
  return input?.closest<HTMLElement>("[cmdk-root]") ?? null
}

/** Is cmdk's highlight on the last item (or is there no item to be on)? The
 * point past which ↓ hands the keyboard to the results beneath. */
function highlightIsLastItem(root: HTMLElement): boolean {
  const items = root.querySelectorAll("[cmdk-item]")
  if (items.length === 0) return true
  return items[items.length - 1].getAttribute("aria-selected") === "true"
}

/** Is any of cmdk's items highlighted? Read off the DOM — cmdk's own
 * source of truth for what ↵ picks. */
function hasHighlightedItem(root: HTMLElement): boolean {
  return root.querySelector('[cmdk-item][aria-selected="true"]') !== null
}

/** How many result rows the palette lists. */
const NUM_VISIBLE_RESULTS = 6

/** The keys cmdk walks its items with (plus ctrl+n / ctrl+p). */
const NAVIGATION_KEYS = new Set(["ArrowUp", "ArrowDown", "Home", "End"])

/**
 * **The ⌘K palette**: the one query box over the results block, the notes
 * page's own two (`QueryBox`, `ResultsList`), in a dialog. The query is a
 * search of everything, wherever the palette opens: a filter narrows it
 * only when typed (`in:`, `type:`, …), each lifted out of the line as a
 * pill. ⌘P is the same palette with two filters set for it — the open
 * note's headings (`type:heading in:<note>`) — so "jump to a heading" is a
 * search like any other, and typing narrows the headings.
 */
export function CommandMenu() {
  const navigate = useNavigate()
  const createNote = useCreateNote()
  // With nothing typed: the notes most recently TOUCHED — edited or created
  // (the graph's `updatedAt`) merged with what was opened, edited or folded
  // on this device (`recentTouchesAtom`) — at most five; then the pinned
  // notes beneath, less any already listed as recent, so nothing is there
  // twice, and the pinned blocks after them (docs/metadata.md), each a row
  // that opens its note focused on it.
  const sortedNotes = useAtomValue(sortedNotesAtom)
  const touches = useAtomValue(recentTouchesAtom)
  const recentNotes = useMemo(() => recentTouched(touches, sortedNotes), [touches, sortedNotes])
  const recentRoots = useMemo<ResultRoot[]>(
    () => recentNotes.map((note) => ({ id: note.id, noteId: note.id })),
    [recentNotes],
  )
  const pinned = useAtomValue(pinnedNotesAtom)
  const pinnedBlocks = useAtomValue(pinnedBlocksAtom)
  const pinnedRoots = useMemo<ResultRoot[]>(
    () => [
      ...pinned
        .filter((note) => !recentNotes.some((recent) => recent.id === note.id))
        .map((note) => ({ id: note.id, noteId: note.id })),
      ...pinnedBlocks.map((block) => ({ id: block.id, noteId: block.noteId })),
    ],
    [pinned, pinnedBlocks, recentNotes],
  )
  const [isOpen, setIsOpen] = useAtom(isCommandMenuOpenAtom)

  // The open note, if any: it leads the `in:` suggestions, and ⌘P searches
  // its headings — or, focused on a block, the headings under that block.
  const noteMatch = useMatch({ from: "/_appRoot/notes_/$", shouldThrow: false })
  const noteId = noteMatch?.params._splat
  const focusBlockId = noteMatch?.search?.block
  const headingsQuery = useMemo(
    () => composeQuery(["type:heading", ...(noteId ? [`in:${focusBlockId ?? noteId}`] : [])], ""),
    [noteId, focusBlockId],
  )

  // Refs
  const prevActiveElement = useRef<HTMLElement>()
  const inputRef = useRef<HTMLInputElement>(null)
  // The popover's host: the dialog's body, outside the card that clips its
  // corners, so the qualifier popover can hang over the list.
  const bodyRef = useRef<HTMLDivElement>(null)

  // The query, as the box composes it: the filters first, then the text.
  const [query, setQuery] = useState("")
  const [deferredQuery] = useDebounce(query, QUERY_DEBOUNCE_MS)
  const text = useMemo(() => parseQuery(query).fuzzy, [query])

  // The cmdk-highlighted item's value, controlled: cmdk only reports highlight
  // changes through onValueChange when `value` is a controlled prop. Nothing
  // is highlighted until the reader arrows or points at an item: the query
  // is a search, and ↵ commits it (`submit`) rather than picking whatever
  // item happened to be first. cmdk itself highlights the first item
  // whenever its items change (a keystroke filters them); such a pick
  // arrives here with no interaction behind it (`interactingRef`) and is
  // refused — by handing cmdk a value no item has, fresh each time so it
  // takes it up.
  const [highlightedValue, setHighlightedValue] = useState("")
  const interactingRef = useRef(false)
  const noHighlightRef = useRef(0)
  const noHighlight = () => `none:${++noHighlightRef.current}`
  const noteInteraction = () => {
    interactingRef.current = true
    queueMicrotask(() => {
      interactingRef.current = false
    })
  }

  // Open with a query set (⌘P's), or with nothing: a fresh palette is a
  // fresh search.
  const openMenu = useCallback(
    (initialQuery = "") => {
      prevActiveElement.current = document.activeElement as HTMLElement
      setQuery(initialQuery)
      setHighlightedValue("")
      setIsOpen(true)
    },
    [setIsOpen],
  )

  // Close, and put the keyboard back where it was. The query goes with the
  // dialog: reopening starts over.
  const closeMenu = useCallback(() => {
    setIsOpen(false)
    setQuery("")
    setTimeout(() => {
      prevActiveElement.current?.focus()
    })
  }, [setIsOpen])

  // Close on the way somewhere else: the destination takes the keyboard.
  const leave = useCallback(() => {
    setIsOpen(false)
    setQuery("")
  }, [setIsOpen])

  const toggleMenu = useCallback(() => {
    if (isOpen) {
      closeMenu()
    } else {
      openMenu()
    }
  }, [isOpen, openMenu, closeMenu])

  const handleSelect = useCallback(
    (callback: () => void) => {
      return () => {
        leave()
        callback()
      }
    },
    [leave],
  )

  useHotkeys(APP_SHORTCUTS.commandMenu, toggleMenu, GLOBAL_HOTKEY_OPTIONS)

  // ⌘P: the palette with the open note's headings as the query. Pressed
  // while the palette shows something else, it sets that query; pressed
  // while it shows exactly that, it closes — the same toggle feel as ⌘K.
  useHotkeys(
    APP_SHORTCUTS.searchHeadings,
    () => {
      if (!isOpen) {
        openMenu(headingsQuery)
      } else if (query === headingsQuery) {
        closeMenu()
      } else {
        setQuery(headingsQuery)
        setHighlightedValue("")
      }
    },
    GLOBAL_HOTKEY_OPTIONS,
  )

  // Typing takes the highlight off whatever item had it: a fresh query is a
  // search.
  const handleQueryChange = useCallback((value: string) => {
    setHighlightedValue("")
    setQuery(value)
  }, [])

  // The text, read as a date: the palette's one item of its own.
  const dateString = useMemo(() => {
    const date = parseDate(parseQuery(deferredQuery).fuzzy)
    if (!date) return ""
    return toDateString(date)
  }, [deferredQuery])

  // Search BLOCKS — the palette's primary results. A nested heading or a todo
  // is a first-class row here, not a note it happens to live in; a note
  // whose title matched is a row among them, by score.
  const results = useSearchResults(deferredQuery)
  const hasRows = deferredQuery
    ? results.rows.length > 0
    : recentNotes.length > 0 || pinnedRoots.length > 0

  // The keyboard's way through the rows. With nothing typed there are two
  // lists, Recent and then Views, walked as one: ↓ from the query lands on
  // the first row of the first list there is; ↓ past the last recent row
  // lands on the first pinned row (`recentToPinned`); ↑ past the first
  // pinned row lands on the last recent row (`pinnedToRecent`); ↑ past the
  // first row of the first list returns to the query. Each hop is a signal
  // the editor concerned acts on.
  const [focusFirstSignal, setFocusFirstSignal] = useState(0)
  const [recentLastSignal, setRecentLastSignal] = useState(0)
  const [pinnedFirstSignal, setPinnedFirstSignal] = useState(0)
  const recentToPinned = useCallback(() => setPinnedFirstSignal((n) => n + 1), [])
  const pinnedToRecent = useCallback(() => setRecentLastSignal((n) => n + 1), [])
  /** ↓ in the query with cmdk's highlight on the last item (or no items at
   * all) hands the keyboard to the result rows: the editor takes focus
   * (cmdk's highlight stays on the last item, dimmed — command-menu.css —
   * and marks where ↑ returns to). */
  const handOff = useCallback(() => {
    const root = paletteRoot(inputRef.current)
    if (!root || !hasRows || !highlightIsLastItem(root)) return false
    setFocusFirstSignal((n) => n + 1)
    return true
  }, [hasRows])
  /** Take the keyboard back from the rows: the query has focus again, with
   * cmdk's highlight on the last item — the one ↓ left from. */
  const takeBackFromRows = useCallback(() => {
    inputRef.current?.focus()
    const items = paletteRoot(inputRef.current)?.querySelectorAll("[cmdk-item]") ?? []
    const last = items[items.length - 1]
    setHighlightedValue(last?.getAttribute("data-value") ?? "")
  }, [])

  // Create a note from the query — the palette's footer, and ⌘↵. The typed
  // TEXT becomes the note's title (a filter is not a title); the id is
  // minted and opaque (docs/graph-storage.md). Any text works — there is no
  // filename charset to sanitize against and no name collision to avoid, so
  // a fresh note is always a fresh note; with nothing typed it is untitled.
  const createFromQuery = useCallback(() => {
    const title = text.trim()
    const id = generateNoteId()
    createNote(id, title ? { title } : {})
    leave()
    navigate({ to: "/notes/$", params: { _splat: id }, search: { query: undefined } })
  }, [text, createNote, leave, navigate])

  // Commit the typed query to the full results view — the URL-addressable
  // `/?query=` the notes route already owns, so filter views are bookmarkable
  // and back/forward just work. The query as typed, not as last searched:
  // ↵ can land inside the debounce.
  const openResultsView = useCallback(() => {
    leave()
    navigate({ to: "/", search: { query: query.trim() } })
  }, [leave, navigate, query])
  /** ↵ in the query: with a query typed and no item highlighted, it is a
   * search, and the results view opens. With an item highlighted, ↵ is
   * cmdk's and picks the item. */
  const submit = useCallback(() => {
    const root = paletteRoot(inputRef.current)
    if (!query.trim() || !root || hasHighlightedItem(root)) return false
    openResultsView()
    return true
  }, [query, openResultsView])

  // Open a result: the note, or the note focused on the block.
  const openResult = useCallback(
    (noteId: string, blockId?: string) => {
      leave()
      navigate({
        to: "/notes/$",
        params: { _splat: noteId },
        search: { query: undefined, block: blockId },
      })
    },
    [leave, navigate],
  )

  // cmdk reports every change of the highlighted item here — both the user
  // arrowing (or pointing) and its own pick of the first item after the
  // list changes. cmdk's own pick is refused (see `highlightedValue`).
  const handleHighlightChange = useCallback((value: string) => {
    if (!interactingRef.current && value !== "") {
      setHighlightedValue(noHighlight())
      return
    }
    // Echo the value back — cmdk's selection is fully controlled, so
    // dropping this would freeze the highlight.
    setHighlightedValue(value)
  }, [])

  // The palette's input is the combobox for cmdk's list, as cmdk's own
  // input would be; the list's id is read once it is there.
  const [listId, setListId] = useState<string | undefined>()
  useEffect(() => {
    if (!isOpen) return
    setListId(paletteRoot(inputRef.current)?.querySelector("[cmdk-list]")?.id)
  }, [isOpen])

  return (
    <Command.Dialog
      label="Global command menu"
      open={isOpen}
      onOpenChange={(open) => {
        if (open) {
          openMenu()
        } else {
          closeMenu()
        }
      }}
      shouldFilter={false}
      value={highlightedValue}
      onValueChange={handleHighlightChange}
      onKeyDown={(event) => {
        // The results under the items are the block editor, browsed; ↓ in
        // the query hands it the keyboard (`handOff`), and from there its
        // keys are the editor's own: arrows, space, →/←, w/s/a/d, f, Enter
        // to open. ↑ from its first row hands the keyboard back
        // (`onExitTop`); so does Escape.
        if (
          event.key === "Escape" &&
          event.target instanceof Element &&
          event.target.closest("[data-block-editor]")
        ) {
          event.preventDefault()
          takeBackFromRows()
          return
        }
        // ⌘↵ creates a note from the query (the footer's action), wherever
        // the keyboard is.
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          createFromQuery()
          return
        }
        // Esc with a query clears it — filters and text; Esc again closes.
        if (event.key === "Escape" && query) {
          setQuery("")
          event.preventDefault()
        }
      }}
    >
      {/* The keys and the pointer that move cmdk's highlight are noted on
          their way in (capture), before cmdk's own handlers see them, so a
          highlight change that follows is known to be the reader's. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={bodyRef}
        className="relative"
        onKeyDownCapture={(event) => {
          if (NAVIGATION_KEYS.has(event.key) || event.ctrlKey) noteInteraction()
        }}
        onPointerMoveCapture={noteInteraction}
      >
        {/* The palette opens with no entrance (docs/design-principles.md). */}
        <Surface tier="modal" motion={false} className="overflow-hidden">
          <QueryBox
            variant="palette"
            inputRef={inputRef}
            popoverHost={bodyRef}
            placeholder="Search notes…"
            value={query}
            onChange={handleQueryChange}
            currentNoteId={noteId}
            onHandOff={handOff}
            onSubmit={submit}
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            aria-controls={listId}
          />

          <Command.List>
            {dateString ? (
              <Command.Group heading="Date">
                <CommandItem
                  key={dateString}
                  icon={<CalendarDateIcon16 date={new Date(dateString).getUTCDate()} />}
                  description={formatDateDistance(dateString)}
                  onSelect={handleSelect(() => {
                    navigate({
                      to: "/notes/$",
                      params: {
                        _splat: dateString,
                      },
                      search: {
                        query: undefined,
                      },
                    })
                  })}
                >
                  {formatDate(dateString)}
                </CommandItem>
              </Command.Group>
            ) : null}
            {deferredQuery || recentNotes.length > 0 ? (
              <Command.Group heading={deferredQuery ? "Results" : "Recent"}>
                {/* The results block — the count and the rows — as the
                    notes page draws it. ↓ past the last item hands the
                    keyboard to the rows; ↵ straight after typing commits
                    the query to the results view (`submit`). */}
                <ResultsList
                  variant="palette"
                  query={deferredQuery}
                  results={results}
                  browseRoots={recentRoots}
                  limit={NUM_VISIBLE_RESULTS}
                  readOnly
                  initialSelection="none"
                  onOpen={openResult}
                  focusFirstSignal={focusFirstSignal}
                  focusLastSignal={recentLastSignal}
                  onExitTop={takeBackFromRows}
                  onExitBottom={
                    !deferredQuery && pinnedRoots.length > 0 ? recentToPinned : undefined
                  }
                />
              </Command.Group>
            ) : null}
            {!deferredQuery && pinnedRoots.length > 0 ? (
              // The pinned notes and blocks, beneath the recent ones: a
              // second results block, browsed the same way, walked into
              // from the recent rows and back out of them (or, with
              // nothing recent, straight from the query).
              <Command.Group heading="Views">
                <ResultsList
                  variant="palette"
                  query=""
                  results={results}
                  browseRoots={pinnedRoots}
                  limit={NUM_VISIBLE_RESULTS}
                  readOnly
                  initialSelection="none"
                  onOpen={openResult}
                  focusFirstSignal={recentNotes.length > 0 ? pinnedFirstSignal : focusFirstSignal}
                  onExitTop={recentNotes.length > 0 ? pinnedToRecent : takeBackFromRows}
                />
              </Command.Group>
            ) : null}
          </Command.List>
          {/* The footer: always there, whatever the query. A button, not a
              cmdk item — the items are walked with ↑/↓ above the rows, and
              this one is reached by its key instead. */}
          <div className="border-t border-border-secondary p-2">
            <button
              type="button"
              data-testid="palette-create"
              onClick={createFromQuery}
              className="focus-ring flex h-9 w-full items-center gap-3 rounded px-3 text-left hover:bg-bg-hover active:bg-bg-secondary-active"
            >
              <span className="grid h-4 w-4 place-items-center text-text-secondary">
                <PlusIcon16 />
              </span>
              <span className="grow truncate">
                {text.trim() ? `Create new note "${text.trim()}"` : "Create new note"}
              </span>
              <Keys keys={formatCombo("Mod+Enter")} className="coarse:hidden" />
            </button>
          </div>
        </Surface>
      </div>
    </Command.Dialog>
  )
}

type CommandItemProps = {
  children: React.ReactNode
  value?: string
  icon?: React.ReactNode
  description?: string
  className?: string
  onSelect?: () => void
}

function CommandItem({
  children,
  value,
  icon,
  description,
  className,
  onSelect,
}: CommandItemProps) {
  return (
    <Command.Item value={value} onSelect={onSelect} className={className}>
      <div className="flex items-center gap-3">
        <div className="grid h-4 w-4 place-items-center text-text-secondary">{icon}</div>
        <div className="grow truncate">{children}</div>
        {description ? <span className="shrink-0 text-text-secondary">{description}</span> : null}
        <span className="hidden leading-none text-text-secondary in-aria-selected:inline">⏎</span>
      </div>
    </Command.Item>
  )
}
