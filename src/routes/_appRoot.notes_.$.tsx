import { createFileRoute } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React, { useEffect, useState } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useNetworkState } from "react-use"
import useResizeObserver from "use-resize-observer"
import { Calendar } from "../components/calendar"
import { CalendarHeader } from "../components/calendar-header"
import { DaysOfWeek } from "../components/days-of-week"
import { Details } from "../components/details"
import { LoadingIcon16, NoteIcon16 } from "../components/icons"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import type { BlockDoc } from "../blocks/types"
import { BlockNoteEditor } from "../components/block-editor/block-note-editor"
import { NoteTitle } from "../components/block-editor/note-title"
import { NoteActionsMenu } from "../components/note-actions-menu"
import { NoteFavicon } from "../components/note-favicon"
import { PageLayout } from "../components/page-layout"
import { ShareDialog } from "../components/share-dialog"
import { isSyncingAtom } from "../components/sync-status"
import { databaseModeStatusAtom } from "../data/database-mode"
import { requestDatabaseFlush } from "../data/database-mode"
import { isDatabaseModeAtom, isSignedOutAtom } from "../global-state"
import { useNoteById, useRenameNote } from "../hooks/note"
import { useNoteDoc } from "../hooks/note-doc"
import { Width, fontSchema, widthSchema } from "../schema"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { isValidDateString, isValidWeekString, toDateString } from "../utils/date"
import { updateDocFrontmatter } from "../utils/frontmatter"
import { parseNote } from "../utils/parse-note"

type RouteSearch = {
  query: string | undefined
  content?: string
  /** Heading text to highlight in the block editor on landing (from Cmd-K). */
  heading?: string
  /** Block id the editor is zoomed into ("focus mode"); absent = un-zoomed. */
  block?: string
}

