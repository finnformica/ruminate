import { useMatch, useNavigate } from "@tanstack/react-router"
import { parseDate } from "chrono-node"
import { Command } from "cmdk"
import copy from "copy-to-clipboard"
import { atom, useAtom, useAtomValue, useSetAtom } from "jotai"
import { useCallback, useMemo, useRef, useState } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useDebounce } from "use-debounce"
import {
  blockRevealAtom,
  githubRepoAtom,
  noteOutlineAtom,
  notesAtom,
  pinnedNotesAtom,
  tagSearcherAtom,
} from "../global-state"
import { useNoteById, useSaveNote } from "../hooks/note"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS } from "../shortcuts/registry"
import { copyAsMarkdown } from "../utils/copy-markdown"
import { useSearchNotes } from "../hooks/search-notes"
import { Note } from "../schema"
import { formatDate, formatDateDistance, toDateString } from "../utils/date"
import { getHeadings } from "../utils/headings"
import { generateNoteId, toNoteId } from "../utils/note-id"
import { filterOutline } from "../utils/note-outline"
import { pluralize } from "../utils/pluralize"
import {
  CalendarDateIcon16,
  CopyIcon16,
  ExternalLinkIcon16,
  GlobeIcon16,
  NoteIcon16,
  PinFillIcon12,
  PlusIcon16,
  PrinterIcon16,
  SearchIcon16,
  SettingsIcon16,
  TagIcon16,
} from "./icons"
import { NoteFavicon } from "./note-favicon"

export const isCommandMenuOpenAtom = atom(false)

/**
 * "commands" is the normal ⌘K palette; "outline" (⌘P, or "@" typed as the
 * query's first character — the VS Code prefix grammar) lists the open note's
 * headings for fast in-note navigation.
 */
type PaletteMode = "commands" | "outline"

