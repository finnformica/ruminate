import { createFileRoute } from "@tanstack/react-router"
import { useAtomValue, useStore } from "jotai"
import React, { useEffect, useState } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import useResizeObserver from "use-resize-observer"
import { Calendar } from "../components/calendar"
import { CalendarHeader } from "../components/calendar-header"
import { DaysOfWeek } from "../components/days-of-week"
import { Details } from "../components/ui/details"
import { LoadingIcon16, NoteIcon16, ShareIcon16 } from "../components/icons"
import { Notice } from "../components/notice"
import { parse } from "../blocks/parse"
import type { BlockDoc, ChangeHint } from "../blocks/types"
import { BlockNoteEditor } from "../components/block-editor/block-note-editor"
import { NoteTitle } from "../components/block-editor/note-title"
import { NoteActionsMenu } from "../components/note-actions-menu"
import { UnassignedBasket } from "../components/unassigned-basket"
import { NoteFavicon } from "../components/note-favicon"
import { PageLayout } from "../components/page-layout"
import { isSyncingAtom } from "../components/sync-status"
import { databaseModeStatusAtom } from "../data/database-mode"
import { sharedModeStatusAtom } from "../data/shared-mode"
import { requestDatabaseFlush } from "../data/database-mode"
import {
  graphSnapshotAtom,
  isDatabaseModeAtom,
  isSignedOutAtom,
  linkDirectionsAtom,
} from "../global-state"
import { useCreateNote, useNoteById, useRenameNote, useSetNoteProps } from "../hooks/note"
import { useWriteView } from "../hooks/views"
import { viewByRootAtom } from "../data/views"
import { sharedViewByRootAtom } from "../data/shared-mode"
import { useTouchNote } from "../hooks/touch-note"
import { useNoteDoc } from "../hooks/note-doc"
import { pathToBlock } from "../data/graph"
import { narrowingParam, resolveNarrowing } from "../utils/view-filter"
import { FilterMenu, SortMenu } from "../components/view-controls"
import { useFoldRule } from "../data/view-state"
import { keyOf } from "../blocks/view"
import { useNoteShare } from "../hooks/share"
import { shareOwnerName } from "../data/shares"
import { Width, fontSchema, widthSchema } from "../schema"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { isValidDateString, isValidWeekString, toDateString } from "../utils/date"

/** What a note or block saved as its default view (docs/metadata.md), and
 * whether this session may write one. */
interface SavedView {
  filter: string
  sort: string
  /** Whether the header may offer to save: there is something to root a
   * view at. A note shared with the user included — the view is the user's
   * own row (`src/data/views.ts`), whoever owns the note. */
  writable: boolean
}

const NO_SAVED_VIEW: SavedView = { filter: "", sort: "", writable: false }

/**
 * The saved view of whatever the page is rooted at — the focused block, else
 * the note: the view row rooted there (docs/metadata.md, "Views"). Nothing
 * has to be pinned for it; the pin is one field of the same row. On a note
 * someone shared, the reader's own row wins, and the share's view — the
 * owner's filter and sort, which is what a share IS (docs/sharing.md) — fills
 * in behind it, so the note opens the way the owner meant it to.
 */
function useSavedView(focusBlockId: string | null, noteId: string | undefined) {
  const byRoot = useAtomValue(viewByRootAtom)
  const sharedByRoot = useAtomValue(sharedViewByRootAtom)
  return React.useMemo<SavedView>(() => {
    const rootId = focusBlockId ?? noteId
    if (!rootId) return NO_SAVED_VIEW
    const view = byRoot.get(rootId) ?? sharedByRoot.get(rootId)
    return { filter: view?.filter ?? "", sort: view?.sort ?? "", writable: true }
  }, [focusBlockId, noteId, byRoot, sharedByRoot])
}

type RouteSearch = {
  query: string | undefined
  /** Block id the editor is focused on; absent = outside focus. */
  block?: string
  /**
   * The view's filter, in the query language (`type:todo`): the rows that
   * match stay, their ancestors are kept as dimmed context and everything
   * else goes (`src/data/filter-view.ts`). Absent = every row.
   */
  filter?: string
  /** How each parent's children are ordered (`text`, `text:desc`), the
   * nesting untouched. Absent = the note's own order. */
  sort?: string
}

export const Route = createFileRoute("/_appRoot/notes_/$")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => {
    return {
      query: typeof search.query === "string" ? search.query : undefined,
      block: typeof search.block === "string" ? search.block : undefined,
      filter: typeof search.filter === "string" ? search.filter : undefined,
      sort: typeof search.sort === "string" ? search.sort : undefined,
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  const { _splat: noteId } = Route.useParams()
  const isSignedOut = useAtomValue(isSignedOutAtom)
  // Signed in, the store serves notes immediately; signed out, the sample
  // notes render. Only the brief auth resolution at boot is gated.
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)

  if (isSignedOut || isDatabaseMode) {
    return <NotePage key={noteId} />
  }

  return (
    <PageLayout title="Note" icon={<NoteIcon16 />}>
      <div>{/* TODO */}</div>
    </PageLayout>
  )
}

