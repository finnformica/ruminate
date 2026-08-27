import { createFileRoute } from "@tanstack/react-router"
import ejs from "ejs"
import { useAtomValue } from "jotai"
import { selectAtom } from "jotai/utils"
import React, { useCallback, useEffect, useMemo, useState } from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useNetworkState } from "react-use"
import useResizeObserver from "use-resize-observer"
import { Button } from "../components/button"
import { Calendar } from "../components/calendar"
import { CalendarHeader } from "../components/calendar-header"
import { DaysOfWeek } from "../components/days-of-week"
import { Details } from "../components/details"
import { DraftIndicator } from "../components/draft-indicator"
import { IconButton } from "../components/icon-button"
import { CheckIcon16, LoadingIcon16, NoteIcon16 } from "../components/icons"
import { BlockNoteEditor } from "../components/block-editor/block-note-editor"
import { NoteTitle } from "../components/block-editor/note-title"
import { NoteActionsMenu } from "../components/note-actions-menu"
import { DayActivity } from "../components/day-activity"
import { LinkHighlightProvider } from "../components/link-highlight-provider"
import { NoteFavicon } from "../components/note-favicon"
import { NoteList } from "../components/note-list"
import { PageLayout } from "../components/page-layout"
import { ShareDialog } from "../components/share-dialog"
import { isSyncingAtom } from "../components/sync-status"
import {
  dailyTemplateAtom,
  defaultFontAtom,
  githubRepoAtom,
  globalStateMachineAtom,
  isSignedOutAtom,
  weeklyTemplateAtom,
} from "../global-state"
import { useNoteById, useRenameNote, useSaveNote } from "../hooks/note"
import { useSearchNotes } from "../hooks/search-notes"
import { Note, NoteId, Template, Width, fontSchema, widthSchema } from "../schema"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { isValidDateString, isValidWeekString, toDateString } from "../utils/date"
import { removeFrontmatterComments, updateFrontmatterValue } from "../utils/frontmatter"
import { clearNoteDraft, getNoteDraft, setNoteDraft } from "../utils/note-draft"
import { getInvalidNoteIdCharacters } from "../utils/note-id"
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

const isRepoClonedAtom = selectAtom(globalStateMachineAtom, (state) =>
  state.matches("signedIn.cloned"),
)

function RouteComponent() {
  const { _splat: noteId } = Route.useParams()
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const isRepoCloned = useAtomValue(isRepoClonedAtom)

  if (isSignedOut || isRepoCloned) {
    return <NotePage key={noteId} />
  }

  return (
    <PageLayout title={`${noteId}.md`} icon={<NoteIcon16 />}>
      <div>{/* TODO */}</div>
    </PageLayout>
  )
}

function renderTemplate(template: Template, args: Record<string, unknown> = {}) {
  let text = ejs.render(template.body, args)
  text = removeFrontmatterComments(text)
  text = text.replace("{cursor}", "")
  return text
}

