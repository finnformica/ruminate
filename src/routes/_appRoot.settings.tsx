import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useAtom, useAtomValue } from "jotai"
import { useEffect } from "react"
import { useNetworkState } from "react-use"
import { DEFAULT_NEW_BLOCK_MARKER } from "../blocks/markers"
import { Button } from "../components/button"
import { useSignOut } from "../components/github-auth"
import { GitHubAvatar } from "../components/github-avatar"
import { SettingsIcon16 } from "../components/icons"
import { PageLayout } from "../components/page-layout"
import { TextInput } from "../components/text-input"
import {
  databaseModeStatusAtom,
  refreshDatabaseReplicaStatus,
  requestDatabaseFullPush,
  type DatabaseModeStatus,
} from "../data/database-mode"
import {
  storageDiagnosticsAtom,
  type ReplicaDiagnostics,
  type StorageDiagnostics,
} from "../data/storage-diagnostics"
import { MAX_EXPANDED_LEVELS, MIN_EXPANDED_LEVELS } from "../blocks/default-collapsed"
import {
  AccentColor,
  accentAtom,
  expandedLevelsAtom,
  githubUserAtom,
  newBlockMarkerAtom,
} from "../global-state"
import { cx } from "../utils/cx"

export const Route = createFileRoute("/_appRoot/settings")({
  component: RouteComponent,
  head: () => ({
    meta: [{ title: "Settings · Ruminate" }],
  }),
})

function RouteComponent() {
  return (
    <PageLayout title="Settings" icon={<SettingsIcon16 />} disableGuard>
      <div className="p-4 pb-6">
        <div className="mx-auto flex max-w-xl flex-col gap-6">
          <AppearanceSection />
          <EditorSection />
          <StorageSection />
          <GitHubSection />
          <div className="flex flex-col items-center gap-1 self-center p-5 text-center text-text-tertiary">
            <span className="text-sm">
              Made by{" "}
              <a
                className="link decoration-text-tertiary"
                href="https://github.com/finnformica"
                target="_blank"
                rel="noopener noreferrer"
              >
                Finn Formica
              </a>
            </span>
            <span className="text-sm">
              Built on{" "}
              <a
                className="link decoration-text-tertiary"
                href="https://github.com/lumen-notes/lumen"
                target="_blank"
                rel="noopener noreferrer"
              >
                Lumen
              </a>{" "}
              by{" "}
              <a
                className="link decoration-text-tertiary"
                href="https://colebemis.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                Cole Bemis
              </a>{" "}
              &amp; contributors
            </span>
          </div>
        </div>
      </div>
    </PageLayout>
  )
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-bold leading-4">{title}</h3>
      <div className="card-1 p-4">{children}</div>
    </div>
  )
}

/** Each option's swatch shows its ramp's solid step 9 (the checked-checkbox
 * color). The ramps themselves adapt to light/dark via radix-colors.css. */
const ACCENT_OPTIONS: Array<{ value: AccentColor; label: string; swatchColor: string }> = [
  { value: "neutral", label: "Neutral", swatchColor: "var(--sand-9)" },
  { value: "cyan", label: "Cyan", swatchColor: "var(--cyan-9)" },
  { value: "green", label: "Green", swatchColor: "var(--green-9)" },
  { value: "violet", label: "Violet", swatchColor: "var(--violet-9)" },
  { value: "amber", label: "Amber", swatchColor: "var(--amber-9)" },
]

function AppearanceSection() {
  const [accent, setAccent] = useAtom(accentAtom)

  return (
    <SettingsSection title="Appearance">
      <div className="flex flex-col gap-2">
        <span id="accent-color-label" className="text-sm leading-4 text-text-secondary">
          Accent color
        </span>
        <div role="group" aria-labelledby="accent-color-label" className="flex flex-wrap gap-1">
          {ACCENT_OPTIONS.map((option) => {
            const isSelected = accent === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-label={option.label}
                aria-pressed={isSelected}
                title={option.label}
                onClick={() => setAccent(option.value)}
                className="focus-ring flex h-8 w-8 items-center justify-center rounded hover:bg-bg-hover active:bg-bg-active coarse:h-10 coarse:w-10"
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    "h-4 w-4 rounded-full",
                    isSelected &&
                      "ring-2 ring-[var(--color-text)] ring-offset-2 ring-offset-bg-card",
                  )}
                  style={{ backgroundColor: option.swatchColor }}
                />
              </button>
            )
          })}
        </div>
        <span className="text-sm leading-5 text-text-secondary">
          {ACCENT_OPTIONS.find((option) => option.value === accent)?.label}
        </span>
      </div>
    </SettingsSection>
  )
}

