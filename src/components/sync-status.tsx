import { atom, useAtomValue } from "jotai"
import { useNetworkState } from "react-use"
import { databaseModeStatusAtom } from "../data/database-mode"
import { storageDiagnosticsAtom } from "../data/storage-diagnostics"
import { isDatabaseModeAtom } from "../global-state"
import { cx } from "../utils/cx"
import { sessionStatusAtom } from "../utils/github-session"
import { CheckFillIcon16, ErrorFillIcon16, LoadingFillIcon16 } from "./icons"

/**
 * "Actively syncing": a D1 pull in flight, or replica pushes queued/pending
 * (so a save shows as syncing until its push lands).
 */
export const isSyncingAtom = atom((get) => {
  const pull = get(databaseModeStatusAtom).pull
  const replica = get(storageDiagnosticsAtom).replica
  return (
    pull === "pulling" ||
    (replica !== null &&
      (replica.pendingNotes > 0 || replica.pendingDeletes > 0 || replica.fullPushPending))
  )
})

/** Sync failed: a replica push or D1 pull error (both self-clear on the next
 * success). */
const isSyncErrorAtom = atom((get) => {
  const status = get(databaseModeStatusAtom)
  const replica = get(storageDiagnosticsAtom).replica
  return status.pull === "error" || (replica?.lastError ?? null) !== null
})

/**
 * Bottom-left status. GitHub session state (expired / expiring) is layered over
 * the sync state, because a dead sign-in is what the user must act on first.
 * Labels stay short (like "Synced"); the fuller explanation is in the tooltip
 * (see `useSyncStatusMeta`).
 */
export function useSyncStatusText() {
  const isSyncing = useAtomValue(isSyncingAtom)
  const isSyncError = useAtomValue(isSyncErrorAtom)
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const session = useAtomValue(sessionStatusAtom)
  const { online } = useNetworkState()

  if (!isDatabaseMode || !online) return null

  if (session === "expired") return <span className="text-text-danger">Signed out</span>
  if (isSyncing) return "Syncing…"
  if (session === "expiring") return <span className="text-text-pending">Sign in soon</span>
  if (isSyncError) return <span className="text-text-danger">Sync failed</span>

  return "Synced"
}

export function SyncStatusIcon({ className }: { className?: string }) {
  const isSyncing = useAtomValue(isSyncingAtom)
  const isSyncError = useAtomValue(isSyncErrorAtom)
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const session = useAtomValue(sessionStatusAtom)
  const { online } = useNetworkState()

  if (!isDatabaseMode || !online) return null

  if (session === "expired")
    return <ErrorFillIcon16 className={cx("text-text-danger", className)} />
  if (isSyncing) return <LoadingFillIcon16 className={cx("text-text-pending", className)} />
  if (session === "expiring")
    return <ErrorFillIcon16 className={cx("text-text-pending", className)} />
  if (isSyncError) return <ErrorFillIcon16 className={cx("text-text-danger", className)} />

  return <CheckFillIcon16 className={cx("text-text-success", className)} />
}

/** Tooltip + click intent for the status button: an expired/expiring session
 * re-authenticates; a sync error shows its detail (click retries — the button
 * already triggers a pull); otherwise the button triggers a pull. */
export function useSyncStatusMeta(): { tooltip?: string; needsReauth: boolean } {
  const session = useAtomValue(sessionStatusAtom)
  const isSyncError = useAtomValue(isSyncErrorAtom)
  const databaseStatus = useAtomValue(databaseModeStatusAtom)
  const replica = useAtomValue(storageDiagnosticsAtom).replica

  if (session === "expired") {
    return { tooltip: "GitHub session expired — click to sign in", needsReauth: true }
  }
  if (session === "expiring") {
    return { tooltip: "GitHub sign-in expiring — click to re-authenticate", needsReauth: true }
  }
  if (isSyncError) {
    const message = databaseStatus.lastPullError ?? replica?.lastError?.message ?? "Sync failed"
    return { tooltip: `${message} — click to retry`, needsReauth: false }
  }
  return { tooltip: undefined, needsReauth: false }
}
