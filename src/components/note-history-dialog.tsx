import { useAtom, useAtomValue, useSetAtom } from "jotai"
import React from "react"
import { listNoteVersions, readNoteVersion } from "../data/note-history"
import { useSaveNote } from "../hooks/note"
import { copyAsMarkdown } from "../utils/copy-markdown"
import { cx } from "../utils/cx"
import { formatDate, formatDateDistance, toDateString } from "../utils/date"
import { LineDiffSummary, NoteVersion, diffLineCounts } from "../utils/note-history"
import { BlockNoteEditor } from "./block-editor/block-note-editor"
import { Button } from "./button"
import { Dialog } from "./dialog"
import { CheckIcon16, CopyIcon16, LoadingIcon16 } from "./icons"
import { isNoteHistoryDialogOpenAtom, noteHistoryInitialShaAtom } from "./note-history-dialog-state"

const PAGE_SIZE = 20

/** How many pages to fetch at most while searching for an `initialSha`. */
const MAX_INITIAL_SHA_PAGES = 10

/** onChange is never called in read-only mode; provided to satisfy the prop. */
const noop = () => {}

type HistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; versions: NoteVersion[]; nextCursor: string | null }

/**
 * Version history for the open note: the note's git commit timeline filtered
 * to commits that actually changed its file, paginated, with a read-only
 * preview of each version. Versions that arrived through a merge's second
 * parent (edits from another device that a newest-wins merge may have
 * replaced) are listed too, labeled distinctly. Restoring is a forward-only
 * save (the old content becomes the newest version) — history is never
 * rewritten.
 */