export function CommandMenu() {
  const navigate = useNavigate()
  const githubRepo = useAtomValue(githubRepoAtom)
  const searchNotes = useSearchNotes()
  const tagSearcher = useAtomValue(tagSearcherAtom)
  const saveNote = useSaveNote()
  const notes = useAtomValue(notesAtom)
  const pinnedNotes = useAtomValue(pinnedNotesAtom)
  const [isOpen, setIsOpen] = useAtom(isCommandMenuOpenAtom)

  // Get the current note if we're on a note page.
  // This is used to show note actions in the command menu.
  const noteMatch = useMatch({ from: "/_appRoot/notes_/$", shouldThrow: false })
  const noteId = noteMatch?.params._splat
  const note = useNoteById(noteId)

  // Refs
  const prevActiveElement = useRef<HTMLElement>()

  // Local state
  const [query, setQuery] = useState("")
  const [deferredQuery] = useDebounce(query, 150)
  const [mode, setMode] = useState<PaletteMode>("commands")
  // The cmdk-highlighted item's value, controlled: cmdk only reports highlight
  // changes (the outline preview trigger) through onValueChange when `value`
  // is a controlled prop.
  const [highlightedValue, setHighlightedValue] = useState("")

  // How outline mode was entered: via the "@" prefix (Backspace on an empty
  // query returns to the commands palette it came from) or via ⌘P (Backspace
  // on empty stays put — there is no ⌘K state to go "back" to).
  const outlineEntryRef = useRef<"prefix" | "hotkey">("hotkey")
  // cmdk auto-highlights the first item whenever the outline list (re)appears;
  // that initial event isn't the user arrowing, so it must not scroll the doc.
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
        | { type: "preview"; id: string }
        | { type: "commit"; id: string }
        | { type: "cancel" },
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
    // Drop the previous highlight so cmdk re-selects the first heading (and
    // reports it — which the skip flag above then swallows).
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

  // Open a note, optionally highlighting one of its headings on landing.
  const openNote = useCallback(
    (id: string, heading?: string) => {
      setIsOpen(false)
      setQuery("")
      navigate({
        to: "/notes/$",
        params: { _splat: id },
        search: { query: undefined, heading },
      })
    },
    [setIsOpen, navigate],
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
  // stripped from the query (like VS Code's Go to Symbol).
  const handleQueryChange = useCallback(
    (value: string) => {
      if (mode === "commands" && query === "" && value.startsWith("@")) {
        enterOutlineMode("prefix")
        setQuery(value.slice(1))
        return
      }
      setQuery(value)
    },
    [mode, query, enterOutlineMode],
  )

  const navItems = useMemo(() => {
    return [
      {
        label: "Notes",
        icon: <NoteIcon16 />,
        onSelect: () => {
          navigate({
            to: "/",
            search: {
              query: undefined,
            },
          })
        },
      },
      {
        label: "Calendar",
        icon: <CalendarDateIcon16 date={new Date().getDate()} />,
        onSelect: () => {
          navigate({
            to: "/notes/$",
            params: {
              _splat: toDateString(new Date()),
            },
            search: {
              query: undefined,
            },
          })
        },
      },
      {
        label: "Tags",
        icon: <TagIcon16 />,
        onSelect: () => {
          navigate({
            to: "/tags",
            search: {
              query: undefined,
              sort: "name",
            },
          })
        },
      },
      {
        label: "Settings",
        icon: <SettingsIcon16 />,
        onSelect: () => {
          navigate({
            to: "/settings",
          })
        },
      },
    ]
  }, [navigate])

  const filteredNavItems = useMemo(() => {
    return navItems.filter((item) => {
      return item.label.toLowerCase().includes(deferredQuery.toLowerCase())
    })
  }, [navItems, deferredQuery])

  const noteActions = useMemo(() => {
    if (!note) return []
    return [
      {
        label: "Copy note markdown",
        icon: <CopyIcon16 />,
        onSelect: () => {
          copyAsMarkdown(note.content)
        },
      },
      {
        label: "Copy note ID",
        icon: <CopyIcon16 />,
        onSelect: () => {
          copy(note.id)
        },
      },
      {
        label: "Open in GitHub",
        icon: <ExternalLinkIcon16 />,
        onSelect: () => {
          if (!githubRepo) return
          const url = `https://github.com/${githubRepo.owner}/${githubRepo.name}/blob/main/${note.id}.md`
          window.open(url, "_blank")
        },
      },
      {
        label: "Print note",
        icon: <PrinterIcon16 />,
        onSelect: () => {
          window.print()
        },
      },
    ]
  }, [note, githubRepo])

  const filteredNoteActions = useMemo(() => {
    return noteActions.filter((item) => {
      return item.label.toLowerCase().includes(deferredQuery.toLowerCase())
    })
  }, [noteActions, deferredQuery])

  // Check if query can be parsed as a date
  const dateString = useMemo(() => {
    const date = parseDate(deferredQuery)
    if (!date) return ""
    return toDateString(date)
  }, [deferredQuery])

  // Search tags
  const tagResults = useMemo(() => {
    return tagSearcher.search(deferredQuery)
  }, [tagSearcher, deferredQuery])

  // Search notes
  const noteResults = useMemo(() => {
    return searchNotes(deferredQuery)
  }, [searchNotes, deferredQuery])

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
  // arrowing and its own auto-select of the first item after a list change.
  // In outline mode that's the live preview: highlight + scroll the block
  // behind the dialog. The auto-select right after entering the mode is
  // skipped so merely opening ⌘P doesn't scroll the note.
  const handleHighlightChange = useCallback(
    (value: string) => {
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

  // Only show the first 2 tags
  const numVisibleTags = 2

  // Only show the first 6 notes
  const numVisibleNotes = 6

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
        // Clear input with `esc`
        if (event.key === "Escape" && query) {
          setQuery("")
          event.preventDefault()
        }
      }}
    >
      <div className="card-3 overflow-hidden rounded-xl!">
        <Command.Input
          placeholder={mode === "outline" ? "Jump to a heading…" : "Search or jump to…"}
          value={query}
          onValueChange={handleQueryChange}
          autoCapitalize="off"
        />

        <Command.List>
          {mode === "outline" ? (
            !noteId ? (
              <div className="px-3 py-2 text-text-secondary">No note open</div>
            ) : outlineResults.length === 0 ? (
              <div className="px-3 py-2 text-text-secondary">
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
                    // 12px matches the item's own px-3; 24px per level matches
                    // the pl-9 indent of the note-search heading sub-items.
                    style={
                      deferredQuery.trim()
                        ? undefined
                        : { paddingLeft: 12 + Math.min(item.depth, 4) * 24 }
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
              {filteredNoteActions.length > 0 ? (
                <Command.Group heading="Note actions">
                  {filteredNoteActions.map((action) => (
                    <CommandItem
                      key={action.label}
                      icon={action.icon}
                      onSelect={handleSelect(action.onSelect)}
                    >
                      {action.label}
                    </CommandItem>
                  ))}
                </Command.Group>
              ) : null}
              {filteredNavItems.length ? (
                <Command.Group heading="Jump to">
                  {filteredNavItems.map((item) => (
                    <CommandItem
                      key={item.label}
                      icon={item.icon}
                      onSelect={handleSelect(item.onSelect)}
                    >
                      {item.label}
                    </CommandItem>
                  ))}
                </Command.Group>
              ) : null}
              {!deferredQuery && pinnedNotes.length ? (
                <Command.Group heading="Pinned notes">
                  {pinnedNotes.map((note) => (
                    <NoteItem
                      key={note.id}
                      note={note}
                      // Since they're all pinned, we don't need to show the pin icon
                      hidePinIcon
                      onOpen={(heading) => openNote(note.id, heading)}
                    />
                  ))}
                </Command.Group>
              ) : null}
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
              {tagResults.length ? (
                <Command.Group heading="Tags">
                  {tagResults.slice(0, numVisibleTags).map(([name, noteIds]) => (
                    <CommandItem
                      key={name}
                      icon={<TagIcon16 />}
                      description={pluralize(noteIds.length, "note")}
                      onSelect={handleSelect(() =>
                        navigate({
                          to: "/",
                          search: { query: `tag:${name}` },
                        }),
                      )}
                    >
                      {name}
                    </CommandItem>
                  ))}
                  {tagResults.length > numVisibleTags ? (
                    <CommandItem
                      key={`Show all tags matching "${deferredQuery}"`}
                      icon={<SearchIcon16 />}
                      onSelect={handleSelect(() =>
                        navigate({
                          to: "/tags",
                          search: {
                            query: deferredQuery,
                            sort: "name",
                          },
                        }),
                      )}
                    >
                      Show all {pluralize(tagResults.length, "tag")} matching "{deferredQuery}"
                    </CommandItem>
                  ) : null}
                </Command.Group>
              ) : null}
              {deferredQuery ? (
                <Command.Group heading="Notes">
                  {noteResults.slice(0, numVisibleNotes).map((note) => (
                    <NoteItem
                      key={note.id}
                      note={note}
                      onOpen={(heading) => openNote(note.id, heading)}
                    />
                  ))}
                  {noteResults.length > 0 ? (
                    <CommandItem
                      key={`Show all notes matching "${deferredQuery}"`}
                      icon={<SearchIcon16 />}
                      onSelect={handleSelect(() =>
                        navigate({
                          to: "/",
                          search: {
                            query: deferredQuery,
                          },
                        }),
                      )}
                    >
                      Show all {pluralize(noteResults.length, "note")} matching "{deferredQuery}"
                    </CommandItem>
                  ) : null}
                  <CommandItem
                    key={`Create new note "${deferredQuery}"`}
                    icon={<PlusIcon16 />}
                    onSelect={handleSelect(() => {
                      // The typed text becomes the note's name (its filename), not
                      // the first line of content. Fall back to a generated id if
                      // the text has no filename-safe characters.
                      const id = toNoteId(deferredQuery) || generateNoteId()

                      // If a note with that name already exists, open it rather
                      // than overwriting it with an empty note.
                      if (!notes.has(id)) {
                        saveNote({ id, content: "" })
                      }

                      navigate({
                        to: "/notes/$",
                        params: {
                          _splat: id,
                        },
                        search: {
                          query: undefined,
                        },
                      })
                    })}
                  >
                    Create new note "{deferredQuery}"
                  </CommandItem>
                </Command.Group>
              ) : null}
            </>
          )}
        </Command.List>
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
  style?: React.CSSProperties
  onSelect?: () => void
}

function CommandItem({
  children,
  value,
  icon,
  description,
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
        <span className="hidden leading-none text-text-secondary in-aria-selected:inline epaper:in-aria-selected:text-bg">
          ⏎
        </span>
      </div>
    </Command.Item>
  )
}

// How many of a note's headings to list beneath it.
const NUM_VISIBLE_HEADINGS = 4

function NoteItem({
  note,
  hidePinIcon,
  onOpen,
}: {
  note: Note
  hidePinIcon?: boolean
  onOpen: (heading?: string) => void
}) {
  // Show the note by its filename, with its headings listed (tabbed over) as
  // children so you can find a note by a heading it contains. Selecting the
  // note opens it; selecting a heading opens it and highlights that heading.
  const headings = getHeadings(note.content).slice(0, NUM_VISIBLE_HEADINGS)
  return (
    <>
      <CommandItem value={note.id} icon={<NoteFavicon note={note} />} onSelect={() => onOpen()}>
        <span className="flex items-center gap-2 truncate">
          {!hidePinIcon && note.pinned ? (
            <PinFillIcon12 className="shrink-0 text-text-pinned" />
          ) : null}
          {note?.frontmatter?.gist_id ? (
            <GlobeIcon16 className="shrink-0 text-border-focus" />
          ) : null}
          <span className="truncate">{note.id}</span>
        </span>
      </CommandItem>
      {headings.map((heading, index) => (
        <CommandItem
          key={`${note.id}::${index}`}
          value={`${note.id} › ${heading.text}`}
          className="pl-9!"
          icon={<span className="text-text-tertiary">#</span>}
          onSelect={() => onOpen(heading.text)}
        >
          <span className="truncate text-text-secondary">{heading.text}</span>
        </CommandItem>
      ))}
    </>
  )
}
