import { createFileRoute } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React, { useEffect, useState } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import useResizeObserver from "use-resize-observer"
import { Calendar } from "../components/calendar"
import { CalendarHeader } from "../components/calendar-header"
import { DaysOfWeek } from "../components/days-of-week"
import { Details } from "../components/details"
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
import { isDatabaseModeAtom, isSignedOutAtom } from "../global-state"
import { useCreateNote, useNoteById, useRenameNote, useSetNoteProps } from "../hooks/note"
import { useTouchNote } from "../hooks/touch-note"
import { useNoteDoc } from "../hooks/note-doc"
import { useNoteShare } from "../hooks/share"
import { shareOwnerName } from "../data/shares"
import { Width, fontSchema, widthSchema } from "../schema"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { isValidDateString, isValidWeekString, toDateString } from "../utils/date"

type RouteSearch = {
  query: string | undefined
  /** Block id the editor is zoomed into ("focus mode"); absent = un-zoomed. */
  block?: string
}

export const Route = createFileRoute("/_appRoot/notes_/$")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => {
    return {
      query: typeof search.query === "string" ? search.query : undefined,
      block: typeof search.block === "string" ? search.block : undefined,
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
  const { block: zoomBlockId } = Route.useSearch()
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
  // A note someone shared with the user (docs/sharing.md): read-only, never
  // renamed, pinned or given a basket here — those are the owner's, and the
  // basket holds blocks the slice does not carry. The page is otherwise the
  // same page: the title and the editor are the same components, told they
  // are read-only.
  const share = useNoteShare(noteId)
  const readOnlyShare = share !== null
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
  const showsTitle = !isDailyNote && !isWeeklyNote && !zoomBlockId

  // Show "Saving…" the instant a change is dispatched, rather than waiting for
  // the debounced sync to actually start. Cleared when the sync finishes (or a
  // short fallback, in case no sync was needed).
  const [pendingSave, setPendingSave] = useState(false)

  // What a note that is not in the graph yet starts as: empty.
  const defaultDoc = React.useMemo(() => ({ ...parse(""), props: null }), [])

  // The doc is the walk of the note over the live graph; every change the
  // editor hands back becomes ops applied to the graph — see useNoteDoc.
  const {
    doc: editorDoc,
    exists: noteExists,
    setDoc,
  } = useNoteDoc({
    noteId,
    defaultDoc,
  })
  // A brand-new note opens ready to be written: the title editing when there
  // is one (naming it is the first thing to do, and naming it creates it —
  // `renameTo`), else the first block. Never while the notes are still
  // loading, or under a shared note's id (see `notesLoaded`).
  const isNewNote = !noteExists && notesLoaded && share === null
  // The note is TOUCHED — for the palette's Recent list — exactly when it
  // is opened, edited (an edit lands through `setEditorDoc`), a block in it
  // folded or unfolded (`onToggleCollapse`) or zoomed into
  // (`onZoomNavigate`). Never by selecting, focusing or arrowing through
  // it: reading a note is not touching it. One seam (`useTouchNote`), no
  // calls inside the editor.
  const { touch, touching } = useTouchNote(noteId)
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
              <span className="truncate text-text-secondary">{shareOwnerName(share)}</span>
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
            <NoteActionsMenu
              noteId={noteId ?? ""}
              pinned={note?.pinned ?? false}
              align="end"
              editor={{
                showWidth: containerWidth > 800,
                width: resolvedWidth,
                onWidth: updateWidth,
                onDeleted: () => navigate({ to: "/", search: { query: undefined }, replace: true }),
              }}
            />
          </div>
        </div>
      }
    >
      <div ref={containerRef} className="@container">
        <div className="p-4 @[480px]:p-5 @[640px]:p-10">
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
                Shared by {shareOwnerName(share)} — you can read this note but not change it.
              </Notice>
            ) : null}

            {useBlockEditor ? (
              <div className="flex flex-col gap-3">
                {/* While zoomed, the breadcrumb (inside the editor) carries the
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
                  onToggleCollapse={touch}
                  startEditing={isNewNote && !showsTitle}
                  readOnly={readOnlyShare}
                  browse={readOnlyShare}
                  onExitTop={() => setTitleFocusSignal((n) => n + 1)}
                  focusFirstSignal={focusFirstSignal}
                  focusFirstMode={focusFirstMode}
                  newRootSignal={newRootSignal}
                  refocusSignal={refocusSignal}
                  zoomBlockId={zoomBlockId ?? null}
                  onZoomNavigate={touching((id) =>
                    // A plain push, so the back button undoes zoom naturally.
                    navigate({ search: (prev) => ({ ...prev, block: id ?? undefined }) }),
                  )}
                  noteTitle={note?.displayName ?? ""}
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