export const Route = createFileRoute("/_appRoot/notes_/$")({
  validateSearch: (search: Record<string, unknown>): RouteSearch => {
    return {
      query: typeof search.query === "string" ? search.query : undefined,
      content: typeof search.content === "string" ? search.content : undefined,
      heading: typeof search.heading === "string" ? search.heading : undefined,
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
  const {
    content: defaultContent,
    heading: highlightHeading,
    block: zoomBlockId,
  } = Route.useSearch()
  const navigate = Route.useNavigate()

  // Global state
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const isSyncing = useAtomValue(isSyncingAtom)
  const databaseStatus = useAtomValue(databaseModeStatusAtom)
  const { online } = useNetworkState()
  // While the local store is still opening, a missing note means "not loaded
  // yet", not "new note" — starting an empty editor there shows a blank page
  // over content that is about to arrive.
  const notesLoaded = isSignedOut || databaseStatus.status === "ready"

  // Note data
  const note = useNoteById(noteId)
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

  // Show "Saving…" the instant a change is dispatched, rather than waiting for
  // the debounced sync to actually start. Cleared when the sync finishes (or a
  // short fallback, in case no sync was needed).
  const [pendingSave, setPendingSave] = useState(false)

  // What a note that is not in the graph yet starts as: the `?content=`
  // search param (markdown, imported here once), or nothing.
  const defaultDoc = React.useMemo(() => parse(defaultContent ?? ""), [defaultContent])

  // The doc is the walk of the page over the live graph; every change the
  // editor hands back becomes ops applied to the graph — see useNoteDoc.
  const {
    doc: editorDoc,
    exists: pageExists,
    setDoc,
  } = useNoteDoc({
    noteId,
    defaultDoc,
  })
  const setEditorDoc = React.useCallback(
    (next: BlockDoc) => {
      if (!isSignedOut) {
        setPendingSave(true)
        window.setTimeout(() => setPendingSave(false), 4000)
      }
      setDoc(next)
    },
    [isSignedOut, setDoc],
  )
  // The markdown consumers of the page (title, favicon, actions menu, share)
  // still read the note's rollup — the doc's bytes.
  const editorValue = React.useMemo(() => serialize(editorDoc), [editorDoc])
  const parsedNote = React.useMemo(
    () => parseNote(noteId ?? "", editorValue),
    [noteId, editorValue],
  )

  // Resolve font (frontmatter font or default)
  const frontmatterFont = parsedNote?.frontmatter?.font
  const parseResult = fontSchema.safeParse(frontmatterFont)
  const parsedFont = parseResult.success ? parseResult.data : null
  const resolvedFont = parsedFont || "sans"

  // Resolve width (frontmatter width or default)
  const frontmatterWidth = parsedNote?.frontmatter?.width
  const parsedWidthResult = widthSchema.safeParse(frontmatterWidth)
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
  const [isShareDialogOpen, setIsShareDialogOpen] = React.useState(false)

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

  // Programmatic content updates (width, pin, share) write immediately rather
  // than waiting out the coalescing window.
  const applyAndSave = React.useCallback(
    (next: BlockDoc) => {
      setEditorDoc(next)
      requestDatabaseFlush()
    },
    [setEditorDoc],
  )

  const updateWidth = React.useCallback(
    (width: Width) => {
      if (!noteId) return

      applyAndSave(
        // "fixed" is the default width
        updateDocFrontmatter(editorDoc, { width: width === "fixed" ? null : width }),
      )
    },
    [noteId, editorDoc, applyAndSave],
  )

  // Retitle the current note. Since ids are minted, this sets one property and
  // nothing else moves — no new id, no navigation, no broken links. Returns
  // whether anything changed (so the inline editor can revert a no-op).
  const renameTo = React.useCallback(
    (rawName: string): boolean =>
      renameNote({ noteId: noteId ?? "", newTitle: rawName, content: editorValue }),
    [noteId, renameNote, editorValue],
  )

  // ⌘S writes the coalescing ops immediately (changes save on their own;
  // this is just "save now").
  useHotkeys(APP_SHORTCUTS.save, () => requestDatabaseFlush(), GLOBAL_HOTKEY_OPTIONS)

  // Focus the editor from anywhere on the page (never while typing): restores
  // the last selected block so `i` means "put me back where I was".
  useHotkeys(APP_SHORTCUTS.focusEditor, () => setRefocusSignal((n) => n + 1), {
    preventDefault: true,
  })

  return (
    <PageLayout
      // The note's name is its title now, not its (opaque) id.
      title={<span className="truncate">{parsedNote?.displayName || "Untitled"}</span>}
      icon={<NoteFavicon note={parsedNote} />}
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
              content={editorValue}
              pinned={parsedNote?.pinned ?? false}
              align="end"
              // The menu still speaks markdown; import its result.
              onContentChange={(content) => applyAndSave(parse(content))}
              editor={{
                showWidth: containerWidth > 800,
                width: resolvedWidth,
                onWidth: updateWidth,
                onShare: () => setIsShareDialogOpen(true),
                canShare: !isSignedOut && !!note && !!online,
                onDeleted: () => navigate({ to: "/", search: { query: undefined }, replace: true }),
              }}
            />
            <ShareDialog
              note={parsedNote}
              onPublish={(gistId) => {
                applyAndSave(updateDocFrontmatter(editorDoc, { gist_id: gistId }))
              }}
              onUnpublish={() => {
                applyAndSave(updateDocFrontmatter(editorDoc, { gist_id: null }))
                setIsShareDialogOpen(false)
              }}
              open={isShareDialogOpen}
              onOpenChange={setIsShareDialogOpen}
            />
          </div>
        </div>
      }
    >
      <div ref={containerRef} className="@container">
        <div className="p-5 @[640px]:p-10">
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

            {useBlockEditor ? (
              <div className="flex flex-col gap-3">
                {/* While zoomed, the breadcrumb (inside the editor) carries the
                    note title as its first crumb — hide the standalone title to
                    avoid doubling it. */}
                {!isDailyNote && !isWeeklyNote && !zoomBlockId ? (
                  <NoteTitle
                    title={parsedNote?.title ?? ""}
                    onRename={renameTo}
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
                  startEditing={!pageExists && notesLoaded}
                  highlightHeading={highlightHeading}
                  onExitTop={() => setTitleFocusSignal((n) => n + 1)}
                  focusFirstSignal={focusFirstSignal}
                  focusFirstMode={focusFirstMode}
                  newRootSignal={newRootSignal}
                  refocusSignal={refocusSignal}
                  zoomBlockId={zoomBlockId ?? null}
                  onZoomNavigate={(id) =>
                    // A plain push, so the back button undoes zoom naturally.
                    navigate({ search: (prev) => ({ ...prev, block: id ?? undefined }) })
                  }
                  noteTitle={parsedNote?.displayName ?? ""}
                />
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