function NotePage() {
  // Router
  const { _splat: noteId } = Route.useParams()
  const {
    query,
    content: defaultContent,
    heading: highlightHeading,
    block: zoomBlockId,
  } = Route.useSearch()
  const navigate = Route.useNavigate()

  // Global state
  const githubRepo = useAtomValue(githubRepoAtom)
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const isSyncing = useAtomValue(isSyncingAtom)
  const dailyTemplate = useAtomValue(dailyTemplateAtom)
  const weeklyTemplate = useAtomValue(weeklyTemplateAtom)
  const defaultFont = useAtomValue(defaultFontAtom)
  const { online } = useNetworkState()

  // Note data
  const note = useNoteById(noteId)
  const isDailyNote = isValidDateString(noteId ?? "")
  const isWeeklyNote = isValidWeekString(noteId ?? "")
  // A daily note is editable only for the current day. Past/future days show a
  // read-only, git-reconstructed view of what was written that day (the
  // calendar time machine). "Today" is resolved in the current timezone, to
  // match the floating YYYY-MM-DD note naming.
  const isReadOnlyDailyNote = isDailyNote && noteId !== toDateString(new Date())
  // Every editable note uses the block editor; only past/future daily notes are
  // the exception, rendering read-only git history (see DayActivity below).
  const useBlockEditor = !isReadOnlyDailyNote
  const searchNotes = useSearchNotes()
  const saveNote = useSaveNote()
  const backlinks = React.useMemo(() => {
    const notes = searchNotes(`link:"${noteId}" -id:"${noteId}"`)
    return new Map<NoteId, Note>(notes.map((note) => [note.id, note]))
  }, [noteId, searchNotes])

  // Editor state
  const { editorValue, setEditorValue, isDraft, discardChanges } = useEditorValue({
    noteId: noteId ?? "",
    note,
    defaultValue: defaultContent
      ? defaultContent
      : isDailyNote && dailyTemplate
        ? renderTemplate(dailyTemplate, { date: noteId ?? "" })
        : isWeeklyNote && weeklyTemplate
          ? renderTemplate(weeklyTemplate, { week: noteId ?? "" })
          : "",
  })
  const parsedNote = React.useMemo(
    () => parseNote(noteId ?? "", editorValue),
    [noteId, editorValue],
  )

  // Resolve font (frontmatter font or default)
  const frontmatterFont = parsedNote?.frontmatter?.font
  const parseResult = fontSchema.safeParse(frontmatterFont)
  const parsedFont = parseResult.success ? parseResult.data : null
  const resolvedFont = parsedFont || defaultFont

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

  // Actions
  const renameNote = useRenameNote()

  const handleSave = React.useCallback(
    (value: string) => {
      if (isSignedOut || !noteId) return

      // New notes shouldn't be saved if the editor is empty
      if (!note && !value) return

      // Only save if the content has changed
      if (value !== note?.content) {
        saveNote({ id: noteId, content: value })
      }

      clearNoteDraft({ githubRepo, noteId })
    },
    [isSignedOut, noteId, note, saveNote, githubRepo],
  )

  // Show "Saving…" the instant a save is requested, rather than waiting for the
  // debounced sync to actually start. Cleared when the sync finishes (or a
  // short fallback, in case no sync was needed).
  const [pendingSave, setPendingSave] = useState(false)
  const wasSyncingRef = React.useRef(false)
  useEffect(() => {
    if (isSyncing) {
      wasSyncingRef.current = true
    } else if (wasSyncingRef.current) {
      wasSyncingRef.current = false
      setPendingSave(false)
    }
  }, [isSyncing])

  const requestSave = React.useCallback(() => {
    if (isSignedOut || !isDraft) return
    setPendingSave(true)
    handleSave(editorValue)
    window.setTimeout(() => setPendingSave(false), 4000)
  }, [isSignedOut, isDraft, handleSave, editorValue])

  const isSaving = pendingSave || isSyncing

  const updateWidth = React.useCallback(
    (width: Width) => {
      if (!noteId) return

      const newContent = updateFrontmatterValue({
        content: editorValue,
        // "fixed" is the default width
        properties: { width: width === "fixed" ? null : width },
      })

      setEditorValue(newContent)
      handleSave(newContent)
    },
    [noteId, editorValue, setEditorValue, handleSave],
  )

  // Rename the current note to `rawName`. Returns whether it succeeded (so an
  // inline title editor can revert on failure).
  const renameTo = React.useCallback(
    (rawName: string): boolean => {
      if (!noteId) return false

      const oldNoteId = noteId
      const newNoteId = rawName.trim().replace(/\.md$/i, "").trim()
      if (!newNoteId || newNoteId === oldNoteId) return false

      const result = renameNote({
        oldName: oldNoteId,
        newName: newNoteId,
        content: editorValue,
      })

      if (!result.success) {
        switch (result.reason) {
          case "no-op":
            return false
          case "invalid":
            {
              const invalidCharacters = Array.from(new Set(getInvalidNoteIdCharacters(newNoteId)))
              const invalidList = invalidCharacters.map((char) => `"${char}"`).join(", ")
              const suffix = invalidList ? `: ${invalidList}` : ""
              window.alert(`"${newNoteId}.md" contains invalid characters${suffix}`)
            }
            return false
          case "duplicate":
            window.alert(`"${newNoteId}.md" already exists.`)
            return false
          default:
            result.reason satisfies never
        }
        return false
      }

      clearNoteDraft({ githubRepo, noteId: oldNoteId })
      clearNoteDraft({ githubRepo, noteId: newNoteId })

      navigate({
        to: "/notes/$",
        params: { _splat: newNoteId },
        search: (prev) => ({ ...prev, content: undefined }),
        replace: true,
      })
      return true
    },
    [noteId, renameNote, editorValue, githubRepo, navigate],
  )

  // Save with ⌘S
  useHotkeys(APP_SHORTCUTS.save, () => requestSave(), GLOBAL_HOTKEY_OPTIONS)

  return (
    <PageLayout
      title={
        <div className="flex items-center gap-2">
          <span className="truncate">{noteId}.md</span>
          {isDraft ? <DraftIndicator /> : null}
        </div>
      }
      icon={<NoteFavicon note={parsedNote} />}
      actions={
        <div className="flex items-center gap-2">
          {useBlockEditor || (!note && editorValue) || isDraft ? (
            <Button
              disabled={isSignedOut || isSaving || !isDraft}
              variant="primary"
              size="small"
              shortcut={isSaving ? undefined : ["⌘", "S"]}
              onClick={requestSave}
              className="hidden items-center gap-1.5 sm:flex"
            >
              {isSaving ? <LoadingIcon16 className="animate-spin" /> : null}
              {isSaving ? "Saving…" : "Save"}
            </Button>
          ) : null}

          <div className="flex items-center">
            <NoteActionsMenu
              noteId={noteId ?? ""}
              content={editorValue}
              pinned={parsedNote?.pinned ?? false}
              backlinks={note?.backlinks ?? []}
              align="end"
              onContentChange={(next) => {
                setEditorValue(next)
                handleSave(next)
              }}
              editor={{
                isDraft,
                onDiscard: discardChanges,
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
                const newContent = updateFrontmatterValue({
                  content: editorValue,
                  properties: { gist_id: gistId },
                })
                setEditorValue(newContent)
                handleSave(newContent)
              }}
              onUnpublish={() => {
                const newContent = updateFrontmatterValue({
                  content: editorValue,
                  properties: { gist_id: null },
                })
                setEditorValue(newContent)
                handleSave(newContent)
                setIsShareDialogOpen(false)
              }}
              open={isShareDialogOpen}
              onOpenChange={setIsShareDialogOpen}
            />
          </div>
        </div>
      }
      floatingActions={
        useBlockEditor || (!note && editorValue) || isDraft ? (
          <div className="card-2 flex gap-1.5 coarse:gap-2 rounded-full! p-1.5 coarse:p-2 sm:hidden print:hidden">
            <IconButton
              aria-label={isSaving ? "Saving…" : "Save"}
              disabled={isSignedOut || isSaving || !isDraft}
              shortcut={isSaving ? undefined : ["⌘", "S"]}
              onClick={requestSave}
              className="size-8 coarse:size-12 rounded-full bg-text text-bg [&_*]:text-bg enabled:hover:bg-text enabled:active:bg-text"
            >
              {isSaving ? <LoadingIcon16 className="animate-spin" /> : <CheckIcon16 />}
            </IconButton>
          </div>
        ) : null
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
                    noteId={noteId ?? ""}
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
                  value={editorValue}
                  onChange={setEditorValue}
                  startEditing={!note}
                  highlightHeading={highlightHeading}
                  onExitTop={() => setTitleFocusSignal((n) => n + 1)}
                  focusFirstSignal={focusFirstSignal}
                  focusFirstMode={focusFirstMode}
                  newRootSignal={newRootSignal}
                  zoomBlockId={zoomBlockId ?? null}
                  onZoomNavigate={(id) =>
                    // A plain push, so the back button undoes zoom naturally.
                    navigate({ search: (prev) => ({ ...prev, block: id ?? undefined }) })
                  }
                  noteTitle={noteId ?? ""}
                />
              </div>
            ) : (
              <DayActivity date={noteId ?? ""} />
            )}
            {isWeeklyNote ? (
              <Details className="print:hidden">
                <Details.Summary>Days</Details.Summary>
                <DaysOfWeek week={noteId ?? ""} />
              </Details>
            ) : null}
            {backlinks.size > 0 ? (
              <Details className="print:hidden">
                <Details.Summary>Backlinks</Details.Summary>
                <LinkHighlightProvider href={`/notes/${noteId}`}>
                  <NoteList
                    baseQuery={`link:"${noteId}" -id:"${noteId}"`}
                    query={query ?? ""}
                    onQueryChange={(query) =>
                      navigate({
                        search: (prev) => ({ ...prev, query }),
                        replace: true,
                      })
                    }
                  />
                </LinkHighlightProvider>
              </Details>
            ) : null}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}

