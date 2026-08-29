import { atom, getDefaultStore } from "jotai"
import { atomWithStorage } from "jotai/utils"
import type { NoteId } from "../schema"
import { LEGACY_VIEW_STATE_PATH, VIEW_STATE_DIR } from "./paths"
import { parseNoteViewState, readNoteViewState } from "./view-state-parse"
import type { ReplicaSyncHandle } from "./replica-sync"
import type { RekeyRecord, SqlNoteStore } from "./sql-note-store"

/**
 * The storage mirror: dual-write + shadow-read of the experimental SQL note
 * store, behind the Settings "database store" toggle (graph storage, phase 2).
 *
 * Git/markdown stays canonical for the whole trial. When the flag is on:
 * - boot: the SQL store is opened lazily (dynamic import — the sqlite wasm
 *   never loads while the flag is off) and populated from the worktree via
 *   `ingestWorktree`, re-keying any cross-note block-id collisions and
 *   persisting the rewrites back through the normal git save path.
 * - writes: every note/view-state write is mirrored into the SQL store right
 *   after it is handed to the git machine (`mirrorFileWrites` /
 *   `mirrorDeleteFile`, called from the `src/data/store.ts` seam). A SQL
 *   failure never blocks or corrupts the git path — it is caught, recorded as
 *   a diagnostic, and repaired by a re-ingest.
 * - shadow-read: every `markdownFilesAtom` update (saves, pulls, refreshes)
 *   triggers a verify pass comparing per-note content between git and SQL.
 *   Content pulled in from another device is reconciled silently; a mismatch
 *   that dual-write should have prevented is recorded as a divergence (and
 *   then healed — git wins). Reads continue to come from the git pipeline;
 *   this phase only proves parity.
 *
 * - replication (phase 3): while the mirror runs, `replica-sync.ts` pushes the
 *   same notes to the D1 replica behind the Worker (write-behind, leader-tab
 *   only, coalesced) — see that module for the design. The mirror only feeds
 *   it: changed/deleted note ids after each successful dual-write and verify
 *   pass, plus a full-corpus push after every ingest.
 *
 * All SQL work runs on one promise queue, so writes and verifies never
 * interleave. Nothing here ever writes to git except the collision re-keys,
 * which go through the caller-supplied `writeNotes` (the normal save path).
 */

export type StorageEngine = "git" | "database"

/** The experimental storage flag (docs/graph-storage.md: `ruminate_storage`).
 * (jotai 2.0.3's `atomWithStorage` seeds from localStorage synchronously on
 * mount, so a saved "database" value starts the mirror on the first commit of
 * the app root — no `getOnInit` needed or available at this version.) */
export const storageEngineAtom = atomWithStorage<StorageEngine>("ruminate_storage", "git")

export interface StorageDivergence {
  noteId: NoteId
  kind: "mismatch" | "missing-in-sql" | "extra-in-sql"
  at: number
}

interface StorageWriteError {
  message: string
  at: number
}

interface StorageRekey extends RekeyRecord {
  at: number
}

/** The D1 replica's row counts + cursor, from `GET /api/replica/status`. */
interface ReplicaRemoteStatus {
  notes: number
  blocks: number
  links: number
  viewState: number
  cursor: string | null
  fetchedAt: number
}

/** Write-behind replication to the D1 database (graph storage, phase 3),
 * maintained by `replica-sync.ts` while the mirror is running. */
export interface ReplicaDiagnostics {
  /** Only the sync-leader tab pushes; followers accumulate pending work. */
  leader: boolean
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
  engine: StorageEngine
  status: "off" | "starting" | "ready" | "error"
  /** "opfs" = persisted; "memory" = this session only (OPFS unavailable). */
  persistence: "opfs" | "memory" | null
  ingestedNotes: number
  lastIngestMs: number | null
  /** Notes silently updated from external git changes (pulls, refreshes). */
  reconciledFromSync: number
  /** Cross-note block-id collisions re-keyed at ingest (last few). */
  rekeys: StorageRekey[]
  /** Git/SQL content mismatches the dual-write should have prevented (last few). */
  divergences: StorageDivergence[]
  /** SQL-side write failures (git was never affected) (last few). */
  writeErrors: StorageWriteError[]
  divergenceCount: number
  writeErrorCount: number
  rekeyCount: number
  /** D1 replication state; null until the replica sync has started. */
  replica: ReplicaDiagnostics | null
}

