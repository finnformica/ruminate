import { atom, useAtomValue } from "jotai"
import { useNetworkState } from "react-use"
import { databaseModeStatusAtom } from "../data/database-mode"
import { storageDiagnosticsAtom } from "../data/storage-diagnostics"
import { isDatabaseModeAtom } from "../global-state"
import { cx } from "../utils/cx"
import { sessionStatusAtom } from "../utils/github-session"
import { CheckFillIcon16, ErrorFillIcon16, LoadingFillIcon16, OfflineIcon16 } from "./icons"

/**
 * "Actively syncing": a D1 pull in flight, or replica pushes queued/pending
 * (so a save shows as syncing until its push lands). Raw: offline, the
 * pending pushes wait for the network and this stays true — read it through
 * `syncStatusKind`, which puts "offline" first.
 */
const isSyncingAtom = atom((get) => {
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

export type SyncStatusKind =
  | "hidden"
  | "offline"
  | "signed-out"
  | "syncing"
  | "expiring"
  | "failed"
  | "synced"

/** The inputs the sidebar's sync status is read from. */
export interface SyncStatusState {
  isDatabaseMode: boolean
  online: boolean
  session: "active" | "expiring" | "expired" | string
  isSyncing: boolean
  isSyncError: boolean
}

/**
 * The one reading of the sync state, in the order the reader must notice it:
 *
 * - `hidden`: signed out — the sample notes have no sync to speak of.
 * - `offline`: the browser has no network. Nothing is failing: edits are
 *   saved on this device and the runtime waits for the `online` event
 *   (`replica-sync.ts`, `database-mode.ts`), so an error left over from
 *   before the network went is not the news. Read before the session, since
 *   a re-sign-in cannot happen offline either.
 * - `signed-out`: the GitHub session is dead — what the user must act on
 *   first, whatever the sync is doing.
 * - `syncing`: a pull in flight or pushes pending. Hides a stale error, which
 *   either clears or comes back.
 * - `expiring`: the sign-in is about to expire.
 * - `failed`: the last push or pull failed, with the network up.
 * - `synced`: nothing pending, nothing wrong.
 *
 * Pure, so the sidebar row, the nav-bar badge, the note header's "Saving…"
 * trace (`isSaveInFlight`) and their tests share it.
 */
export function syncStatusKind(state: SyncStatusState): SyncStatusKind {
  if (!state.isDatabaseMode) return "hidden"
  if (!state.online) return "offline"
  if (state.session === "expired") return "signed-out"
  if (state.isSyncing) return "syncing"
  if (state.session === "expiring") return "expiring"
  if (state.isSyncError) return "failed"
  return "synced"
}

/** What the sync status needs the reader to notice, if anything: `danger`
 * (signed out, or the last sync failed) or `pending` (sign-in expiring soon).
 * Offline is quiet — it is a fact about the device, not something to fix. */
export function attentionTone(state: SyncStatusState): "danger" | "pending" | null {
  switch (syncStatusKind(state)) {
    case "signed-out":
    case "failed":
      return "danger"
    case "expiring":
      return "pending"
    default:
      return null
  }
}

/**
 * Whether a note's header shows its "Saving…" trace: pushes in flight, or a
 * save just dispatched (`pendingSave`, ahead of the debounced push) where a
 * push can land. Offline, or signed out, the pending pushes wait for the
 * network or the sign-in — nothing is in flight, and the sidebar's status
 * says why — so the trace would spin without end over an edit that was saved
 * on this device the moment it was made. Read through `syncStatusKind`, so
 * the trace shows exactly when the sidebar reads "Syncing…" (plus the
 * dispatch-to-push moment).
 */
export function isSaveInFlight(kind: SyncStatusKind, pendingSave: boolean): boolean {
  switch (kind) {
    case "syncing":
      return true
    case "synced":
    case "expiring":
    case "failed":
      return pendingSave
    case "hidden":
    case "offline":
    case "signed-out":
      return false
  }
}

function useSyncStatusState(): SyncStatusState {
  const isSyncing = useAtomValue(isSyncingAtom)
  const isSyncError = useAtomValue(isSyncErrorAtom)
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const session = useAtomValue(sessionStatusAtom)
  const { online } = useNetworkState()
  return { isDatabaseMode, online: online !== false, session, isSyncing, isSyncError }
}

/** The sync status' one reading, live (see `syncStatusKind`). */
export function useSyncStatusKind(): SyncStatusKind {
  return syncStatusKind(useSyncStatusState())
}

/** The sync status' attention tone, live (see `attentionTone`). */
export function useAttentionTone(): "danger" | "pending" | null {
  return attentionTone(useSyncStatusState())
}

/**
 * Bottom-left status. Labels stay short (like "Synced"); the fuller
 * explanation is in the tooltip (see `useSyncStatusMeta`).
 */
export function useSyncStatusText() {
  switch (syncStatusKind(useSyncStatusState())) {
    case "hidden":
      return null
    case "offline":
      return "Offline"
    case "signed-out":
      return <span className="text-text-danger">Signed out</span>
    case "syncing":
      return "Syncing…"
    case "expiring":
      return <span className="text-text-pending">Sign in soon</span>
    case "failed":
      return <span className="text-text-danger">Sync failed</span>
    case "synced":
      return "Synced"
  }
}

export function SyncStatusIcon({ className }: { className?: string }) {
  switch (syncStatusKind(useSyncStatusState())) {
    case "hidden":
      return null
    case "offline":
      return <OfflineIcon16 className={className} />
    case "signed-out":
      return <ErrorFillIcon16 className={cx("text-text-danger", className)} />
    case "syncing":
      return <LoadingFillIcon16 className={cx("text-text-pending", className)} />
    case "expiring":
      return <ErrorFillIcon16 className={cx("text-text-pending", className)} />
    case "failed":
      return <ErrorFillIcon16 className={cx("text-text-danger", className)} />
    case "synced":
      return <CheckFillIcon16 className={cx("text-text-success", className)} />
  }
}

/** Tooltip + click intent for the status row: an expired/expiring session
 * re-authenticates (`reauth`); a sync error shows its detail and a click
 * retries (`pull` — the row already triggers a pull); offline there is
 * nothing a click could do, so the row is not a button at all (`null`). */
export function useSyncStatusMeta(): { tooltip?: string; action: "reauth" | "pull" | null } {
  const state = useSyncStatusState()
  const databaseStatus = useAtomValue(databaseModeStatusAtom)
  const replica = useAtomValue(storageDiagnosticsAtom).replica

  switch (syncStatusKind(state)) {
    case "offline":
      return {
        tooltip: "Notes are saved on this device and will sync when you're back online",
        action: null,
      }
    case "signed-out":
      return { tooltip: "GitHub session expired — click to sign in", action: "reauth" }
    case "expiring":
      return { tooltip: "GitHub sign-in expiring — click to re-authenticate", action: "reauth" }
    case "failed": {
      const message = databaseStatus.lastPullError ?? replica?.lastError?.message ?? "Sync failed"
      return { tooltip: `${message} — click to retry`, action: "pull" }
    }
    default:
      return { tooltip: undefined, action: "pull" }
  }
}
