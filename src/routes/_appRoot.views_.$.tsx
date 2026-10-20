import { Link, createFileRoute } from "@tanstack/react-router"
import { useAtomValue, useSetAtom, useStore } from "jotai"
import React, { useEffect, useState } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useMedia } from "react-use"
import useResizeObserver from "use-resize-observer"
import {
  LoadingIcon16,
  NoteIcon16,
  OfflineIcon16,
  ShareIcon16,
  SplitIcon16,
  XIcon16,
} from "../components/icons"
import { FocusTrail } from "../components/focus-trail"
import { IconButton } from "../components/ui/icon-button"
import { Notice } from "../components/notice"
import { parse } from "../blocks/parse"
import type { BlockDoc, ChangeHint } from "../blocks/types"
import { BlockNoteEditor } from "../components/block-editor/block-note-editor"
import { NoteTitle } from "../components/block-editor/note-title"
import { NoteActionsMenu } from "../components/note-actions-menu"
import { UnassignedBasket } from "../components/unassigned-basket"
import { NoteFavicon } from "../components/note-favicon"
import { PageLayout } from "../components/page-layout"
import { saveTrace, useSaveTraceState, useSteadySaveTrace } from "../components/sync-status"
import { databaseModeStatusAtom } from "../data/database-mode"
import { sharedModeStatusAtom } from "../data/shared-mode"
import { requestDatabaseFlush } from "../data/database-mode"
import {
  graphSnapshotAtom,
  isDatabaseModeAtom,
  isSignedOutAtom,
  linkDirectionsAtom,
  otherPaneAtom,
} from "../global-state"
import { useCreateNote, useNoteById, useRenameNote, useSetNoteProps } from "../hooks/note"
import { useSavedView, useWriteView } from "../hooks/views"
import { useTouchNote } from "../hooks/touch-note"
import { useNoteDoc } from "../hooks/note-doc"
import { useOpenNote } from "../hooks/open-note"
import { pathToBlock } from "../data/graph"
import { narrowingParam, resolveNarrowing } from "../utils/view-filter"
import { FilterMenu, SortMenu } from "../components/view-controls"
import { foldKeyOf, openFolds, useFoldRule, type Folds } from "../data/view-state"
import { keyOf } from "../blocks/view"
import { useNoteShare } from "../hooks/share"
import { shareOwnerName } from "../data/shares"
import {
  activate,
  closePane,
  currentFrame,
  goTo,
  goVia,
  layoutFromSearch,
  layoutToSearch,
  nextPaneIndex,
  openBeside,
  popFrame,
  popTo,
  keyOfPath,
  pathOfKey,
  withCurrent,
  withPane,
  type FocusFrame,
  type FocusMove,
  type FrameFolds,
  type Pane,
  type PaneLayout,
  type SelectionPath,
  type ViewTarget,
} from "../data/panes"
import { Width, fontSchema, widthSchema } from "../schema"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS, formatCombo } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { isValidDateString, isValidWeekString } from "../utils/date"

/** What a note or block saved as its default view (docs/metadata.md), and
 * whether this session may write one. */
type RouteSearch = {
  query: string | undefined
  /** Block id the editor is focused on; absent = outside focus. */
  block?: string
  /** The folds of a frame pushed onto the first pane's stack, as what the
   * reader changed over the standing rule (docs/split-view.md). */
  folds?: string
  /**
   * The view's filter, in the query language (`type:todo`): the rows that
   * match stay, their ancestors are kept as dimmed context and everything
   * else goes (`src/data/filter-view.ts`). Absent = every row.
   */
  filter?: string
  /** How each parent's children are ordered (`text`, `text:desc`), the
   * nesting untouched. Absent = the note's own order. */
  sort?: string
  /** The first pane's focus stack beneath the view on screen, and each
   * other pane's whole stack (`src/data/panes.ts`, docs/split-view.md). */
  stack?: string
  pane1?: string
  /** The pane with the keyboard, when it is not the first. */
  active?: number
}

export const Route = createFileRoute("/_appRoot/views_/$")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => {
    return {
      query: typeof search.query === "string" ? search.query : undefined,
      block: typeof search.block === "string" ? search.block : undefined,
      filter: typeof search.filter === "string" ? search.filter : undefined,
      sort: typeof search.sort === "string" ? search.sort : undefined,
      folds: typeof search.folds === "string" ? search.folds : undefined,
      stack: typeof search.stack === "string" ? search.stack : undefined,
      pane1: typeof search.pane1 === "string" ? search.pane1 : undefined,
      active: Number.isInteger(Number(search.active)) ? Number(search.active) : undefined,
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  const isSignedOut = useAtomValue(isSignedOutAtom)
  // Signed in, the store serves notes immediately; signed out, the sample
  // notes render. Only the brief auth resolution at boot is gated.
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)

  if (isSignedOut || isDatabaseMode) {
    return <SplitView />
  }

  return (
    <PageLayout title="Note" icon={<NoteIcon16 />}>
      <div>{/* TODO */}</div>
    </PageLayout>
  )
}