export function NoteHistoryDialog({
  noteId,
  currentContent,
  onRestore,
  initialSha,
}: {
  noteId: string
  /** The live editor value, used to disable restoring a version identical to it. */
  currentContent: string
  /**
   * Route the restored content back through the open editor (like the share
   * dialog's onPublish) so it stays in sync; without it, saves directly.
   */
  onRestore?: (content: string) => void
  /**
   * Preselect (and scroll to) this version when the dialog opens, fetching
   * extra pages to find it if needed. Also settable without props via
   * `openNoteHistoryDialogAtom` — the prop takes precedence.
   */
  initialSha?: string | null
}) {
  const [open, setOpen] = useAtom(isNoteHistoryDialogOpenAtom)
  const initialShaFromAtom = useAtomValue(noteHistoryInitialShaAtom)
  const setInitialShaAtom = useSetAtom(noteHistoryInitialShaAtom)
  const saveNote = useSaveNote()

  const targetSha = initialSha ?? initialShaFromAtom

  const [state, setState] = React.useState<HistoryState>({ status: "loading" })
  const [isLoadingMore, setIsLoadingMore] = React.useState(false)
  const [selectedSha, setSelectedSha] = React.useState<string | null>(null)
  const [initialShaMissing, setInitialShaMissing] = React.useState(false)
  const [preview, setPreview] = React.useState<{ sha: string; content: string | null } | null>(null)
  const [isConfirmingRestore, setIsConfirmingRestore] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const copiedTimeoutRef = React.useRef<number | null>(null)

  const filepath = `${noteId}.md`

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      // A stale target must not re-apply the next time the dialog opens from
      // the menu or the palette.
      if (!nextOpen) setInitialShaAtom(null)
    },
    [setOpen, setInitialShaAtom],
  )

  // Load the first page (walking deeper if an initial version is requested)
  // each time the dialog opens. The walk is cached keyed by HEAD, so reopening
  // without new commits is instant, and a sync in between invalidates
  // naturally.
  React.useEffect(() => {
    if (!open || !noteId) return

    let cancelled = false
    setState({ status: "loading" })
    setSelectedSha(null)
    setPreview(null)
    setIsConfirmingRestore(false)
    setInitialShaMissing(false)

    async function load() {
      let page = await listNoteVersions({ filepath, limit: PAGE_SIZE })
      let versions = page.versions
      let nextCursor = page.nextCursor

      // Walk extra pages (bounded) until the requested version is on the list.
      if (targetSha) {
        let pagesFetched = 1
        while (
          !versions.some((v) => v.sha === targetSha) &&
          nextCursor &&
          pagesFetched < MAX_INITIAL_SHA_PAGES
        ) {
          page = await listNoteVersions({ filepath, cursor: nextCursor, limit: PAGE_SIZE })
          versions = [...versions, ...page.versions]
          nextCursor = page.nextCursor
          pagesFetched++
        }
      }

      if (cancelled) return
      const found = targetSha ? versions.some((v) => v.sha === targetSha) : false
      setState({ status: "ready", versions, nextCursor })
      setSelectedSha(found ? targetSha : (versions[0]?.sha ?? null))
      setInitialShaMissing(Boolean(targetSha) && !found)
    }

    load().catch((error) => {
      if (cancelled) return
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to load history",
      })
    })

    return () => {
      cancelled = true
    }
  }, [open, noteId, filepath, targetSha])

  // Load the selected version's content for the preview.
  React.useEffect(() => {
    if (!open || state.status !== "ready" || !selectedSha) return
    const version = state.versions.find((v) => v.sha === selectedSha)
    if (!version) return

    setIsConfirmingRestore(false)

    // A deletion commit has no content to preview.
    if (version.oid === null) {
      setPreview({ sha: version.sha, content: null })
      return
    }

    let cancelled = false
    setPreview(null)
    readNoteVersion({ oid: version.oid })
      .then((content) => {
        if (!cancelled) setPreview({ sha: version.sha, content })
      })
      .catch(() => {
        if (!cancelled) setPreview({ sha: version.sha, content: null })
      })

    return () => {
      cancelled = true
    }
  }, [open, state, selectedSha])

  const showMore = React.useCallback(async () => {
    if (state.status !== "ready" || !state.nextCursor || isLoadingMore) return
    setIsLoadingMore(true)
    try {
      const page = await listNoteVersions({
        filepath,
        cursor: state.nextCursor,
        limit: PAGE_SIZE,
      })
      setState({
        status: "ready",
        versions: [...state.versions, ...page.versions],
        nextCursor: page.nextCursor,
      })
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to load history",
      })
    } finally {
      setIsLoadingMore(false)
    }
  }, [state, filepath, isLoadingMore])

  const previewContent =
    preview && preview.sha === selectedSha && preview.content !== null ? preview.content : null

  const handleRestore = React.useCallback(() => {
    if (previewContent === null || !noteId) return
    if (onRestore) {
      onRestore(previewContent)
    } else {
      saveNote({ id: noteId, content: previewContent })
    }
    setIsConfirmingRestore(false)
    handleOpenChange(false)
  }, [previewContent, noteId, onRestore, saveNote, handleOpenChange])

  const handleCopy = React.useCallback(() => {
    if (previewContent === null) return
    copyAsMarkdown(previewContent)
    setCopied(true)
    if (copiedTimeoutRef.current) window.clearTimeout(copiedTimeoutRef.current)
    copiedTimeoutRef.current = window.setTimeout(() => setCopied(false), 1000)
  }, [previewContent])

  const restoreDisabled = previewContent === null || previewContent === currentContent

  // The newest first-parent version is the note's current saved state; a
  // merge-side entry can sort above it when the other device's edit is newer.
  const currentVersionIndex =
    state.status === "ready" ? state.versions.findIndex((v) => !v.mergeSide) : -1

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content title="History" className="max-w-2xl!" aria-describedby={undefined}>
        {state.status === "loading" ? (
          <div className="flex items-center gap-2 text-text-secondary">
            <LoadingIcon16 />
            Loading history…
          </div>
        ) : state.status === "error" ? (
          <p className="text-text-secondary">Couldn’t load history: {state.message}</p>
        ) : state.versions.length === 0 ? (
          <p className="text-text-secondary">
            No history yet — this note hasn’t been saved to git.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {initialShaMissing ? (
              <p className="text-sm leading-4 text-text-secondary">
                Version not found in recent history — showing the latest versions.
              </p>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
              <div
                className="flex flex-col gap-1 sm:max-h-[55vh] sm:overflow-auto"
                role="listbox"
                aria-label="Versions"
              >
                {state.versions.map((version, index) => (
                  <VersionListItem
                    key={version.sha}
                    version={version}
                    isCurrent={index === currentVersionIndex}
                    isSelected={version.sha === selectedSha}
                    onSelect={() => setSelectedSha(version.sha)}
                  />
                ))}
                {state.nextCursor ? (
                  <Button size="small" onClick={showMore} disabled={isLoadingMore}>
                    {isLoadingMore ? <LoadingIcon16 /> : "Show more"}
                  </Button>
                ) : (
                  <span className="p-2 text-center text-sm text-text-tertiary">
                    No earlier versions
                  </span>
                )}
              </div>

              <div className="flex min-w-0 flex-col gap-3">
                <div className="card-1 bg-bg-overlay! min-h-24 overflow-auto p-3 sm:max-h-[45vh]">
                  {selectedSha === null ? (
                    <p className="text-text-secondary">Select a version to preview it.</p>
                  ) : preview === null || preview.sha !== selectedSha ? (
                    <div className="flex items-center gap-2 text-text-secondary">
                      <LoadingIcon16 />
                      Loading version…
                    </div>
                  ) : preview.content === null ? (
                    <p className="italic text-text-secondary">
                      The file was deleted in this version.
                    </p>
                  ) : (
                    <BlockNoteEditor
                      key={preview.sha}
                      value={preview.content}
                      onChange={noop}
                      readOnly
                    />
                  )}
                </div>

                {isConfirmingRestore ? (
                  <div className="card-1 flex flex-wrap items-center justify-between gap-2 p-2 pl-3">
                    <span className="text-sm leading-4 text-text-secondary">
                      This saves the old version as the newest — nothing in history is lost.
                    </span>
                    <span className="flex items-center gap-2">
                      <Button size="small" onClick={() => setIsConfirmingRestore(false)}>
                        Cancel
                      </Button>
                      <Button size="small" variant="primary" onClick={handleRestore}>
                        Restore
                      </Button>
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button onClick={handleCopy} disabled={previewContent === null}>
                      {copied ? (
                        <>
                          <CheckIcon16 />
                          Copied
                        </>
                      ) : (
                        <>
                          <CopyIcon16 />
                          Copy markdown
                        </>
                      )}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={restoreDisabled}
                      onClick={() => setIsConfirmingRestore(true)}
                    >
                      Restore this version
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </Dialog.Content>
    </Dialog>
  )
}

function formatVersionTimestamp(timestamp: number) {
  const date = new Date(timestamp * 1000)
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return `${formatDate(toDateString(date), { excludeDayOfWeek: true })} · ${time}`
}

function VersionListItem({
  version,
  isCurrent,
  isSelected,
  onSelect,
}: {
  version: NoteVersion
  isCurrent: boolean
  isSelected: boolean
  onSelect: () => void
}) {
  const ref = React.useRef<HTMLButtonElement>(null)

  // Keep the selected version visible — matters when an `initialSha` deep in
  // the list is preselected on open.
  React.useEffect(() => {
    if (isSelected) {
      ref.current?.scrollIntoView?.({ block: "nearest" })
    }
  }, [isSelected])

  const dateString = toDateString(new Date(version.timestamp * 1000))
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={isSelected}
      className={cx(
        "focus-ring flex flex-col gap-1 rounded p-2 text-left",
        isSelected ? "bg-bg-secondary" : "hover:bg-bg-hover active:bg-bg-active",
      )}
      onClick={onSelect}
    >
      <span className="flex w-full items-center justify-between gap-2 leading-4">
        <span className="truncate">{formatDateDistance(dateString)}</span>
        {isCurrent ? (
          <span className="rounded-sm bg-bg-secondary px-1 text-xs leading-4 text-text-secondary">
            Current
          </span>
        ) : null}
      </span>
      <span className="flex w-full items-center justify-between gap-2 text-xs leading-4 text-text-secondary">
        <span className="truncate">{formatVersionTimestamp(version.timestamp)}</span>
        <VersionDiffSummary version={version} />
      </span>
      {version.mergeSide ? (
        <span className="text-xs italic leading-4 text-text-secondary">
          Merged from another device
        </span>
      ) : null}
    </button>
  )
}

// Diff summaries are computed lazily (only for rendered versions) and cached
// by blob oid pair, which is stable across dialog opens and syncs.
const summaryCache = new Map<string, LineDiffSummary>()

function VersionDiffSummary({ version }: { version: NoteVersion }) {
  const cacheKey = `${version.parentOid ?? ""}:${version.oid ?? ""}`
  const [summary, setSummary] = React.useState<LineDiffSummary | null>(
    () => summaryCache.get(cacheKey) ?? null,
  )

  React.useEffect(() => {
    const cached = summaryCache.get(cacheKey)
    if (cached) {
      setSummary(cached)
      return
    }

    let cancelled = false
    Promise.all([
      version.parentOid ? readNoteVersion({ oid: version.parentOid }) : Promise.resolve(""),
      version.oid ? readNoteVersion({ oid: version.oid }) : Promise.resolve(""),
    ])
      .then(([before, after]) => {
        const result = diffLineCounts(before, after)
        summaryCache.set(cacheKey, result)
        if (!cancelled) setSummary(result)
      })
      .catch(() => {
        // Leave the summary blank; the list stays usable without it.
      })

    return () => {
      cancelled = true
    }
  }, [cacheKey, version.parentOid, version.oid])

  if (!summary) return null

  return (
    <span
      className="shrink-0 font-mono"
      title={summary.approximate ? "Approximate line change counts" : undefined}
    >
      <span className="text-text-success">+{summary.added}</span>{" "}
      <span className="text-text-danger">
        −{summary.removed}
        {summary.approximate ? "≈" : ""}
      </span>
    </span>
  )
}