/** Quick picks for the new-block marker; anything else can be typed in. */
const NEW_BLOCK_MARKER_PRESETS: Array<{ value: string; label: string }> = [
  { value: DEFAULT_NEW_BLOCK_MARKER, label: "Bullet" },
  { value: "", label: "Paragraph" },
  { value: "[ ] ", label: "To-do" },
  { value: "> ", label: "Quote" },
]

function EditorSection() {
  const [newBlockMarker, setNewBlockMarker] = useAtom(newBlockMarkerAtom)
  const [expandedLevels, setExpandedLevels] = useAtom(expandedLevelsAtom)

  return (
    <SettingsSection title="Editor">
      <div className="flex flex-col gap-2">
        <label htmlFor="expanded-levels" className="text-sm leading-4 text-text-secondary">
          Default expand
        </label>
        <div className="flex items-center gap-3">
          <input
            id="expanded-levels"
            type="range"
            min={MIN_EXPANDED_LEVELS}
            max={MAX_EXPANDED_LEVELS}
            step={1}
            value={expandedLevels}
            onChange={(event) => setExpandedLevels(Number(event.target.value))}
            className="focus-ring h-2 w-full max-w-64 cursor-pointer accent-[var(--color-border-focus)]"
          />
          <span className="w-6 tabular-nums" aria-live="polite">
            {expandedLevels}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="new-block-marker" className="text-sm leading-4 text-text-secondary">
          New block markdown
        </label>
        <TextInput
          id="new-block-marker"
          className="font-mono"
          value={newBlockMarker}
          placeholder="(none)"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setNewBlockMarker(event.target.value)}
        />
        <div role="group" aria-label="New block markdown presets" className="flex flex-wrap gap-1">
          {NEW_BLOCK_MARKER_PRESETS.map((preset) => {
            const isSelected = newBlockMarker === preset.value
            return (
              <Button
                key={preset.label}
                size="small"
                aria-pressed={isSelected}
                onClick={() => setNewBlockMarker(preset.value)}
                className={cx(isSelected && "ring-1 ring-inset ring-border-focus")}
              >
                {preset.label}
                {preset.value ? (
                  <span className="ml-1 font-mono text-text-secondary">{preset.value.trim()}</span>
                ) : null}
              </Button>
            )
          })}
        </div>
      </div>
    </SettingsSection>
  )
}

function StorageSection() {
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
    <div className="mt-4 flex flex-col gap-2 border-t border-border-secondary pt-4 text-sm leading-5">
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
      <Button className="self-start" onClick={() => requestDatabaseFullPush()}>
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

function GitHubSection() {
  const navigate = useNavigate()
  const githubUser = useAtomValue(githubUserAtom)
  const signOut = useSignOut()
  const { online } = useNetworkState()

  if (!githubUser) {
    return (
      <SettingsSection title="GitHub">
        <div className="text-text-secondary">You're not signed in</div>
      </SettingsSection>
    )
  }

  // GitHub is identity only — no repository backs the notes.
  return (
    <SettingsSection title="GitHub">
      <div className="flex items-center justify-between gap-4">
        <div className="flex w-0 grow flex-col gap-1">
          <span className="text-sm leading-4 text-text-secondary">Account</span>
          <span className="flex items-center gap-2 leading-4">
            {online ? <GitHubAvatar login={githubUser.login} size={16} /> : null}
            <span className="truncate">{githubUser.login}</span>
          </span>
          <span className="truncate text-sm leading-5 text-text-secondary">{githubUser.email}</span>
        </div>
        <Button
          className="shrink-0"
          onClick={() => {
            signOut()
            navigate({ to: "/", search: { query: undefined } })
          }}
        >
          Sign out
        </Button>
      </div>
    </SettingsSection>
  )
}