/** Two panes need the room of a wide screen; narrower (a phone,
 * docs/mobile.md) only the pane with the keyboard shows. */
const SPLIT_QUERY = "(min-width: 1024px)"

/**
 * The page's panes (docs/split-view.md): the layout read out of the URL
 * (`layoutFromSearch`), one `NotePage` per pane on screen, and every change
 * — a focus pushed or popped, a block opened beside, a pane closed or the
 * keyboard moved — written back to the URL, so a reload and the browser's
 * back and forward keep it. Both panes read the one live graph, so an edit in
 * either shows in the other at once.
 */
function SplitView() {
  const { _splat: noteId = "" } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const layout = React.useMemo(() => layoutFromSearch(noteId, search), [noteId, search])
  const wide = useMedia(SPLIT_QUERY)
  // A pop lands on the row that was selected in the view it returns to; the
  // pane reads it once its view is on screen. Kept beside the URL rather
  // than in it, so a reload, or back and forward, land by the editor's own
  // rule.
  const [landing, setLanding] = useState<{
    pane: number
    view: ViewTarget
    path: SelectionPath
  } | null>(null)
  // `g p` hands the keyboard to a pane's editor: a bump per request. On
  // load the active pane asks for it too, since each editor takes the
  // keyboard as it mounts when nothing has it, and the first pane mounts
  // first.
  const [refocus, setRefocus] = useState(() => ({
    pane: layout.active,
    n: layout.active > 0 ? 1 : 0,
  }))

  const write = React.useCallback(
    (
      next: PaneLayout,
      {
        replace = false,
        land,
      }: { replace?: boolean; land?: { pane: number; path: SelectionPath } } = {},
    ) => {
      const { noteId: first, search: params } = layoutToSearch(next)
      setLanding(
        land
          ? { pane: land.pane, view: currentFrame(next.panes[land.pane]), path: land.path }
          : null,
      )
      navigate({
        to: "/views/$",
        params: { _splat: first },
        // Every frame's narrowing and folds are the layout's: the first
        // pane's frame on screen writes `filter`, `sort` and `folds`.
        search: (prev) => ({ ...prev, ...params }),
        replace,
      })
    },
    [navigate],
  )

  // A pane's frame on screen changed its narrowing or folds: the same
  // place, so the URL entry is replaced rather than added to.
  const update = (index: number, patch: Partial<FocusFrame>) =>
    write(withPane(layout, index, withCurrent(layout.panes[index], patch)), { replace: true })
  // A pane's focus moved: its stack is the new one, and it has the keyboard.
  const move = (index: number, focusMove: FocusMove) =>
    write(
      { panes: withPane(layout, index, focusMove.pane).panes, active: index },
      { land: focusMove.landing ? { pane: index, path: focusMove.landing } : undefined },
    )
  // The keyboard goes with the reader: into the pane a key opened or moved
  // to, or the one left when a pane closes.
  const focusPane = React.useCallback(
    (index: number) => setRefocus((prev) => ({ pane: index, n: prev.n + 1 })),
    [],
  )
  const split = () => {
    const from = layout.active
    const next = openBeside(layout, from, currentFrame(layout.panes[from])).layout
    write(next)
    focusPane(next.active)
  }
  const close = (index: number) => {
    const next = closePane(layout, index)
    write(next)
    focusPane(next.active)
  }
  const openBesideFrom = (index: number, id: string) => {
    const result = openBeside(layout, index, {
      noteId: currentFrame(layout.panes[index]).noteId,
      root: id,
    })
    const to = result.layout.active
    write(result.layout, { land: result.landing ? { pane: to, path: result.landing } : undefined })
    focusPane(to)
  }

  // ⌘\: a second pane on the view, or close the one with the keyboard.
  useHotkeys(
    APP_SHORTCUTS.toggleSplit,
    () => {
      if (layout.panes.length > 1) close(layout.active)
      else if (wide) split()
    },
    GLOBAL_HOTKEY_OPTIONS,
    [layout, wide, write],
  )

  const shown = wide ? layout.panes.map((_, index) => index) : [layout.active]
  const isSplit = shown.length > 1

  // `g p`: the keyboard to the next pane, its editor back on the row it had.
  const setOtherPane = useSetAtom(otherPaneAtom)
  useEffect(() => {
    if (!isSplit) return
    setOtherPane(() => () => {
      const index = nextPaneIndex(layout)
      write(activate(layout, index), { replace: true })
      focusPane(index)
    })
    return () => setOtherPane(null)
  }, [isSplit, layout, write, setOtherPane, focusPane])

  return (
    <div className={cx("grid overflow-hidden", isSplit && "grid-cols-2")}>
      {shown.map((index) => {
        const pane = layout.panes[index]
        const frame = currentFrame(pane)
        const lands =
          landing !== null &&
          landing.pane === index &&
          landing.view.noteId === frame.noteId &&
          landing.view.root === frame.root
        return (
          <NotePage
            key={`${index}:${frame.noteId}`}
            pane={pane}
            leading={index === shown[0]}
            split={isSplit}
            active={index === layout.active}
            // The editor names a row by its occurrence key: the same path.
            landing={lands ? keyOfPath(landing.path) : null}
            refocusRequest={refocus.pane === index ? refocus.n : 0}
            onMove={(focusMove) => move(index, focusMove)}
            onUpdate={(patch) => update(index, patch)}
            onOpenBeside={wide ? (id) => openBesideFrom(index, id) : undefined}
            onActivate={() => {
              if (index !== layout.active) write(activate(layout, index), { replace: true })
            }}
            onSplit={wide && !isSplit ? split : undefined}
            onClose={layout.panes.length > 1 ? () => close(index) : undefined}
          />
        )
      })}
    </div>
  )
}