const OFF_DIAGNOSTICS: StorageDiagnostics = {
  engine: "git",
  status: "off",
  persistence: null,
  ingestedNotes: 0,
  lastIngestMs: null,
  reconciledFromSync: 0,
  rekeys: [],
  divergences: [],
  writeErrors: [],
  divergenceCount: 0,
  writeErrorCount: 0,
  rekeyCount: 0,
  replica: null,
}

/** Read-only diagnostics for the Settings panel — what the trial is watched by. */
export const storageDiagnosticsAtom = atom<StorageDiagnostics>(OFF_DIAGNOSTICS)

/** Keep only the most recent entries of the diagnostic lists. */
const MAX_ENTRIES = 20

/** Minimum gap between automatic repair re-ingests after a SQL write failure. */
const REINGEST_COOLDOWN_MS = 30_000

export interface StorageMirrorOptions {
  /** Current repo files (path → content) — the git worktree snapshot. */
  getFiles: () => Record<string, string>
  /**
   * Persist note rewrites through the normal git save path (collision
   * re-keys). Git is canonical, so the markdown must gain the new ids too.
   */
  writeNotes: (updates: Record<NoteId, string>, commitMessage?: string) => void
  /** Injectable for tests; defaults to the wasm worker driver. */
  openStore?: () => Promise<{ store: SqlNoteStore; persistence: "opfs" | "memory" }>
  /** Injectable for tests; defaults to the real D1 replica sync
   * (`replica-sync.ts`, dynamically imported so it stays in the flag-on
   * chunk). Return null to run without replication. */
  openReplicaSync?: (getFiles: () => Record<string, string>) => Promise<ReplicaSyncHandle | null>
}

interface MirrorRuntime {
  options: StorageMirrorOptions
  store: SqlNoteStore | null
  /** Write-behind D1 replication (leader tab only pushes); null until started. */
  replica: ReplicaSyncHandle | null
  /** Note ids this mirror wrote to SQL and git has not yet confirmed matching. */
  pendingWrites: Set<NoteId>
  /** Note ids this mirror deleted from SQL. */
  pendingDeletes: Set<NoteId>
  /** Per-note content hash of the previous git snapshot (external-change detection). */
  lastGitHashes: Map<NoteId, string>
  lastReingestAt: number
  generation: number
}

let runtime: MirrorRuntime | null = null
let generation = 0
let queue: Promise<void> = Promise.resolve()

/** Serialize all SQL work; one task's failure never breaks the chain. */
function enqueue(task: () => Promise<void>) {
  queue = queue.then(task).catch((error) => {
    recordWriteError(error)
  })
}

function jotai() {
  return getDefaultStore()
}

function updateDiagnostics(patch: Partial<StorageDiagnostics>) {
  const store = jotai()
  store.set(storageDiagnosticsAtom, { ...store.get(storageDiagnosticsAtom), ...patch })
}

function recordWriteError(error: unknown) {
  const store = jotai()
  const prev = store.get(storageDiagnosticsAtom)
  const entry: StorageWriteError = {
    message: error instanceof Error ? error.message : String(error),
    at: Date.now(),
  }
  store.set(storageDiagnosticsAtom, {
    ...prev,
    writeErrors: [...prev.writeErrors, entry].slice(-MAX_ENTRIES),
    writeErrorCount: prev.writeErrorCount + 1,
  })
}

function recordDivergences(entries: StorageDivergence[]) {
  if (entries.length === 0) return
  const store = jotai()
  const prev = store.get(storageDiagnosticsAtom)
  store.set(storageDiagnosticsAtom, {
    ...prev,
    divergences: [...prev.divergences, ...entries].slice(-MAX_ENTRIES),
    divergenceCount: prev.divergenceCount + entries.length,
  })
}

