import { useAtomValue } from "jotai"
import { useEffect } from "react"
import {
  databaseModeStatusAtom,
  refreshDatabaseReplicaStatus,
  requestDatabaseFullPush,
  type DatabaseModeStatus,
} from "../../data/database-mode"
import {
  storageDiagnosticsAtom,
  type ReplicaDiagnostics,
  type StorageDiagnostics,
} from "../../data/storage-diagnostics"
import { githubUserAtom } from "../../global-state"
import { Button } from "../ui/button"
import { SettingsSection } from "../settings-section"

export function StorageSection() {
  const githubUser = useAtomValue(githubUserAtom)
  const diagnostics = useAtomValue(storageDiagnosticsAtom)
  const modeStatus = useAtomValue(databaseModeStatusAtom)

  return (
    <SettingsSection title="Storage">
      <div className="flex flex-col gap-1">
        <span className="leading-4">Database</span>
        <span className="text-sm leading-5 text-text-secondary">
          Notes live in a local database on this device and sync to the cloud automatically.
        </span>
      </div>
      {githubUser ? (
        <StorageDiagnosticsPanel diagnostics={diagnostics} status={modeStatus} />
      ) : null}
    </SettingsSection>
  )
}

const STORAGE_STATUS_LABELS: Record<StorageDiagnostics["status"], string> = {
  off: "Off",
  opening: "Starting…",
  ready: "Ready",
  error: "Error",
}

function StorageDiagnosticsPanel({
  diagnostics,
  status: modeStatus,
}: {
  diagnostics: StorageDiagnostics
  status: DatabaseModeStatus
}) {
  const { status, persistence, notes, writeErrors, writeErrorCount } = diagnostics

  return (
    <div className="flex flex-col gap-2 border-t border-border-secondary pt-4 text-sm leading-5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-text-secondary [&>dd]:text-right [&>dd]:text-text">
        <dt>Status</dt>
        <dd>
          {STORAGE_STATUS_LABELS[status]}
          {status === "ready" && persistence === "memory"
            ? diagnostics.persistenceReason === "another-tab"
              ? " (in-memory — Ruminate is open in another tab)"
              : " (in-memory — OPFS unavailable)"
            : ""}
        </dd>
        <dt>Notes</dt>
        <dd>{notes}</dd>
        <dt>Write errors</dt>
        <dd className={writeErrorCount > 0 ? "!text-text-danger" : ""}>{writeErrorCount}</dd>
        <dt>Last pull</dt>
        <dd className={modeStatus.pull === "error" ? "!text-text-danger" : ""}>
          {modeStatus.pull === "pulling"
            ? "Pulling…"
            : modeStatus.pull === "error"
              ? "Failed"
              : modeStatus.lastPullAt
                ? new Date(modeStatus.lastPullAt).toLocaleTimeString()
                : "Never"}
        </dd>
      </dl>
      {/* A failed pull can leave the note list empty with no other symptom, so
          the reason is shown rather than only kept in state. */}
      {modeStatus.lastPullError ? (
        <DiagnosticList label="Last pull error">
          <li className="text-text-danger">{modeStatus.lastPullError}</li>
        </DiagnosticList>
      ) : null}
      {diagnostics.replica ? <ReplicaDiagnosticsPanel replica={diagnostics.replica} /> : null}
      {writeErrors.length > 0 ? (
        <DiagnosticList label={`Last write errors (${writeErrors.length})`}>
          {writeErrors.map((writeError, i) => (
            <li key={i}>
              {formatDiagnosticTime(writeError.at)} · {writeError.message}
            </li>
          ))}
        </DiagnosticList>
      ) : null}
    </div>
  )
}

/** Read-only cloud replication status: last push, pending queue, remote row
 * counts — plus the one action, a manual full push. */
function ReplicaDiagnosticsPanel({ replica }: { replica: ReplicaDiagnostics }) {
  // Refresh the remote counts when the panel opens.
  useEffect(() => {
    refreshDatabaseReplicaStatus()
  }, [])

  const pending =
    [
      replica.pendingNotes > 0 ? `${replica.pendingNotes} notes` : null,
      replica.pendingDeletes > 0 ? `${replica.pendingDeletes} deletes` : null,
      replica.fullPushPending ? "full push" : null,
    ]
      .filter(Boolean)
      .join(", ") || "None"

  return (
    <div className="flex flex-col gap-2 border-t border-border-secondary pt-2">
      <span className="text-text-secondary">Cloud sync</span>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-text-secondary [&>dd]:text-right [&>dd]:text-text">
        <dt>Last push</dt>
        <dd>
          {replica.lastPushAt !== null
            ? `${formatDiagnosticTime(replica.lastPushAt)} (${replica.lastPushNotes} notes)`
            : "Never"}
        </dd>
        <dt>Pending</dt>
        <dd>{pending}</dd>
        <dt>Remote rows</dt>
        <dd>
          {replica.remote
            ? `${replica.remote.pages} pages · ${replica.remote.nodes} nodes · ` +
              `${replica.remote.links} links (${formatDiagnosticTime(replica.remote.fetchedAt)})`
            : "—"}
        </dd>
        <dt>Cursor</dt>
        <dd>
          {replica.cursor === null
            ? "—"
            : replica.cursorConfirmed
              ? `${replica.cursor} (confirmed)`
              : replica.cursor}
        </dd>
        <dt>Push errors</dt>
        <dd className={replica.errorCount > 0 ? "!text-text-danger" : ""}>{replica.errorCount}</dd>
      </dl>
      {replica.lastError ? (
        <span className="break-all font-mono text-xs leading-4 text-text-danger">
          {formatDiagnosticTime(replica.lastError.at)} · {replica.lastError.message}
        </span>
      ) : null}
      <Button
        className="self-start"
        loading={replica.fullPushPending}
        onClick={() => requestDatabaseFullPush()}
      >
        Push full copy to the cloud now
      </Button>
    </div>
  )
}

function DiagnosticList({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="text-text-secondary">
      <summary className="cursor-pointer select-none">{label}</summary>
      <ul className="mt-1 flex list-none flex-col gap-1 break-all pl-4 font-mono text-xs leading-4">
        {children}
      </ul>
    </details>
  )
}

function formatDiagnosticTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}