/** A frame's folds as `useFoldRule` holds them, and back. */
const foldsOf = (folds: FrameFolds | undefined): Folds => ({
  open: new Set(folds?.open ?? []),
  closed: new Set(folds?.closed ?? []),
})
const frameFoldsOf = (folds: Folds): FrameFolds => ({
  open: [...folds.open],
  closed: [...folds.closed],
})

/** One pane of the page: a note, or a block focused on in one. */
interface NotePageProps {
  /** The pane's focus stack; the last frame is the view on screen. */
  pane: Pane
  /** The first pane on screen: its header carries the page's own keys,
   * buttons and notices. */
  leading: boolean
  /** More than one pane on screen. */
  split: boolean
  /** The pane with the keyboard. */
  active: boolean
  /** The row a pop lands on (`BlockEditor.landing`). */
  landing: string | null
  /** Bumped to hand the keyboard to this pane's editor (`g p`). */
  refocusRequest: number
  /** The pane's focus moved (`goTo`, `popFrame`, `popTo`). */
  onMove: (move: FocusMove) => void
  /** The frame on screen changed its narrowing or folds. */
  onUpdate: (patch: Partial<FocusFrame>) => void
  /** Open a block in the pane beside (`o`); absent on a narrow screen. */
  onOpenBeside?: (id: string) => void
  /** The reader is in this pane now (a click, a focus inside it). */
  onActivate: () => void
  /** Open a second pane on this view; absent where there is no room. */
  onSplit?: () => void
  /** Close this pane; absent with one pane. */
  onClose?: () => void
}

