import { atom } from "jotai"

/**
 * Read-only diagnostics for the database storage runtime, shown in the
 * Settings → Storage panel. Written by `database-mode.ts` (the local store
 * lifecycle) and `replica-sync.ts` (the D1 push loop).
 */

/** The D1 replica's row counts + cursor, from `GET /api/replica/status`. */
interface ReplicaRemoteStatus {
  notes: number
  blocks: number
  links: number
  viewState: number
  cursor: string | null
  fetchedAt: number
}

/** Write-behind replication to the D1 database, maintained by `replica-sync.ts`. */
export interface ReplicaDiagnostics {
  lastPushAt: number | null
  /** Notes included in the last successful push. */
  lastPushNotes: number
  pendingNotes: number
  pendingDeletes: number
  /** A full-corpus push is queued or being retried. */
  fullPushPending: boolean
  /** Cursor sent with the last successful push; confirmed once the status
   * endpoint echoes it back. */
  cursor: string | null
  cursorConfirmed: boolean
  lastError: { message: string; at: number } | null
  errorCount: number
  remote: ReplicaRemoteStatus | null
}

export interface StorageDiagnostics {
  status: "off" | "opening" | "ready" | "error"
  /** "opfs" = persisted; "memory" = this session only (OPFS unavailable). */
  persistence: "opfs" | "memory" | null
  /** Notes currently served by the local store. */
  notes: number
  /** SQL-side write failures (the files atom and the push queue still carried
   * the content) (last few). */
  writeErrors: { message: string; at: number }[]
  writeErrorCount: number
  /** D1 replication state; null until the push loop has started. */
  replica: ReplicaDiagnostics | null
}

export const OFF_STORAGE_DIAGNOSTICS: StorageDiagnostics = {
  status: "off",
  persistence: null,
  notes: 0,
  writeErrors: [],
  writeErrorCount: 0,
  replica: null,
}

export const storageDiagnosticsAtom = atom<StorageDiagnostics>(OFF_STORAGE_DIAGNOSTICS)