function useEditorValue({
  noteId,
  note,
  defaultValue,
}: {
  noteId: NoteId
  note: Note | undefined
  defaultValue: string
}) {
  const githubRepo = useAtomValue(githubRepoAtom)

  const [editorValue, _setEditorValue] = useState(() => {
    return getNoteDraft({ githubRepo, noteId }) ?? note?.content ?? defaultValue
  })

  // Track previous note content to detect external changes
  const [prevNoteContent, setPrevNoteContent] = useState(note?.content)

  // Adjust state during render when note content changes externally (no effect needed)
  // See: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  if (note?.content !== prevNoteContent) {
    setPrevNoteContent(note?.content)
    // Only update editor if there's no local draft
    const hasDraft = getNoteDraft({ githubRepo, noteId }) !== null
    if (!hasDraft && note?.content !== undefined) {
      _setEditorValue(note.content)
    }
  }

  const isDraft = useMemo(() => {
    return editorValue !== (note ? note.content : defaultValue)
  }, [note, editorValue, defaultValue])

  const setEditorValue = useCallback(
    (value: string) => {
      _setEditorValue(value)

      if (note ? value !== note.content : value !== defaultValue) {
        setNoteDraft({ githubRepo, noteId, value })
      } else {
        clearNoteDraft({ githubRepo, noteId })
      }
    },
    [note, defaultValue, githubRepo, noteId],
  )

  const discardChanges = useCallback(() => {
    // Reset editor value to the last saved state of the note
    _setEditorValue(note?.content ?? defaultValue)
    clearNoteDraft({ githubRepo, noteId })
  }, [note, defaultValue, githubRepo, noteId])

  return { editorValue, setEditorValue, isDraft, discardChanges }
}