/** Extract note contents (id → markdown) from a repo file map. */
function notesFromFiles(files: Record<string, string>): Record<NoteId, string> {
  const notes: Record<NoteId, string> = {}
  for (const filepath in files) {
    if (!filepath.endsWith(".md")) continue
    notes[filepath.replace(/\.md$/, "")] = files[filepath]
  }
  return notes
}

/** Collapsed-id sets for every note that has any (sidecars + legacy fallback). */
function viewStatesFromFiles(
  files: Record<string, string>,
  noteIds: NoteId[],
): Record<NoteId, string[]> {
  const viewStates: Record<NoteId, string[]> = {}
  for (const id of noteIds) {
    const collapsed = readNoteViewState(files, id)
    if (collapsed.length > 0) viewStates[id] = collapsed
  }
  return viewStates
}

/** cyrb53-style content hash — only used to detect "did git change this note
 * since the last verify pass", never for cross-store comparison (contents are
 * compared directly). */
function hashContent(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16) + "-" + (h1 >>> 0).toString(16)
}

async function defaultOpenReplicaSync(getFiles: () => Record<string, string>) {
  // Dynamic import: replication code loads only while the flag is on.
  const { startReplicaSync } = await import("./replica-sync")
  return startReplicaSync({ getFiles })
}

async function defaultOpenStore() {
  // Dynamic imports keep the SQL store (and the sqlite wasm worker behind it)
  // out of the main bundle entirely while the flag is off.
  const [{ createBrowserSqlDriver }, { openSqlNoteStore }] = await Promise.all([
    import("./sql-driver-browser"),
    import("./sql-note-store"),
  ])
  const driver = await createBrowserSqlDriver()
  const store = await openSqlNoteStore(driver)
  return { store, persistence: driver.persistence }
}

/**
 * Start the mirror: open the SQL store and ingest the current worktree.
 * Idempotent per activation; `stopStorageMirror` cancels an in-flight start.
 */
export function startStorageMirror(options: StorageMirrorOptions) {
  if (runtime) return
  generation += 1
  const activation: MirrorRuntime = {
    options,
    store: null,
    replica: null,
    pendingWrites: new Set(),
    pendingDeletes: new Set(),
    lastGitHashes: new Map(),
    lastReingestAt: 0,
    generation,
  }
  runtime = activation
  jotai().set(storageDiagnosticsAtom, {
    ...OFF_DIAGNOSTICS,
    engine: "database",
    status: "starting",
  })

  enqueue(async () => {
    try {
      const { store, persistence } = await (options.openStore ?? defaultOpenStore)()
      if (runtime !== activation) {
        // Stopped (or restarted) while opening — discard this activation.
        await store.close().catch(() => {})
        return
      }
      activation.store = store
      updateDiagnostics({ persistence })
      await runIngest(activation)
      if (runtime === activation) updateDiagnostics({ status: "ready" })
      // Start the write-behind D1 replication after the local store is ready.
      // A replication failure never affects the mirror — record and continue.
      if (runtime === activation) {
        try {
          const replica = await (options.openReplicaSync ?? defaultOpenReplicaSync)(
            options.getFiles,
          )
          if (runtime !== activation) {
            replica?.stop()
            return
          }
          activation.replica = replica
          // Seed the replica with the full ingested corpus.
          replica?.requestFullPush()
        } catch (error) {
          recordWriteError(error)
        }
      }
    } catch (error) {
      if (runtime === activation) {
        updateDiagnostics({ status: "error" })
        recordWriteError(error)
      }
    }
  })
}

