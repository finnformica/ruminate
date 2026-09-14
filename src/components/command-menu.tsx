import { useMatch, useNavigate } from "@tanstack/react-router"
import { parseDate } from "chrono-node"
import { Command } from "cmdk"
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useDebounce } from "use-debounce"
import {
  blockRevealAtom,
  noteOutlineAtom,
  pinnedNotesAtom,
  recentTouchesAtom,
  sortedNotesAtom,
} from "../global-state"
import { recentNotes as recentTouched } from "../utils/recent-notes"
import { useCreateNote } from "../hooks/note"
import { useSearchResults } from "../hooks/search-results"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS, formatCombo } from "../shortcuts/registry"
import { formatDate, formatDateDistance, toDateString } from "../utils/date"
import { generateNoteId } from "../utils/note-id"
import { filterOutline } from "../utils/note-outline"
import { parseQuery } from "../utils/search"
import { CalendarDateIcon16, PlusIcon16 } from "./icons"
import { Keys } from "./keys"
import { QUERY_DEBOUNCE_MS } from "./note-list"
import { QueryBox } from "./query-box"
import { ResultsList } from "./results-list"

export const isCommandMenuOpenAtom = atom(false)

/**
 * "commands" is the normal ⌘K palette; "outline" (⌘P, or "@" typed as the
 * query's first character — the VS Code prefix grammar) lists the open note's
 * headings for fast in-note navigation.
 */
type PaletteMode = "commands" | "outline"

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