function NotePage({
  pane,
  leading,
  split,
  active,
  landing,
  refocusRequest,
  onMove,
  onUpdate,
  onOpenBeside,
  onActivate,
  onSplit,
  onClose,
}: NotePageProps) {
  // Router
  const frame = currentFrame(pane)
  const { noteId, root } = frame
  const focusBlockId = root ?? undefined
  // The frame's own narrowing, over what its root's view saved
  // (`resolveNarrowing`): a frame pushed starts with none.
  const filterParam = frame.filter
  const sortParam = frame.sort
  const navigate = Route.useNavigate()
  // A board card's "Open board" (docs/boards.md, "A board in a note").
  const openNote = useOpenNote()

  // Global state
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const { kind: syncStatus, pushesPending } = useSaveTraceState()
  const databaseStatus = useAtomValue(databaseModeStatusAtom)
  const sharedStatus = useAtomValue(sharedModeStatusAtom)
  // While the local store is still opening — or the notes shared with the
  // user are still on their way — a missing note means "not loaded yet", not
  // "new note": starting an empty editor there shows a blank page over
  // content that is about to arrive, and a first keystroke would mint a note
  // of the user's own under a shared note's id.
  const notesLoaded =
    isSignedOut || (databaseStatus.status === "ready" && sharedStatus.status !== "loading")

  // Note data
  const note = useNoteById(noteId)
  // A note someone shared with the user (docs/sharing.md): read-only unless
  // the owner granted `write`; never renamed without it or given a basket
  // here — those are the owner's, and the basket holds blocks the slice does
  // not carry. The page is otherwise the same page: the title and the editor
  // are the same components, told what they may do.
  const share = useNoteShare(noteId)
  // The view's narrowing: the URL where it speaks, else what this note or
  // block saved as its default view (docs/metadata.md, `resolveNarrowing`).
  // So a narrowed view is a link and the back button undoes it, and a note
  // opens the way it was left.
  const savedView = useSavedView(focusBlockId ?? null, noteId)
  const filter = resolveNarrowing(filterParam, savedView.filter)
  const sort = resolveNarrowing(sortParam, savedView.sort)

  const readOnlyShare = share !== null && !share.canWrite
  // An id no live note claims falls through to the new-note editor below —
  // renames never leave a dead id behind, since the id never changes.
  const showsTitle = !focusBlockId
  // A day or a week is a place on the calendar, not a note (`/calendar/<id>`,
  // docs/event-sourcing.md). Notes once kept under a date-shaped id are
  // ordinary notes now, and still open here; an old link to a day that has
  // no note of its own goes on to the calendar.
  const calendarId =
    noteId !== undefined && (isValidDateString(noteId) || isValidWeekString(noteId))

  // Show "Saving" the instant a change is dispatched, rather than waiting for
  // the debounced sync to actually start. Cleared when the sync finishes (or a
  // short fallback, in case no sync was needed).
  const [pendingSave, setPendingSave] = useState(false)

  // What a note that is not in the graph yet starts as: empty.
  const defaultDoc = React.useMemo(() => ({ ...parse(""), props: null }), [])

  // The doc is the walk of the note — or of the focused block — over the
  // live graph, descended only where the reader's folds open a row
  // (`useFoldRule`); every change the editor hands back becomes ops applied
  // to the graph — see useNoteDoc. The folds are the VIEW's: the note's, or
  // — narrowed — the ones kept for this filter and sort, so a chevron
  // clicked here never lands on the note's own.
  //
  // The bottom frame's folds are the note's, kept on the device. A frame
  // pushed above it holds its own in the URL, as what the reader changed
  // over the standing rule: it starts with none, and a pop gives them back
  // (docs/split-view.md).
  const pushed = pane.frames.length > 1
  const { expanded, setFold } = useFoldRule(
    noteId,
    { filter, sort },
    undefined,
    pushed
      ? {
          folds: foldsOf(frame.folds),
          onChange: (next) => onUpdate({ folds: frameFoldsOf(next) }),
        }
      : undefined,
  )
  const narrowed = filter !== "" || sort !== ""
  // Whether a click beneath the note may add a block to its end (the page's
  // foot, below): an editable note, shown whole.
  const canAppend = !readOnlyShare && !narrowed
  const directions = useAtomValue(linkDirectionsAtom)
  // The block being edited, which a filter keeps whatever it says of it:
  // a row is judged when the editing leaves it, not on every keystroke
  // (`filteredView`, `keep`).
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null)
  const keep = React.useMemo(
    () => (editingBlockId === null ? undefined : new Set([editingBlockId])),
    [editingBlockId],
  )
  const {
    doc: editorDoc,
    collapsed,
    context,
    exists: noteExists,
    setDoc,
  } = useNoteDoc({
    noteId,
    defaultDoc,
    focusBlockId: focusBlockId ?? null,
    expanded,
    directions,
    filter,
    sort,
    keep,
  })
  const jotaiStore = useStore()
  // The folds of the view a move goes to, settled before it shows. A frame
  // popped back to is left as it was, and a new one starts from the
  // standing rule. But leaving a focus for a wider view — the note, or a
  // block above — must show the block just left, so the reader lands back
  // on it: the folds along one path from the new root to it are opened, in
  // the new frame's own folds, or the note's on the device for the bottom
  // frame.
  const settleFolds = (move: FocusMove): FocusMove => {
    if (move.restored) return move
    const next = currentFrame(move.pane)
    if (!noteId || !focusBlockId || next.noteId !== noteId || next.root === focusBlockId) {
      return move
    }
    const chain = pathToBlock(jotaiStore.get(graphSnapshotAtom), next.root ?? noteId, focusBlockId)
    if (!chain || chain.length < 2) return move
    let key: string | null = next.root
    const keys = chain.slice(0, -1).map((id) => (key = keyOf(key, id)))
    if (move.pane.frames.length === 1) {
      openFolds(foldKeyOf(next.noteId, { filter: next.filter, sort: next.sort }), keys)
      return move
    }
    return { ...move, pane: withCurrent(move.pane, { folds: { open: keys, closed: [] } }) }
  }
  // A brand-new note opens ready to be written: the title editing when there
  // is one (naming it is the first thing to do, and naming it creates it —
  // `renameTo`), else the first block. Never while the notes are still
  // loading, or under a shared note's id (see `notesLoaded`).
  const isNewNote = !noteExists && notesLoaded && share === null
  React.useEffect(() => {
    if (!calendarId || !notesLoaded || noteExists || share !== null || split) return
    navigate({ to: "/calendar/$", params: { _splat: noteId }, search: {}, replace: true })
  }, [calendarId, notesLoaded, noteExists, share, noteId, navigate, split])
  // What is open — the focused block, or else the note — is TOUCHED, for
  // the Recent lists, exactly when it is opened (focusing on a block opens
  // it: `focusBlockId` changes), edited (an edit lands through
  // `setEditorDoc`), or a block in it folded or unfolded
  // (`onToggleCollapse`). Never by selecting, focusing or arrowing through
  // it: reading a note is not touching it. One seam (`useTouchNote`), no
  // calls inside the editor.
  const touch = useTouchNote(noteId, focusBlockId)
  const setEditorDoc = React.useCallback(
    (next: BlockDoc, hint?: ChangeHint) => {
      if (!isSignedOut) {
        setPendingSave(true)
        window.setTimeout(() => setPendingSave(false), 4000)
      }
      touch()
      setDoc(next, hint)
    },
    [isSignedOut, setDoc, touch],
  )
  const setNoteProps = useSetNoteProps()

  // Resolve font (the `font` prop or default)
  const parseResult = fontSchema.safeParse(note?.props.font)
  const parsedFont = parseResult.success ? parseResult.data : null
  const resolvedFont = parsedFont || "sans"

  // Resolve width (the `width` prop or default)
  const parsedWidthResult = widthSchema.safeParse(note?.props.width)
  const resolvedWidth = parsedWidthResult.success ? parsedWidthResult.data : "fixed"

  // Set the font: the page's, from the pane with the keyboard. Side by
  // side, each pane also sets its own on itself (`fontVars`, below).
  React.useEffect(() => {
    if (!active) return
    document.documentElement.style.setProperty(
      "--font-family-content",
      `var(--font-family-${resolvedFont})`,
    )
    document.documentElement.style.setProperty(
      "--font-family-mono",
      `var(--font-family-${resolvedFont}-mono)`,
    )
  }, [resolvedFont, active])
  const fontVars = split
    ? ({
        "--font-family-content": `var(--font-family-${resolvedFont})`,
        "--font-family-mono": `var(--font-family-${resolvedFont}-mono)`,
      } as React.CSSProperties)
    : undefined

  // Layout
  const { ref: containerRef, width: containerWidth = 0 } = useResizeObserver()

  // Keyboard flow between the note title and the block editor: the editor bumps
  // titleFocusSignal to select the title (arrow up past the first block); the
  // title bumps focusFirstSignal to move back into the first block (arrow down).
  const [focusFirstSignal, setFocusFirstSignal] = useState(0)
  // Whether the last title→editor hand-off should open the first block editing
  // (title was being edited) or just highlighted (title was highlighted).
  const [focusFirstMode, setFocusFirstMode] = useState<"edit" | "select">("select")
  const [titleFocusSignal, setTitleFocusSignal] = useState(0)
  const [newRootSignal, setNewRootSignal] = useState(0)
  const [appendRootSignal, setAppendRootSignal] = useState(0)
  const [refocusSignal, setRefocusSignal] = useState(0)

  // Actions
  const renameNote = useRenameNote()
  const createNote = useCreateNote()

  // The dispatch moment is over once the pending pushes change: the write
  // landed on this device and queued its push (rising), or the push landed
  // (falling). Online the trace carries on as "Saving" until the push has
  // landed; offline it becomes "Saved offline" (`saveTrace`).
  useEffect(() => {
    setPendingSave(false)
  }, [pushesPending])

  // Held through a burst of typing, so the header does not flicker between
  // "Saving" and what follows it on every keystroke (`useSteadySaveTrace`).
  const trace = useSteadySaveTrace(saveTrace(syncStatus, { pendingSave, pushesPending }))

  // Note props (width, gist) are one `setProps` op, written at once.
  const setProp = React.useCallback(
    (patch: Record<string, unknown>) => {
      if (!noteId) return
      setNoteProps(noteId, patch)
      requestDatabaseFlush()
    },
    [noteId, setNoteProps],
  )

  const updateWidth = React.useCallback(
    // "fixed" is the default width
    (width: Width) => setProp({ width: width === "fixed" ? null : width }),
    [setProp],
  )

  // What the header offers when the view has moved away from what was saved.
  // Any note or block can save one, so the buttons appear wherever a view
  // can be rooted, which is every note.
  const writeView = useWriteView()
  // Measured against what is saved, which may be nothing: filtering a note
  // that has saved no view IS a difference from it, and is how the first one
  // gets saved.
  const filterDirty = savedView.writable && savedView.filter !== filter
  const sortDirty = savedView.writable && savedView.sort !== sort

  // Writing to the URL, so every narrowing is a link and the back button
  // undoes it. `replace`, so a menu is not a step in the history.
  //
  // The narrowing is the frame's (docs/split-view.md): each pane's frame on
  // screen has its own, a frame pushed starts with none, and a pop gives the
  // frame beneath its own back.
  const setNarrowing = React.useCallback(
    (patch: { filter?: string; sort?: string }) => {
      onUpdate({
        ...("filter" in patch
          ? { filter: narrowingParam(patch.filter ?? "", savedView.filter) }
          : {}),
        ...("sort" in patch ? { sort: narrowingParam(patch.sort ?? "", savedView.sort) } : {}),
      })
    },
    [onUpdate, savedView],
  )

  // The save is explicit, both ways: **Update to default** writes what is on
  // screen onto the note or block the view is rooted at, **Reset to default**
  // puts back what it holds. Neither happens on its own — a filter tried out
  // in passing must never quietly overwrite the one that was saved.
  const saveDefaultView = React.useCallback(() => {
    // The view's root is what remembers it: the focused block, or the note
    // itself when the whole note is the view. One row, either way.
    const rootId = focusBlockId ?? noteId
    if (!rootId) return
    writeView(rootId, { filter, sort })
    // The URL has nothing left to say now that the view says it.
    onUpdate({ filter: undefined, sort: undefined })
  }, [focusBlockId, noteId, filter, sort, writeView, onUpdate])
  const resetToDefaultView = React.useCallback(() => {
    onUpdate({ filter: undefined, sort: undefined })
  }, [onUpdate])
  // Both menus are handed the same pair: a node holds ONE view, so settling
  // it from the Sort menu must keep the filter that is set, and the other
  // way round. Only the dot differs, which says which half moved.
  const savedViewActions = React.useMemo(
    () => ({ onUpdateDefault: saveDefaultView, onResetDefault: resetToDefaultView }),
    [saveDefaultView, resetToDefaultView],
  )

  // Retitle the current note. Since ids are minted, this sets one property and
  // nothing else moves — no new id, no navigation, no broken links. Returns
  // whether anything changed (so the inline editor can revert a no-op).
  //
  // A note not in the graph yet (a fresh `/views/<id>`) has no node to
  // retitle, so naming it is what creates it — the same way a first block
  // does (`useNoteDoc`). Only once the notes have loaded and the id is not a
  // shared note's, for the reasons `notesLoaded` gives above.
  const renameTo = React.useCallback(
    (rawName: string): boolean => {
      if (!noteId) return false
      if (noteExists) return renameNote({ noteId, newTitle: rawName })
      if (!notesLoaded || share !== null) return false
      const title = rawName.trim()
      if (!title) return false
      createNote(noteId, { title })
      return true
    },
    [noteId, noteExists, notesLoaded, share, renameNote, createNote],
  )

  // ⌘S writes the coalescing ops immediately (changes save on their own;
  // this is just "save now").
  useHotkeys(APP_SHORTCUTS.save, () => requestDatabaseFlush(), {
    ...GLOBAL_HOTKEY_OPTIONS,
    enabled: active,
  })

  // Focus the editor from anywhere on the page (never while typing): restores
  // the last selected block so `i` means "put me back where I was".
  useHotkeys(APP_SHORTCUTS.focusEditor, () => setRefocusSignal((n) => n + 1), {
    preventDefault: true,
    enabled: active,
  })
  // `g p` brought the keyboard here (`SplitView`).
  React.useEffect(() => {
    if (refocusRequest) setRefocusSignal((n) => n + 1)
  }, [refocusRequest])

  // The pane's focus stack (src/data/panes.ts). Focusing on a block pushes
  // a frame, with the row selected here recorded beneath it; going to a
  // view already on the stack (a crumb, ⌘⇧. to the note) pops back to it,
  // and Shift+F pops one. A frame popped back to keeps its folds as they
  // were, and lands on its recorded row (`landing`); a new focused frame
  // starts from the standing rule, and a new view opens the folds down to
  // the block just left (`settleFolds`).
  const applyMove = (move: FocusMove | null) => {
    if (!move) return
    onMove(settleFolds(move))
  }
  const focusTo = (id: string | null, selected: string | null) => {
    if (noteId) applyMove(goTo(pane, { noteId, root: id }, selected ? pathOfKey(selected) : null))
  }
  const canPop = popFrame(pane) !== null
  const focusBack = () => applyMove(popFrame(pane))
  // The stack drawn as a trail: in focus, where the editor draws its
  // breadcrumb; outside it, above the title, once the stack holds a view
  // beneath this one.
  const trail =
    focusBlockId || pane.frames.length > 1 ? (
      <FocusTrail
        frames={pane.frames}
        onPopTo={(at) => applyMove(popTo(pane, at))}
        onGoVia={(at, target) => applyMove(goVia(pane, at, target))}
      />
    ) : null

  const favicon = note ? <NoteFavicon note={note} /> : <NoteIcon16 />
  const pageTitle = note?.displayName || "Untitled"

  return (
    // The pane is the active one the moment the reader presses on it.
    // Focus alone does not say so: an editor takes the keyboard as it
    // mounts, and the keys that move between panes (`g p`, `o`, ⌘\) set
    // the active pane themselves.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      data-testid="note-pane"
      data-active={split ? active : undefined}
      className={cx("grid overflow-hidden", !leading && "border-l border-border-secondary")}
      style={fontVars}
      onPointerDownCapture={onActivate}
    >
      <PageLayout
        secondary={!leading}
        // The note's name is its title now, not its (opaque) id. A shared
        // note's header leads with whose it is, quietly, then the note as the
        // current crumb — its favicon beside its name, as in the sidebar's
        // rows — so the icon slot stays empty for a share.
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            {share !== null ? (
              <>
                <span className="truncate text-text-secondary">{shareOwnerName(share.share)}</span>
                <span aria-hidden className="shrink-0 text-text-tertiary">
                  ›
                </span>
                <span className="flex size-icon shrink-0 text-text-secondary">{favicon}</span>
              </>
            ) : null}
            {/* Side by side, the pane without the keyboard says so quietly. */}
            <span className={cx("truncate", split && !active && "text-text-secondary")}>
              {pageTitle}
            </span>
          </span>
        }
        // The note's icon leads back to the Views page, the list it was opened
        // from, on a phone as on a desktop.
        icon={
          share === null ? (
            <Link
              to="/"
              search={{ query: undefined }}
              aria-label="Views"
              className="focus-ring flex rounded-sm"
            >
              {favicon}
            </Link>
          ) : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            {/* Changes save automatically; this is the honest-but-quiet trace of
              a save in flight — and, offline, of one that is on this device
              and waiting to sync (`saveTrace`). */}
            {trace === "saving" ? (
              <span className="flex items-center gap-1.5 text-sm text-text-secondary print:hidden">
                <LoadingIcon16 className="animate-spin" />
                Saving
              </span>
            ) : trace === "saved-offline" ? (
              <span className="flex items-center gap-1.5 text-sm text-text-secondary print:hidden">
                <OfflineIcon16 />
                {/* A phone's header has no room for the second word; the icon
                  says offline there. */}
                <span className="sm:hidden">Saved</span>
                <span className="hidden sm:inline">Saved offline</span>
              </span>
            ) : null}

            <div className="flex items-center">
              {/* Each pane's frame has its own filter and sort. */}
              <SortMenu
                sort={sort}
                onSortChange={(next) => setNarrowing({ sort: next })}
                saved={savedView.writable ? { ...savedViewActions, dirty: sortDirty } : undefined}
              />
              <FilterMenu
                filter={filter}
                onFilterChange={(next) => setNarrowing({ filter: next })}
                scope={focusBlockId ?? noteId}
                saved={savedView.writable ? { ...savedViewActions, dirty: filterDirty } : undefined}
              />
              <NoteActionsMenu
                noteId={noteId ?? ""}
                align="end"
                editor={{
                  showWidth: containerWidth > 800,
                  width: resolvedWidth,
                  onWidth: updateWidth,
                  onDeleted: () =>
                    onClose
                      ? onClose()
                      : navigate({ to: "/", search: { query: undefined }, replace: true }),
                  focusBlockId: focusBlockId ?? null,
                  filter,
                }}
              />
              {onSplit ? (
                <IconButton
                  aria-label="Split view"
                  shortcut={formatCombo(APP_SHORTCUTS.toggleSplit)}
                  size="small"
                  tooltipAlign="end"
                  onClick={onSplit}
                >
                  <SplitIcon16 />
                </IconButton>
              ) : null}
              {onClose ? (
                <IconButton
                  aria-label="Close pane"
                  shortcut={active ? formatCombo(APP_SHORTCUTS.toggleSplit) : undefined}
                  size="small"
                  tooltipAlign="end"
                  onClick={onClose}
                >
                  <XIcon16 />
                </IconButton>
              ) : null}
            </div>
          </div>
        }
      >
        <div ref={containerRef} className="@container">
          {/* --note-header-pull: how far the title, focus breadcrumb and focus
            title hang into the gutter (`.note-header`, block-editor.css) —
            the full marker-slot offset, but only once the gutter is 40px, as
            the hanging # needs the room. */}
          <div className="p-4 @[480px]:p-5 @[640px]:p-10 @[640px]:[--note-header-pull:27px]">
            <div
              className={cx(
                "flex flex-col gap-8",
                resolvedWidth === "fixed" && "mx-auto max-w-[700px]",
              )}
            >
              {share !== null ? (
                // -mx-0.5: the notice's edges sit where the rows' surfaces
                // reach (2px past the text column), as the title's do.
                <Notice icon={<ShareIcon16 />} className="-mx-0.5 print:hidden">
                  Shared by {shareOwnerName(share.share)}
                  {readOnlyShare
                    ? " — you can read this note but not change it."
                    : share.canDelete
                      ? " — you can edit and delete."
                      : " — you can edit; deleting is not allowed."}
                </Notice>
              ) : null}

              <div className="flex flex-col gap-3">
                {/* While focused, the breadcrumb (inside the editor) carries the
                    note title as its first crumb — hide the standalone title to
                    avoid doubling it. Outside focus, a stack with views
                    beneath this one shows them above the title. */}
                {showsTitle ? trail : null}
                {showsTitle ? (
                  <NoteTitle
                    title={note?.title ?? ""}
                    onRename={renameTo}
                    readOnly={readOnlyShare}
                    startEditing={isNewNote}
                    onArrowDown={(mode) => {
                      setFocusFirstMode(mode)
                      setFocusFirstSignal((n) => n + 1)
                    }}
                    onCreateBelow={() => setNewRootSignal((n) => n + 1)}
                    focusSignal={titleFocusSignal}
                  />
                ) : null}
                <BlockNoteEditor
                  key={noteId}
                  noteId={noteId}
                  doc={editorDoc}
                  onChange={setEditorDoc}
                  folds={{
                    collapsed,
                    toggle: (key) => setFold(key, collapsed.has(key)),
                    setOpen: (key) => setFold(key, true),
                  }}
                  onToggleCollapse={touch}
                  startEditing={isNewNote && !showsTitle}
                  readOnly={readOnlyShare}
                  browse={readOnlyShare}
                  // Only where there IS a title above the editor to take the
                  // keyboard: a focused block carries its name in the
                  // breadcrumb instead (the focused heading's own title is
                  // the editor's to hand focus to, not ours).
                  onExitTop={showsTitle ? () => setTitleFocusSignal((n) => n + 1) : undefined}
                  focusFirstSignal={focusFirstSignal}
                  focusFirstMode={focusFirstMode}
                  newRootSignal={newRootSignal}
                  appendRootSignal={appendRootSignal}
                  refocusSignal={refocusSignal}
                  focusBlockId={focusBlockId ?? null}
                  // Each move is a plain push of the URL, so the back button
                  // undoes it too.
                  onFocusNavigate={focusTo}
                  onFocusBack={canPop ? focusBack : undefined}
                  focusTrail={trail ?? undefined}
                  landing={landing}
                  onOpenBeside={onOpenBeside}
                  noteTitle={note?.displayName ?? ""}
                  context={context}
                  onOpenBoard={(id) => void openNote(id)}
                  onEditingChange={setEditingBlockId}
                  // Narrowed, there is no starter row to type into. A new
                  // row lands in the note as it does anywhere (Enter on a
                  // row, `useNoteDoc`), but a blank one is a plain text row
                  // the filter hides the moment it is typed into.
                  starter={!narrowed}
                />
                {noteId && noteExists && share === null ? (
                  <UnassignedBasket noteId={noteId} />
                ) : null}
              </div>
              {/* The page's foot: half a screen of room beneath the note, so
                its last block is never pinned to the bottom edge — and, where
                the note can be written, the place to click for a block at its
                end, as the foot of a Notion page is: the last block if it is
                already an empty one, else a new one after it
                (`appendRootSignal`). A note no longer keeps an empty paragraph
                at its end for this. Not while narrowed (a blank row is one
                the filter would hide). It starts where the last thing on the
                page ends (the negative margin eats the column's gap), so the
                room is the target, whole. The keyboard has its own ways to
                the end of a note (↓ to the last row, Enter), so the click
                needs no key. */}
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
              <div
                data-testid="page-foot"
                className={cx("-mt-8 h-[50vh]", canAppend && "cursor-text")}
                onClick={canAppend ? () => setAppendRootSignal((n) => n + 1) : undefined}
              />
            </div>
          </div>
        </div>
      </PageLayout>
    </div>
  )
}