function NotePage() {
  // Router
  const { _splat: noteId } = Route.useParams()
  const { block: focusBlockId, filter: filterParam, sort: sortParam } = Route.useSearch()
  const navigate = Route.useNavigate()

  // Global state
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const isSyncing = useAtomValue(isSyncingAtom)
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
  const isDailyNote = isValidDateString(noteId ?? "")
  const isWeeklyNote = isValidWeekString(noteId ?? "")
  // A daily note is editable only for the current day; the database stores
  // current state only (no history to reconstruct — docs/graph-storage.md),
  // so past/future days show a placeholder. "Today" is resolved in the
  // current timezone, to match the floating YYYY-MM-DD note naming.
  const isReadOnlyDailyNote = isDailyNote && noteId !== toDateString(new Date())
  const useBlockEditor = !isReadOnlyDailyNote
  // An id no live note claims falls through to the new-note editor below —
  // renames never leave a dead id behind, since the id never changes.
  const showsTitle = !isDailyNote && !isWeeklyNote && !focusBlockId

  // Show "Saving…" the instant a change is dispatched, rather than waiting for
  // the debounced sync to actually start. Cleared when the sync finishes (or a
  // short fallback, in case no sync was needed).
  const [pendingSave, setPendingSave] = useState(false)

  // What a note that is not in the graph yet starts as: empty.
  const defaultDoc = React.useMemo(() => ({ ...parse(""), props: null }), [])

  // The doc is the walk of the note — or of the focused block — over the
  // live graph, descended only where the reader's folds open a row
  // (`useFoldRule`); every change the editor hands back becomes ops applied
  // to the graph — see useNoteDoc.
  const { expanded, setFold } = useFoldRule(noteId)
  const directions = useAtomValue(linkDirectionsAtom)
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
  })
  const jotaiStore = useStore()
  // Leaving a focus for a wider view — the note, or a block above — must
  // show the block just left, so the reader lands back on it: the folds
  // along one path from the new root to it are opened first (nothing to do
  // when the walk already shows it).
  const revealOnLeaveFocus = React.useCallback(
    (target: string | null) => {
      if (!noteId || !focusBlockId || target === focusBlockId) return
      const graph = jotaiStore.get(graphSnapshotAtom)
      const chain = pathToBlock(graph, target ?? noteId, focusBlockId)
      if (!chain) return
      // Each ancestor's key and level, counted as the walk counts them: a
      // note's roots are level 1, a focused block's children too.
      let key: string | null = target
      chain.slice(0, -1).forEach((id, index) => {
        key = keyOf(key, id)
        if (!expanded(key, index + 1)) setFold(key, true)
      })
    },
    [noteId, focusBlockId, jotaiStore, expanded, setFold],
  )
  // A brand-new note opens ready to be written: the title editing when there
  // is one (naming it is the first thing to do, and naming it creates it —
  // `renameTo`), else the first block. Never while the notes are still
  // loading, or under a shared note's id (see `notesLoaded`).
  const isNewNote = !noteExists && notesLoaded && share === null
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

  // Set the font
  React.useEffect(() => {
    document.documentElement.style.setProperty(
      "--font-family-content",
      `var(--font-family-${resolvedFont})`,
    )
    document.documentElement.style.setProperty(
      "--font-family-mono",
      `var(--font-family-${resolvedFont}-mono)`,
    )
  }, [resolvedFont])

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
  const [refocusSignal, setRefocusSignal] = useState(0)

  // Actions
  const renameNote = useRenameNote()
  const createNote = useCreateNote()

  const wasSyncingRef = React.useRef(false)
  useEffect(() => {
    if (isSyncing) {
      wasSyncingRef.current = true
    } else if (wasSyncingRef.current) {
      wasSyncingRef.current = false
      setPendingSave(false)
    }
  }, [isSyncing])

  const isSaving = pendingSave || isSyncing

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
  // Any note or block can save one — nothing has to be pinned — so the
  // buttons appear wherever a view can be rooted, which is every note.
  const writeView = useWriteView()
  // Measured against what is saved, which may be nothing: filtering a note
  // that has saved no view IS a difference from it, and is how the first one
  // gets saved.
  const filterDirty = savedView.writable && savedView.filter !== filter
  const sortDirty = savedView.writable && savedView.sort !== sort

  // Writing to the URL, so every narrowing is a link and the back button
  // undoes it. `replace`, so a menu is not a step in the history.
  const setNarrowing = React.useCallback(
    (patch: { filter?: string; sort?: string }) => {
      navigate({
        search: (prev) => ({
          ...prev,
          ...("filter" in patch
            ? { filter: narrowingParam(patch.filter ?? "", savedView.filter) }
            : {}),
          ...("sort" in patch ? { sort: narrowingParam(patch.sort ?? "", savedView.sort) } : {}),
        }),
        replace: true,
      })
    },
    [navigate, savedView],
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
    navigate({ search: (prev) => ({ ...prev, filter: undefined, sort: undefined }), replace: true })
  }, [focusBlockId, noteId, filter, sort, writeView, navigate])
  const resetToDefaultView = React.useCallback(() => {
    navigate({ search: (prev) => ({ ...prev, filter: undefined, sort: undefined }), replace: true })
  }, [navigate])
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
  // A note not in the graph yet (a fresh `/notes/<id>`) has no node to
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
  useHotkeys(APP_SHORTCUTS.save, () => requestDatabaseFlush(), GLOBAL_HOTKEY_OPTIONS)

  // Focus the editor from anywhere on the page (never while typing): restores
  // the last selected block so `i` means "put me back where I was".
  useHotkeys(APP_SHORTCUTS.focusEditor, () => setRefocusSignal((n) => n + 1), {
    preventDefault: true,
  })

  const favicon = note ? <NoteFavicon note={note} /> : <NoteIcon16 />

  return (
    <PageLayout
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
          <span className="truncate">{note?.displayName || "Untitled"}</span>
        </span>
      }
      icon={share === null ? favicon : undefined}
      actions={
        <div className="flex items-center gap-2">
          {/* Changes save automatically; this is the honest-but-quiet trace of
              a save in flight. */}
          {isSaving ? (
            <span className="flex items-center gap-1.5 text-sm text-text-secondary print:hidden">
              <LoadingIcon16 className="animate-spin" />
              Saving…
            </span>
          ) : null}

          <div className="flex items-center">
            <SortMenu
              sort={sort}
              onSortChange={(next) => setNarrowing({ sort: next })}
              saved={savedView.writable ? { ...savedViewActions, dirty: sortDirty } : undefined}
            />
            <FilterMenu
              filter={filter}
              onFilterChange={(next) => setNarrowing({ filter: next })}
              saved={savedView.writable ? { ...savedViewActions, dirty: filterDirty } : undefined}
            />
            <NoteActionsMenu
              noteId={noteId ?? ""}
              align="end"
              editor={{
                showWidth: containerWidth > 800,
                width: resolvedWidth,
                onWidth: updateWidth,
                onDeleted: () => navigate({ to: "/", search: { query: undefined }, replace: true }),
                focusBlockId: focusBlockId ?? null,
              }}
            />
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
              "flex flex-col gap-8 pb-[50vh]",
              resolvedWidth === "fixed" && "mx-auto max-w-[700px]",
            )}
          >
            {isDailyNote || isWeeklyNote ? (
              <div className="print-hidden flex flex-col gap-8">
                <Calendar className="-m-2" activeNoteId={noteId ?? ""} />
                <CalendarHeader activeNoteId={noteId ?? ""} />
              </div>
            ) : null}

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

            {useBlockEditor ? (
              <div className="flex flex-col gap-3">
                {/* While focused, the breadcrumb (inside the editor) carries the
                    note title as its first crumb — hide the standalone title to
                    avoid doubling it. */}
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
                  // keyboard: a daily note has none, and a focused one carries
                  // its name in the breadcrumb instead (the focused heading's
                  // own title is the editor's to hand focus to, not ours).
                  onExitTop={showsTitle ? () => setTitleFocusSignal((n) => n + 1) : undefined}
                  focusFirstSignal={focusFirstSignal}
                  focusFirstMode={focusFirstMode}
                  newRootSignal={newRootSignal}
                  refocusSignal={refocusSignal}
                  focusBlockId={focusBlockId ?? null}
                  onFocusNavigate={(id) => {
                    revealOnLeaveFocus(id)
                    // A plain push, so the back button undoes focus naturally.
                    navigate({ search: (prev) => ({ ...prev, block: id ?? undefined }) })
                  }}
                  noteTitle={note?.displayName ?? ""}
                  context={context}
                  // Narrowed, there is no blank row to type into: a new
                  // block is structure, and structure belongs to the note
                  // rather than to a selection of it (`useNoteDoc`). A row
                  // that swallowed typing would be a lie.
                  trailingBlank={filter === "" && sort === ""}
                />
                {noteId && noteExists && share === null ? (
                  <UnassignedBasket noteId={noteId} />
                ) : null}
              </div>
            ) : (
              // The database stores current state only, so there is no
              // per-day history to reconstruct for past days.
              <p className="text-text-secondary">History for past days isn’t available.</p>
            )}
            {isWeeklyNote ? (
              <Details className="print:hidden">
                <Details.Summary>Days</Details.Summary>
                <DaysOfWeek week={noteId ?? ""} />
              </Details>
            ) : null}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