/** Full rebuild from the current worktree (also the repair path). */
async function runIngest(activation: MirrorRuntime) {
  const store = activation.store
  if (!store) return
  const { ingestWorktree } = await import("./sql-note-store")
  const files = activation.options.getFiles()
  const notes = notesFromFiles(files)
  const startedAt = performance.now()
  const result = await ingestWorktree(store, notes, viewStatesFromFiles(files, Object.keys(notes)))
  const lastIngestMs = Math.round(performance.now() - startedAt)

  // Seed the external-change detector with what was just ingested.
  activation.lastGitHashes = new Map(
    Object.entries({ ...notes, ...result.rewrittenNotes }).map(([id, content]) => [
      id,
      hashContent(content),
    ]),
  )
  activation.pendingWrites.clear()
  activation.pendingDeletes.clear()

  if (result.rekeys.length > 0) {
    // Git is canonical: persist the re-keyed `id::` lines as a normal commit
    // so the markdown and the database can never disagree about an id.
    const at = Date.now()
    activation.options.writeNotes(result.rewrittenNotes, "Re-key duplicate block ids")
    const store2 = jotai()
    const prev = store2.get(storageDiagnosticsAtom)
    store2.set(storageDiagnosticsAtom, {
      ...prev,
      rekeys: [...prev.rekeys, ...result.rekeys.map((r) => ({ ...r, at }))].slice(-MAX_ENTRIES),
      rekeyCount: prev.rekeyCount + result.rekeys.length,
    })
  }

  updateDiagnostics({ ingestedNotes: result.ingestedNotes, lastIngestMs })
  // A (re-)ingest rebuilt the local store wholesale — replicate the whole
  // corpus (no-op before the replica sync has started; the start path pushes).
  activation.replica?.requestFullPush()
  console.log(
    `[storage-mirror] ingested ${result.ingestedNotes} notes in ${lastIngestMs}ms` +
      (result.rekeys.length > 0 ? ` (${result.rekeys.length} block ids re-keyed)` : ""),
  )
}

/** Stop the mirror and close the database. The OPFS file is left in place —
 * flipping the flag back on re-ingests over it. */
export function stopStorageMirror() {
  const stopped = runtime
  if (!stopped) return
  runtime = null
  generation += 1
  stopped.replica?.stop()
  stopped.replica = null
  enqueue(async () => {
    await stopped.store?.close().catch(() => {})
  })
  jotai().set(storageDiagnosticsAtom, OFF_DIAGNOSTICS)
}

/** Settings action: replicate the full corpus to D1 now. No-op unless the
 * mirror (and its replica sync) is running. */
export function requestReplicaFullPush() {
  runtime?.replica?.requestFullPush()
}

/** Refresh the remote D1 counts shown in the Settings panel. No-op unless the
 * mirror (and its replica sync) is running. */
export function refreshReplicaStatus() {
  runtime?.replica?.refreshRemoteStatus()
}

/** After a SQL-side failure, schedule one repair re-ingest (cooldown-guarded). */
function scheduleRepairIngest(activation: MirrorRuntime) {
  const now = Date.now()
  if (now - activation.lastReingestAt < REINGEST_COOLDOWN_MS) return
  activation.lastReingestAt = now
  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    await runIngest(activation)
  })
}

/**
 * Dual-write: mirror a batch of repo-file writes (`null` deletes) into the SQL
 * store. Called from the `src/data/store.ts` seam right after the write is
 * handed to the git machine; a no-op while the mirror is off. Never throws.
 */
export function mirrorFileWrites(files: Record<string, string | null>) {
  const activation = runtime
  if (!activation) return

  const noteUpdates: Record<NoteId, string | null> = {}
  const viewStateUpdates: [NoteId, string[]][] = []
  const viewStateRe = new RegExp(`^${VIEW_STATE_DIR}/(.+)\\.json$`)

  for (const [filepath, content] of Object.entries(files)) {
    if (filepath.endsWith(".md")) {
      const id = filepath.replace(/\.md$/, "")
      noteUpdates[id] = content
      if (content === null) activation.pendingDeletes.add(id)
      else activation.pendingWrites.add(id)
      continue
    }
    if (filepath === LEGACY_VIEW_STATE_PATH) continue // migration handled per-note
    const match = viewStateRe.exec(filepath)
    if (match) {
      viewStateUpdates.push([match[1], content === null ? [] : parseNoteViewState(content)])
    }
  }

  if (Object.keys(noteUpdates).length === 0 && viewStateUpdates.length === 0) return

  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    try {
      if (Object.keys(noteUpdates).length > 0) await activation.store.writeNotes(noteUpdates)
      for (const [noteId, collapsedIds] of viewStateUpdates) {
        await activation.store.setViewState(noteId, collapsedIds)
      }
      // Mirror write succeeded — queue the same notes for D1 replication
      // (view-state changes ride the owning note's replica entry).
      const changed = Object.keys(noteUpdates).filter((id) => noteUpdates[id] !== null)
      const deleted = Object.keys(noteUpdates).filter((id) => noteUpdates[id] === null)
      activation.replica?.notifyNotesChanged([
        ...changed,
        ...viewStateUpdates.map(([noteId]) => noteId).filter((id) => !deleted.includes(id)),
      ])
      activation.replica?.notifyNotesDeleted(deleted)
    } catch (error) {
      // The git write already went through — SQL must never block it. Record
      // and repair via re-ingest (e.g. a cross-note block-id collision that
      // needs the full rekey pass).
      recordWriteError(error)
      scheduleRepairIngest(activation)
    }
  })
}