export function CommandMenu() {
  const navigate = useNavigate()
  const createNote = useCreateNote()
  // With nothing typed: the notes most recently TOUCHED — edited or created
  // (the graph's `updatedAt`) merged with what was opened, edited or folded
  // on this device (`recentTouchesAtom`) — at most five; then the pinned
  // notes beneath, less any already listed as recent, so nothing is there
  // twice.
  const sortedNotes = useAtomValue(sortedNotesAtom)
  const touches = useAtomValue(recentTouchesAtom)
  const recentNotes = useMemo(() => recentTouched(touches, sortedNotes), [touches, sortedNotes])
  const pinned = useAtomValue(pinnedNotesAtom)
  const pinnedNotes = useMemo(
    () => pinned.filter((note) => !recentNotes.some((recent) => recent.id === note.id)),
    [pinned, recentNotes],
  )
  const [isOpen, setIsOpen] = useAtom(isCommandMenuOpenAtom)

  // The open note, if any: the palette's default `in:` scope, and whose
  // outline ⌘P lists.
  const noteMatch = useMatch({ from: "/_appRoot/notes_/$", shouldThrow: false })
  const noteId = noteMatch?.params._splat
  // The block the note is zoomed into, if any — the view's scope is then that
  // subtree, not the whole note.
  const zoomBlockId = noteMatch?.search?.block

  // Refs
  const prevActiveElement = useRef<HTMLElement>()
  const inputRef = useRef<HTMLInputElement>(null)
  // The popover's host: the dialog's body, outside the card that clips its
  // corners, so the qualifier popover can hang over the list.
  const bodyRef = useRef<HTMLDivElement>(null)

  // Local state
  const [query, setQuery] = useState("")
  const [deferredQuery] = useDebounce(query, QUERY_DEBOUNCE_MS)
  const [mode, setMode] = useState<PaletteMode>("commands")
  // Inside a note the palette searches THAT note by default — its blocks,
  // or the zoomed subtree — as an `in:` scope the reader can take off (the
  // pill under the input) or override by typing their own `in:`. Comes back
  // on each open: a fresh palette is a fresh view.
  const [scopeRemoved, setScopeRemoved] = useState(false)

  // The cmdk-highlighted item's value, controlled: cmdk only reports highlight
  // changes (the outline preview trigger) through onValueChange when `value`
  // is a controlled prop. In the commands palette nothing is highlighted
  // until the reader arrows or points at an item: the query is a search,
  // and ↵ commits it (`submit`) rather than picking whatever item happened
  // to be first. cmdk itself highlights the first item whenever its items
  // change (a keystroke filters them); such a pick arrives here with no
  // interaction behind it (`interactingRef`) and is refused — by handing
  // cmdk a value no item has, fresh each time so it takes it up.
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

  // How outline mode was entered: via the "@" prefix (Backspace on an empty
  // query returns to the commands palette it came from) or via ⌘P (Backspace
  // on empty stays put — there is no ⌘K state to go "back" to).
  const outlineEntryRef = useRef<"prefix" | "hotkey">("hotkey")
  // The first heading is highlighted whenever the outline list (re)appears;
  // that initial highlight isn't the user arrowing, so it must not scroll
  // the doc.
  const skipAutoPreviewRef = useRef(false)
  // Whether any preview was sent since outline mode was entered — i.e. the
  // editor holds a restore snapshot that a close-without-commit must release.
  const previewedRef = useRef(false)
  const revealNonceRef = useRef(0)
  const setBlockReveal = useSetAtom(blockRevealAtom)
  const outline = useAtomValue(noteOutlineAtom)

  const sendReveal = useCallback(
    (
      message:
        { type: "preview"; id: string } | { type: "commit"; id: string } | { type: "cancel" },
    ) => {
      setBlockReveal({ ...message, nonce: ++revealNonceRef.current })
    },
    [setBlockReveal],
  )

  // Restore the editor (selection + scroll) if any preview moved it.
  const cancelPreview = useCallback(() => {
    if (!previewedRef.current) return
    previewedRef.current = false
    sendReveal({ type: "cancel" })
  }, [sendReveal])

  const enterOutlineMode = useCallback((entry: "prefix" | "hotkey") => {
    outlineEntryRef.current = entry
    skipAutoPreviewRef.current = true
    setMode("outline")
    // Drop the previous highlight so the first heading is highlighted afresh
    // (and reported — which the skip flag above then swallows).
    setHighlightedValue("")
  }, [])

  const openMenu = useCallback(
    (menuMode: PaletteMode = "commands") => {
      prevActiveElement.current = document.activeElement as HTMLElement
      if (menuMode === "outline") {
        setQuery("")
        enterOutlineMode("hotkey")
      } else {
        setMode("commands")
        setHighlightedValue("")
      }
      setScopeRemoved(false)
      setIsOpen(true)
    },
    [setIsOpen, enterOutlineMode],
  )

  const closeMenu = useCallback(() => {
    cancelPreview()
    setMode("commands")
    setIsOpen(false)
    setTimeout(() => {
      prevActiveElement.current?.focus()
    })
  }, [setIsOpen, cancelPreview])

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
        setIsOpen(false)
        setQuery("")
        // The dialog can also be opened by a direct atom write (the nav bar's
        // search button), which bypasses openMenu — never leave outline mode
        // behind for that path to land in.
        setMode("commands")
        callback()
      }
    },
    [setIsOpen],
  )

  useHotkeys(APP_SHORTCUTS.commandMenu, toggleMenu, GLOBAL_HOTKEY_OPTIONS)

  // ⌘P opens the palette straight into outline mode (headings of the open
  // note). Pressed again while already in outline mode, it closes — the same
  // toggle feel as ⌘K; pressed while the commands palette is open, it switches
  // the open dialog into outline mode.
  useHotkeys(
    APP_SHORTCUTS.outlinePalette,
    () => {
      if (isOpen && mode === "outline") {
        closeMenu()
      } else if (isOpen) {
        setQuery("")
        enterOutlineMode("hotkey")
      } else {
        openMenu("outline")
      }
    },
    GLOBAL_HOTKEY_OPTIONS,
  )

  // The query change handler owns the "@" prefix grammar: typed as the first
  // character of the commands palette, it switches to outline mode and is
  // stripped from the query (like VS Code's Go to Symbol). Typing also takes
  // the highlight off whatever item had it: a fresh query is a search.
  const handleQueryChange = useCallback(
    (value: string) => {
      setHighlightedValue("")
      if (mode === "commands" && query === "" && value.startsWith("@")) {
        enterOutlineMode("prefix")
        setQuery(value.slice(1))
        return
      }
      setQuery(value)
    },
    [mode, query, enterOutlineMode],
  )

  // Check if query can be parsed as a date
  const dateString = useMemo(() => {
    const date = parseDate(deferredQuery)
    if (!date) return ""
    return toDateString(date)
  }, [deferredQuery])

  // The scope in force for a query: the zoomed block, else the open note —
  // unless the reader took it off or wrote an `in:` of their own.
  const scopeFor = useCallback(
    (q: string) =>
      noteId &&
      mode === "commands" &&
      !scopeRemoved &&
      !parseQuery(q).filters.some((filter) => filter.key === "in")
        ? (zoomBlockId ?? noteId)
        : null,
    [noteId, mode, scopeRemoved, zoomBlockId],
  )
  // What the block search (and the results view) actually run: the scope is
  // spelled out as a qualifier, so the URL the palette hands off to says it.
  // With nothing typed there is nothing to scope — the palette browses.
  const withScope = useCallback(
    (q: string) => {
      const typed = q.trim()
      if (!typed) return ""
      const scope = scopeFor(typed)
      return scope ? `in:${scope} ${typed}` : typed
    },
    [scopeFor],
  )
  const scope = deferredQuery ? scopeFor(deferredQuery) : null
  const scopedQuery = withScope(deferredQuery)

  // Search BLOCKS — the palette's primary results. A nested heading or a todo
  // is a first-class row here, not a note it happens to live in; a note
  // whose title matched is a row among them, by score.
  const results = useSearchResults(scopedQuery)
  const hasRows = deferredQuery
    ? results.rows.length > 0
    : recentNotes.length > 0 || pinnedNotes.length > 0

  // The keyboard's way through the rows. With nothing typed there are two
  // lists, Recent and then Pinned, walked as one: ↓ from the query lands on
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
    if (mode !== "commands" || !root || !hasRows || !highlightIsLastItem(root)) return false
    setFocusFirstSignal((n) => n + 1)
    return true
  }, [mode, hasRows])
  /** Take the keyboard back from the rows: the query has focus again, with
   * cmdk's highlight on the last item — the one ↓ left from. */
  const takeBackFromRows = useCallback(() => {
    inputRef.current?.focus()
    const items = paletteRoot(inputRef.current)?.querySelectorAll("[cmdk-item]") ?? []
    const last = items[items.length - 1]
    setHighlightedValue(last?.getAttribute("data-value") ?? "")
  }, [])

  // Create a note from the query — the palette's footer, and ⌘↵. The typed
  // text becomes the note's TITLE; the id is minted and opaque
  // (docs/graph-storage.md). Any text works — there is no filename charset
  // to sanitize against and no name collision to avoid, so a fresh note is
  // always a fresh note; with nothing typed it is untitled.
  const createFromQuery = useCallback(() => {
    const title = query.trim()
    const id = generateNoteId()
    createNote(id, title ? { title } : {})
    setIsOpen(false)
    setQuery("")
    setMode("commands")
    navigate({ to: "/notes/$", params: { _splat: id }, search: { query: undefined } })
  }, [query, createNote, setIsOpen, navigate])

  // Commit the typed query to the full results view — the URL-addressable
  // `/?query=` the notes route already owns, so filter views are bookmarkable
  // and back/forward just work. The query as typed, not as last searched:
  // ↵ can land inside the debounce.
  const openResultsView = useCallback(() => {
    setIsOpen(false)
    setQuery("")
    setMode("commands")
    navigate({ to: "/", search: { query: withScope(query) } })
  }, [setIsOpen, navigate, withScope, query])
  /** ↵ in the query: with a query typed and no item highlighted, it is a
   * search, and the results view opens. With an item highlighted, ↵ is
   * cmdk's and picks the item. */
  const submit = useCallback(() => {
    const root = paletteRoot(inputRef.current)
    if (mode !== "commands" || !query.trim() || !root || hasHighlightedItem(root)) return false
    openResultsView()
    return true
  }, [mode, query, openResultsView])

  // Open a result: the note, or the note zoomed to the block.
  const openResult = useCallback(
    (noteId: string, blockId?: string) => {
      setIsOpen(false)
      setQuery("")
      setMode("commands")
      navigate({
        to: "/notes/$",
        params: { _splat: noteId },
        search: { query: undefined, block: blockId },
      })
    },
    [setIsOpen, navigate],
  )

  // The current note's live outline, published by the block editor. Guarded by
  // note id so a stale outline (e.g. mid-navigation) never lists another
  // note's headings.
  const outlineItems = useMemo(
    () => (noteId && outline?.noteId === noteId ? outline.items : []),
    [noteId, outline],
  )
  // Unfiltered: every heading in document order (rendered with depth indents).
  // Filtered: a flat fuzzy-ranked list matching heading text and ancestor path.
  const outlineResults = useMemo(
    () => (mode === "outline" ? filterOutline(outlineItems, deferredQuery) : []),
    [mode, outlineItems, deferredQuery],
  )
  // cmdk lowercases item values, so highlight events map back to block ids
  // through a lowercased key (ids are lowercase anyway — belt and braces).
  const outlineValueToId = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of outlineResults) map.set(`outline:${item.id}`.toLowerCase(), item.id)
    return map
  }, [outlineResults])

  // cmdk reports every change of the highlighted item here — both the user
  // arrowing (or pointing) and its own pick of the first item after the
  // list changes. In outline mode that's the live preview: highlight +
  // scroll the block behind the dialog; the pick right after entering the
  // mode is skipped so merely opening ⌘P doesn't scroll the note. In the
  // commands palette cmdk's own pick is refused (see `highlightedValue`).
  const handleHighlightChange = useCallback(
    (value: string) => {
      if (mode !== "outline" && !interactingRef.current && value !== "") {
        setHighlightedValue(noHighlight())
        return
      }
      // Echo the value back — cmdk's selection is fully controlled, so
      // dropping this would freeze the highlight.
      setHighlightedValue(value)
      if (mode !== "outline") return
      const id = outlineValueToId.get(value.toLowerCase())
      if (!id) return
      if (skipAutoPreviewRef.current) {
        skipAutoPreviewRef.current = false
        return
      }
      previewedRef.current = true
      sendReveal({ type: "preview", id })
    },
    [mode, outlineValueToId, sendReveal],
  )

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
        // Backspace on an empty outline query returns to the commands palette
        // — only when outline mode was entered from it via "@" (⌘P has no ⌘K
        // state to go back to, so it stays put).
        if (
          mode === "outline" &&
          event.key === "Backspace" &&
          query === "" &&
          outlineEntryRef.current === "prefix"
        ) {
          cancelPreview()
          setMode("commands")
          event.preventDefault()
          return
        }
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
        if (mode === "commands" && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          createFromQuery()
          return
        }
        // Clear input with `esc`
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
        <div className="card-3 overflow-hidden rounded-xl!">
          <QueryBox
            variant="palette"
            inputRef={inputRef}
            popoverHost={bodyRef}
            placeholder={mode === "outline" ? "Jump to a heading…" : "Search or jump to…"}
            value={query}
            onChange={handleQueryChange}
            currentNoteId={noteId}
            impliedScope={
              scope && deferredQuery
                ? { value: scope, onRemove: () => setScopeRemoved(true) }
                : null
            }
            onHandOff={handOff}
            onSubmit={submit}
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            aria-controls={listId}
          />

          <Command.List>
            {mode === "outline" ? (
              !noteId ? (
                <div className="px-1.5 py-2 text-text-secondary">No note open</div>
              ) : outlineResults.length === 0 ? (
                <div className="px-1.5 py-2 text-text-secondary">
                  {outlineItems.length === 0
                    ? "No headings in this note"
                    : `No headings matching "${deferredQuery}"`}
                </div>
              ) : (
                <Command.Group heading="Headings">
                  {outlineResults.map((item) => (
                    <CommandItem
                      key={item.id}
                      value={`outline:${item.id}`}
                      icon={<span className="text-text-tertiary">#</span>}
                      // While filtering, the list is flat and ranked — structure
                      // is conveyed by the ancestor path instead of indents.
                      description={
                        deferredQuery.trim() ? item.path.join(" › ") || undefined : undefined
                      }
                      // Indent by heading depth (visually capped at 4 levels).
                      // 6px matches the item's own px-1.5; 24px per level
                      // matches the pl-9 indent of the note-search heading
                      // sub-items.
                      style={
                        deferredQuery.trim()
                          ? undefined
                          : { paddingLeft: 6 + Math.min(item.depth, 4) * 24 }
                      }
                      onSelect={handleSelect(() => {
                        previewedRef.current = false
                        sendReveal({ type: "commit", id: item.id })
                      })}
                    >
                      {item.text}
                    </CommandItem>
                  ))}
                </Command.Group>
              )
            ) : (
              <>
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
                      query={scopedQuery}
                      results={results}
                      browseNotes={recentNotes}
                      limit={NUM_VISIBLE_RESULTS}
                      readOnly
                      initialSelection="none"
                      onOpen={openResult}
                      focusFirstSignal={focusFirstSignal}
                      focusLastSignal={recentLastSignal}
                      onExitTop={takeBackFromRows}
                      onExitBottom={
                        !deferredQuery && pinnedNotes.length > 0 ? recentToPinned : undefined
                      }
                    />
                  </Command.Group>
                ) : null}
                {!deferredQuery && pinnedNotes.length > 0 ? (
                  // The pinned notes, beneath the recent ones: a second
                  // results block, browsed the same way, walked into from
                  // the recent rows and back out of them (or, with nothing
                  // recent, straight from the query).
                  <Command.Group heading="Pinned">
                    <ResultsList
                      variant="palette"
                      query=""
                      results={results}
                      browseNotes={pinnedNotes}
                      limit={NUM_VISIBLE_RESULTS}
                      readOnly
                      initialSelection="none"
                      onOpen={openResult}
                      focusFirstSignal={
                        recentNotes.length > 0 ? pinnedFirstSignal : focusFirstSignal
                      }
                      onExitTop={recentNotes.length > 0 ? pinnedToRecent : takeBackFromRows}
                    />
                  </Command.Group>
                ) : null}
              </>
            )}
          </Command.List>
          {mode === "commands" ? (
            // The footer: always there, whatever the query. A button, not a
            // cmdk item — the items are walked with ↑/↓ above the rows, and
            // this one is reached by its key instead.
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
                  {query.trim() ? `Create new note "${query.trim()}"` : "Create new note"}
                </span>
                <Keys keys={formatCombo("Mod+Enter")} className="coarse:hidden" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </Command.Dialog>
  )
}

type CommandItemProps = {
  children: React.ReactNode
  value?: string
  icon?: React.ReactNode
  description?: string
  /** The keys that run this command outside the palette (`formatCombo`). */
  shortcut?: string[]
  className?: string
  style?: React.CSSProperties
  onSelect?: () => void
}

function CommandItem({
  children,
  value,
  icon,
  description,
  shortcut,
  className,
  style,
  onSelect,
}: CommandItemProps) {
  return (
    <Command.Item value={value} onSelect={onSelect} className={className} style={style}>
      <div className="flex items-center gap-3">
        <div className="grid h-4 w-4 place-items-center text-text-secondary">{icon}</div>
        <div className="grow truncate">{children}</div>
        {description ? <span className="shrink-0 text-text-secondary">{description}</span> : null}
        {shortcut ? (
          <span className="shrink-0 coarse:hidden">
            <Keys keys={shortcut} chord />
          </span>
        ) : null}
        <span className="hidden leading-none text-text-secondary in-aria-selected:inline">⏎</span>
      </div>
    </Command.Item>
  )
}
