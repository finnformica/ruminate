import { Link } from "@tanstack/react-router"
import { useAtom, useAtomValue } from "jotai"
import { dismissedMergeNoticeIdsAtom, mergeNoticesAtom } from "../global-state"
import { Button } from "./button"
import { ErrorIcon16 } from "./icons"

/**
 * Non-blocking, dismissible banner shown when a pull merged genuinely
 * conflicting edits: the newest version won in place, and the losing version
 * was preserved as a linked conflicted-copy note. Follows the storage-warning
 * banner's pattern in `_appRoot.tsx`. Dismissal is per-tab (see
 * `dismissedMergeNoticeIdsAtom`); the machine dedupes notices by copy id, so a
 * dismissed notice can never be re-raised.
 */
export function MergeNoticeBanner() {
  const mergeNotices = useAtomValue(mergeNoticesAtom)
  const [dismissedIds, setDismissedIds] = useAtom(dismissedMergeNoticeIdsAtom)

  const visibleNotices = mergeNotices.filter((notice) => !dismissedIds.includes(notice.copyId))
  if (visibleNotices.length === 0) return null

  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-border-secondary px-4 py-2 text-text-pending">
      <div className="grid h-6 shrink-0 place-items-center">
        <ErrorIcon16 />
      </div>
      <div className="flex grow flex-col gap-1 pt-0.5 leading-5">
        {visibleNotices.map((notice) => (
          <span key={notice.copyId}>
            Sync merged conflicting edits on <span className="font-bold">{notice.noteId}</span> —
            kept the newest version; the other copy is in{" "}
            <Link
              to="/notes/$"
              params={{ _splat: notice.copyId }}
              search={{ query: undefined }}
              className="underline underline-offset-2"
            >
              {notice.copyId}
            </Link>
            .
          </span>
        ))}
      </div>
      <Button
        size="small"
        className="shrink-0"
        onClick={() =>
          setDismissedIds((previous) => [
            ...previous,
            ...visibleNotices.map((notice) => notice.copyId),
          ])
        }
      >
        Dismiss
      </Button>
    </div>
  )
}