/** Dual-write for the machine's dedicated single-file delete path. */
export function mirrorDeleteFile(filepath: string) {
  mirrorFileWrites({ [filepath]: null })
}

/**
 * Shadow-read: verify the SQL store against the current git worktree snapshot.
 * Called on every `markdownFilesAtom` change. External changes (pulls) are
 * reconciled silently; anything else that differs is recorded as a divergence
 * — and healed, because git is canonical either way.
 */
export function verifyStorageMirror(files: Record<string, string>) {
  const activation = runtime
  if (!activation) return
  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    const store = activation.store
    const gitNotes = notesFromFiles(files)
    const sqlNotes = await store.getAllNotes()

    const divergences: StorageDivergence[] = []
    const heal: Record<NoteId, string | null> = {}
    const newHashes = new Map<NoteId, string>()
    let reconciled = 0
    const at = Date.now()

    for (const [id, content] of Object.entries(gitNotes)) {
      const hash = hashContent(content)
      newHashes.set(id, hash)
      if (sqlNotes[id] === content) {
        activation.pendingWrites.delete(id)
        continue
      }
      const changedExternally =
        activation.lastGitHashes.get(id) !== hash && !activation.pendingWrites.has(id)
      if (changedExternally) {
        reconciled += 1
      } else {
        divergences.push({
          noteId: id,
          kind: sqlNotes[id] === undefined ? "missing-in-sql" : "mismatch",
          at,
        })
      }
      heal[id] = content
      activation.pendingWrites.delete(id)
    }

    for (const id of Object.keys(sqlNotes)) {
      if (id in gitNotes) continue
      const deletedExternally =
        activation.lastGitHashes.has(id) &&
        !activation.pendingDeletes.has(id) &&
        !activation.pendingWrites.has(id)
      if (deletedExternally) reconciled += 1
      else divergences.push({ noteId: id, kind: "extra-in-sql", at })
      heal[id] = null
    }

    // Confirmed deletes (gone from both sides) no longer need tracking.
    for (const id of activation.pendingDeletes) {
      if (!(id in sqlNotes) && !(id in gitNotes)) activation.pendingDeletes.delete(id)
    }
    for (const id of activation.pendingWrites) {
      if (!(id in gitNotes) && !(id in sqlNotes)) activation.pendingWrites.delete(id)
    }
    activation.lastGitHashes = newHashes

    if (Object.keys(heal).length > 0) {
      try {
        await store.writeNotes(heal)
      } catch (error) {
        recordWriteError(error)
        scheduleRepairIngest(activation)
      }
      // Whatever differed from the previous snapshot (external pulls, healed
      // divergences) must reach D1 too — git is what gets replicated, so this
      // is safe regardless of how the SQL-side heal fared.
      activation.replica?.notifyNotesChanged(Object.keys(heal).filter((id) => heal[id] !== null))
      activation.replica?.notifyNotesDeleted(Object.keys(heal).filter((id) => heal[id] === null))
    }

    recordDivergences(divergences)
    if (reconciled > 0) {
      const prev = jotai().get(storageDiagnosticsAtom)
      updateDiagnostics({ reconciledFromSync: prev.reconciledFromSync + reconciled })
    }
  })
}

/** Wait for all queued mirror work — tests only. */
export function flushStorageMirror(): Promise<void> {
  return queue
}
