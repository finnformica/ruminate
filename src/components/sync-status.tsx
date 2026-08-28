import { useAtomValue } from "jotai"
import { selectAtom } from "jotai/utils"
import { useNetworkState } from "react-use"
import { globalStateMachineAtom, isRepoClonedAtom, syncErrorAtom } from "../global-state"
import { cx } from "../utils/cx"
import { sessionStatusAtom } from "../utils/github-session"
import { syncErrorLabel } from "../utils/sync"
import { CheckFillIcon16, ErrorFillIcon16, LoadingFillIcon16 } from "./icons"

export const isSyncingAtom = selectAtom(
  globalStateMachineAtom,
  (state) =>
    state.matches("signedIn.cloned.sync.pulling") ||
    state.matches("signedIn.cloned.sync.pushing") ||
    state.matches("signedIn.cloned.sync.checkingStatus"),
)

const isSyncErrorAtom = selectAtom(globalStateMachineAtom, (state) =>
  state.matches("signedIn.cloned.sync.error"),
)

/**
 * Bottom-left status. GitHub session state (expired / expiring) is layered over
 * the git sync state, because a dead sign-in is what the user must act on first.
 * Labels stay short (like "Synced"); the fuller explanation is in the tooltip
 * (see `useSyncStatusMeta`).
 */
export function useSyncStatusText() {
  const isSyncing = useAtomValue(isSyncingAtom)
  const isSyncError = useAtomValue(isSyncErrorAtom)
  const syncError = useAtomValue(syncErrorAtom)
  const isRepoCloned = useAtomValue(isRepoClonedAtom)
  const session = useAtomValue(sessionStatusAtom)
  const { online } = useNetworkState()

  if (!isRepoCloned || !online) return null

  if (session === "expired") return <span className="text-text-danger">Signed out</span>
  if (isSyncing) return "Syncing…"
  if (session === "expiring") return <span className="text-text-pending">Sign in soon</span>
  if (isSyncError) {
    return (
      <span className="text-text-danger">
        {syncError ? syncErrorLabel(syncError.category) : "Sync failed"}
      </span>
    )
  }

  return "Synced"
}

export function SyncStatusIcon({ className }: { className?: string }) {
  const isSyncing = useAtomValue(isSyncingAtom)
  const isSyncError = useAtomValue(isSyncErrorAtom)
  const isRepoCloned = useAtomValue(isRepoClonedAtom)
  const session = useAtomValue(sessionStatusAtom)
  const { online } = useNetworkState()

  if (!isRepoCloned || !online) return null

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
 * already sends SYNC); otherwise the button triggers a sync. */
export function useSyncStatusMeta(): { tooltip?: string; needsReauth: boolean } {
  const session = useAtomValue(sessionStatusAtom)
  const isSyncError = useAtomValue(isSyncErrorAtom)
  const syncError = useAtomValue(syncErrorAtom)
  if (session === "expired") {
    return { tooltip: "GitHub session expired — click to sign in", needsReauth: true }
  }
  if (session === "expiring") {
    return { tooltip: "GitHub sign-in expiring — click to re-authenticate", needsReauth: true }
  }
  if (isSyncError && syncError) {
    return { tooltip: `${syncError.message} — click to retry`, needsReauth: false }
  }
  return { tooltip: undefined, needsReauth: false }
}
