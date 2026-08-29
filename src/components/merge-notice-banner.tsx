import { useNavigate } from "@tanstack/react-router"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { dismissedMergeNoticeIdsAtom, isDatabaseModeAtom, mergeNoticesAtom } from "../global-state"
import { mergeNoticeKey } from "../utils/git"
import { Notice } from "./notice"
import { openNoteHistoryDialogAtom } from "./note-history-dialog-state"

/**
 * Non-blocking, dismissible banner shown when a pull merged genuinely
 * conflicting edits: the newest version won in place, and the losing version
 * stays reachable in the note's history. "View previous version" opens the
 * note with its History panel preselected on the losing version, where the
 * user can view it and restore it if wanted. Renders through the shared
 * `Notice` surface, in the same app-strip placement as the storage-warning
 * notice in `_appRoot.tsx`. Dismissal is per-tab (see
 * `dismissedMergeNoticeIdsAtom`); the machine dedupes notices by the same key,
 * so a dismissed notice can never be re-raised.
 */
export function MergeNoticeBanner() {
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const mergeNotices = useAtomValue(mergeNoticesAtom)
  const [dismissedIds, setDismissedIds] = useAtom(dismissedMergeNoticeIdsAtom)
  const openNoteHistoryDialog = useSetAtom(openNoteHistoryDialogAtom)
  const navigate = useNavigate()

  // Merge notices come from git pulls, and their "view previous version"
  // action opens git history — both git-mode concepts. Database mode is
  // last-writer-wins and never raises them (the machine never pulls), so the
  // banner is structurally git-mode-only; this guard makes that explicit.
  if (isDatabaseMode) return null

  const visibleNotices = mergeNotices.filter(
    (notice) => !dismissedIds.includes(mergeNoticeKey(notice)),
  )
  if (visibleNotices.length === 0) return null

  return (
    <div className="shrink-0 border-b border-border-secondary p-2">
      <Notice
        tone="warning"
        onDismiss={() =>
          setDismissedIds((previous) => [...previous, ...visibleNotices.map(mergeNoticeKey)])
        }
      >
        <span className="flex flex-col gap-1">
          {visibleNotices.map((notice) => (
            <span key={mergeNoticeKey(notice)}>
              Sync merged conflicting edits on <span className="font-bold">{notice.noteId}</span> —
              kept the newest version.{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => {
                  // The dialog is mounted by the note page, so navigate there
                  // first; the open-at-version atoms survive the route change.
                  navigate({
                    to: "/notes/$",
                    params: { _splat: notice.noteId },
                    search: { query: undefined },
                  })
                  openNoteHistoryDialog({
                    sha: notice.losingSha,
                    oid: notice.losingOid ?? undefined,
                  })
                }}
              >
                View previous version
              </button>
            </span>
          ))}
        </span>
      </Notice>
    </div>
  )
}
