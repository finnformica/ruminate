import { atom, getDefaultStore } from "jotai"
import type { NoteId } from "../schema"
import { createD1NoteSource, planPullApplication, type D1NoteSource } from "./d1-note-source"
import { VIEW_STATE_DIR, viewStatePath } from "./paths"
import type { ReplicaSyncHandle } from "./replica-sync"
import type { SqlNoteStore } from "./sql-note-store"
import { storageDiagnosticsAtom, type StorageDiagnostics } from "./storage-mirror"
import { parseNoteViewState, readNoteViewState, serializeNoteViewState } from "./view-state-parse"

/**
 * Database-authoritative mode (docs/graph-storage.md): the runtime behind the
 * app when the storage flag is "database" (the default on this branch).
 *
 * After GitHub sign-in there is no repo screen and no git anywhere in the data
 * path. The local SQL store (wa-sqlite over OPFS) is the runtime store; D1
 * behind the Worker is the authoritative cross-device copy:
 *
 *   boot   open SQL store → serve local contents immediately → pull from D1
 *          (full on first boot, since-cursor after) → apply into the store
 *   saves  write the SQL store + mark dirty in the replica push queue
 *          (replica-sync.ts — write-behind, coalesced, backoff)
 *   sync   visibility/online triggers re-run the since-cursor pull
 *
 * **How the UI is fed (the boot-flow surgery).** Everything above `src/data`
 * reads `markdownFilesAtom` (notes, tags, templates, view-state sidecars, the
 * editor's external-change path). Rather than re-plumb those consumers, this
 * module synthesizes the same repo-file-shaped map from the store —
 * `<id>.md` entries plus `.ruminate/view-state/<id>.json` sidecar entries —
 * into `databaseFilesAtom`, and `markdownFilesAtom` serves it whenever
 * database mode is active (see global-state.ts). Every consumer, including
 * the replica push payload builder, works unchanged; the git machine still
 * runs for auth but its repo states are never entered (its `resolveRepo`
 * service refuses in database mode).
 *
 * **Conflicts are last-writer-wins**, decided by push order at the replica.
 * Pulls never touch notes with queued/in-flight local pushes
 * (`ReplicaSyncHandle.pendingNoteIds`), and the editor's own remote-change
 * notice still protects unsaved (uncommitted) edits when a pulled change
 * lands under them.
 *
 * All SQL work is serialized on one promise queue; the files atom is updated
 * optimistically on write so the UI never waits on the database.
 */

const PULL_CURSOR_KEY = "d1_pull_cursor"
const PULL_RETRY_MS = 60_000
/** Minimum gap between automatic repair rebuilds after a SQL write failure. */
const REPAIR_COOLDOWN_MS = 30_000

/**
 * The synthesized repo-file-shaped map (notes + view-state sidecars) served
 * as `markdownFilesAtom` while database mode is active. Written only by this
 * module.
 */
export const databaseFilesAtom = atom<Record<string, string>>({})

export interface DatabaseModeStatus {
  status: "off" | "opening" | "ready" | "error"
  pull: "idle" | "pulling" | "error"
  lastPullAt: number | null
  lastPullError: string | null
  /** First-ever boot without a reachable replica: nothing local, nothing
   * pulled — the UI shows an explanatory empty state. */
  emptyOffline: boolean
}

const OFF_STATUS: DatabaseModeStatus = {
  status: "off",
  pull: "idle",
  lastPullAt: null,
  lastPullError: null,
  emptyOffline: false,
}

export const databaseModeStatusAtom = atom<DatabaseModeStatus>(OFF_STATUS)

export interface DatabaseModeOptions {
  /** Injectable for tests; defaults to the wasm worker driver. */
  openStore?: () => Promise<{ store: SqlNoteStore; persistence: "opfs" | "memory" }>
  /** Injectable for tests; defaults to the real replica push loop. Return
   * null to run without pushing. */
  openReplicaSync?: (getFiles: () => Record<string, string>) => Promise<ReplicaSyncHandle | null>
  /** Injectable for tests; defaults to the real authed fetch source. */
  source?: D1NoteSource
  pullRetryMs?: number
}

interface DatabaseModeRuntime {
  options: DatabaseModeOptions
  store: SqlNoteStore | null
  replica: ReplicaSyncHandle | null
  source: D1NoteSource
  pullRetryTimer: ReturnType<typeof setTimeout> | null
  lastRepairAt: number
  generation: number
}

let runtime: DatabaseModeRuntime | null = null
let generation = 0
let queue: Promise<void> = Promise.resolve()

/** Serialize all SQL/pull work; one task's failure never breaks the chain. */
function enqueue(task: () => Promise<void>) {
  queue = queue.then(task).catch((error) => recordWriteError(error))
}

const jotai = () => getDefaultStore()

function patchStatus(patch: Partial<DatabaseModeStatus>) {
  const store = jotai()
  store.set(databaseModeStatusAtom, { ...store.get(databaseModeStatusAtom), ...patch })
}

function patchDiagnostics(patch: Partial<StorageDiagnostics>) {
  const store = jotai()
  store.set(storageDiagnosticsAtom, { ...store.get(storageDiagnosticsAtom), ...patch })
}

function recordWriteError(error: unknown) {
  const store = jotai()
  const prev = store.get(storageDiagnosticsAtom)
  store.set(storageDiagnosticsAtom, {
    ...prev,
    writeErrors: [
      ...prev.writeErrors,
      { message: error instanceof Error ? error.message : String(error), at: Date.now() },
    ].slice(-20),
    writeErrorCount: prev.writeErrorCount + 1,
  })
}

/** Is the database-authoritative runtime up (or starting)? The write seam in
 * `store.ts` routes through it exactly when this is true. */
export function isDatabaseModeActive(): boolean {
  return runtime !== null
}

// -----------------------------------------------------------------------------
// Files-map synthesis
// -----------------------------------------------------------------------------

/** Build the repo-file-shaped map from store contents. */
function synthesizeFiles(
  notes: Record<NoteId, string>,
  viewStates: Record<NoteId, string[]>,
): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [id, content] of Object.entries(notes)) files[`${id}.md`] = content
  for (const [id, collapsed] of Object.entries(viewStates)) {
    if (collapsed.length > 0) files[viewStatePath(id)] = serializeNoteViewState(collapsed)
  }
  return files
}

/** Note contents (id → markdown) currently in the files atom. */
function notesFromFiles(files: Record<string, string>): Record<NoteId, string> {
  const notes: Record<NoteId, string> = {}
  for (const filepath in files) {
    if (filepath.endsWith(".md")) notes[filepath.replace(/\.md$/, "")] = files[filepath]
  }
  return notes
}

/** Apply note/view-state updates (`null` deletes) to the files atom. */
function applyToFilesAtom(
  noteUpdates: Record<NoteId, string | null>,
  viewStateUpdates: Record<NoteId, string[]>,
) {
  const store = jotai()
  const files = { ...store.get(databaseFilesAtom) }
  for (const [id, content] of Object.entries(noteUpdates)) {
    if (content === null) {
      delete files[`${id}.md`]
      delete files[viewStatePath(id)]
    } else {
      files[`${id}.md`] = content
    }
  }
  for (const [id, collapsed] of Object.entries(viewStateUpdates)) {
    if (collapsed.length === 0 || noteUpdates[id] === null) delete files[viewStatePath(id)]
    else files[viewStatePath(id)] = serializeNoteViewState(collapsed)
  }
  store.set(databaseFilesAtom, files)
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

async function defaultOpenStore() {
  // Dynamic imports keep the sqlite wasm worker out of the main bundle.
  const [{ createBrowserSqlDriver }, { openSqlNoteStore }] = await Promise.all([
    import("./sql-driver-browser"),
    import("./sql-note-store"),
  ])
  const driver = await createBrowserSqlDriver()
  const store = await openSqlNoteStore(driver)
  return { store, persistence: driver.persistence }
}

async function defaultOpenReplicaSync(getFiles: () => Record<string, string>) {
  const { startReplicaSync } = await import("./replica-sync")
  // Not leader-gated: in database mode there is no shared git worktree
  // carrying follower edits to a leader tab, so every tab must push its own
  // writes. Concurrent tabs converge by last-writer-wins at the replica.
  return startReplicaSync({ getFiles, isLeader: () => true })
}

/** Start database-authoritative mode. Idempotent per activation. */
export function startDatabaseMode(options: DatabaseModeOptions = {}) {
  if (runtime) return
  generation += 1
  const activation: DatabaseModeRuntime = {
    options,
    store: null,
    replica: null,
    source: options.source ?? createD1NoteSource(),
    pullRetryTimer: null,
    lastRepairAt: 0,
    generation,
  }
  runtime = activation
  jotai().set(databaseModeStatusAtom, { ...OFF_STATUS, status: "opening" })
  patchDiagnostics({ engine: "database", status: "starting" })

  enqueue(async () => {
    try {
      const { store, persistence } = await (options.openStore ?? defaultOpenStore)()
      if (runtime !== activation) {
        await store.close().catch(() => {})
        return
      }
      activation.store = store
      patchDiagnostics({ persistence })

      // Serve local contents immediately — offline boots (after the first)
      // show every note before any network work.
      const [notes, viewStates] = await Promise.all([store.getAllNotes(), store.getAllViewStates()])
      if (runtime !== activation) return
      jotai().set(databaseFilesAtom, synthesizeFiles(notes, viewStates))
      patchStatus({ status: "ready" })
      patchDiagnostics({ status: "ready", ingestedNotes: Object.keys(notes).length })

      // Start the push loop before the first pull, so the pull can consult
      // `pendingNoteIds` (edits made while the pull is in flight are safe).
      try {
        const replica = await (options.openReplicaSync ?? defaultOpenReplicaSync)(() =>
          jotai().get(databaseFilesAtom),
        )
        if (runtime !== activation) {
          replica?.stop()
          return
        }
        activation.replica = replica
      } catch (error) {
        recordWriteError(error)
      }
    } catch (error) {
      if (runtime === activation) {
        patchStatus({ status: "error" })
        patchDiagnostics({ status: "error" })
        recordWriteError(error)
      }
    }
  })

  // The initial pull (full on first boot, since-cursor after).
  runPull(activation)
}

/** Stop the runtime and close the database (OPFS contents stay in place). */
export function stopDatabaseMode() {
  const stopped = runtime
  if (!stopped) return
  runtime = null
  generation += 1
  stopped.replica?.stop()
  stopped.replica = null
  if (stopped.pullRetryTimer !== null) clearTimeout(stopped.pullRetryTimer)
  enqueue(async () => {
    await stopped.store?.close().catch(() => {})
  })
  const store = jotai()
  store.set(databaseModeStatusAtom, OFF_STATUS)
  store.set(databaseFilesAtom, {})
}

// -----------------------------------------------------------------------------
// Writes (the `store.ts` seam routes here in database mode)
// -----------------------------------------------------------------------------

const viewStateFileRe = new RegExp(`^${VIEW_STATE_DIR}/(.+)\\.json$`)

/**
 * Persist a batch of repo-file-shaped writes (`null` deletes): note files and
 * view-state sidecars, exactly the shapes `useWriteFiles` already produces.
 * The files atom updates synchronously (the UI never waits); the SQL write is
 * queued; on success the replica queue is marked dirty. No git anywhere.
 */
export function databaseWriteFiles(files: Record<string, string | null>) {
  const activation = runtime
  if (!activation) return

  const noteUpdates: Record<NoteId, string | null> = {}
  const viewStateUpdates: Record<NoteId, string[]> = {}
  for (const [filepath, content] of Object.entries(files)) {
    if (filepath.endsWith(".md")) {
      noteUpdates[filepath.replace(/\.md$/, "")] = content
      continue
    }
    const match = viewStateFileRe.exec(filepath)
    if (match) viewStateUpdates[match[1]] = content === null ? [] : parseNoteViewState(content)
    // Anything else (e.g. the legacy view-state sidecar, which can only exist
    // in a git worktree) has no meaning in the database store and is dropped.
  }
  if (Object.keys(noteUpdates).length === 0 && Object.keys(viewStateUpdates).length === 0) return

  applyToFilesAtom(noteUpdates, viewStateUpdates)
  patchStatus({ emptyOffline: false })
  patchDiagnostics({
    ingestedNotes: Object.keys(notesFromFiles(jotai().get(databaseFilesAtom))).length,
  })

  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    try {
      if (Object.keys(noteUpdates).length > 0) await activation.store.writeNotes(noteUpdates)
      for (const [noteId, collapsedIds] of Object.entries(viewStateUpdates)) {
        if (noteUpdates[noteId] === null) continue // delete already cleared it
        await activation.store.setViewState(noteId, collapsedIds)
      }
    } catch (error) {
      // The files atom (and thus the push queue) already has the content, so
      // D1 still receives it; repair the local store from the atom so a
      // reload cannot lose it.
      recordWriteError(error)
      scheduleRepair(activation)
    }
    // Mark dirty regardless: the push payload is built from the files atom,
    // which is correct even when the SQL write failed.
    const changed = Object.keys(noteUpdates).filter((id) => noteUpdates[id] !== null)
    const deleted = Object.keys(noteUpdates).filter((id) => noteUpdates[id] === null)
    activation.replica?.notifyNotesChanged([
      ...changed,
      ...Object.keys(viewStateUpdates).filter((id) => !(id in noteUpdates)),
    ])
    activation.replica?.notifyNotesDeleted(deleted)
  })
}

/** The machine's dedicated single-file delete path, database edition. */
export function databaseDeleteFile(filepath: string) {
  databaseWriteFiles({ [filepath]: null })
}

/** Settings action: replicate the full corpus to D1 now. No-op unless the
 * runtime (and its push loop) is up. */
export function requestDatabaseFullPush() {
  runtime?.replica?.requestFullPush()
}

/** Refresh the remote D1 counts shown in the Settings panel. */
export function refreshDatabaseReplicaStatus() {
  runtime?.replica?.refreshRemoteStatus()
}

/** After a SQL-side failure, rebuild the store from the files atom (the
 * authoritative in-memory copy), cooldown-guarded. */
function scheduleRepair(activation: DatabaseModeRuntime) {
  const now = Date.now()
  if (now - activation.lastRepairAt < REPAIR_COOLDOWN_MS) return
  activation.lastRepairAt = now
  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    const files = jotai().get(databaseFilesAtom)
    const notes = notesFromFiles(files)
    const viewStates: Record<NoteId, string[]> = {}
    for (const id of Object.keys(notes)) {
      const collapsed = readNoteViewState(files, id)
      if (collapsed.length > 0) viewStates[id] = collapsed
    }
    await activation.store.replaceAll(notes, viewStates)
  })
}

// -----------------------------------------------------------------------------
// Pulls (boot + the SYNC triggers: visibility, online)
// -----------------------------------------------------------------------------

/** Queue a pull: since-cursor when a cursor is stored, else the full corpus. */
export function requestDatabasePull() {
  const activation = runtime
  if (!activation) return
  runPull(activation)
}

function runPull(activation: DatabaseModeRuntime) {
  if (activation.pullRetryTimer !== null) {
    clearTimeout(activation.pullRetryTimer)
    activation.pullRetryTimer = null
  }
  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    const store = activation.store
    patchStatus({ pull: "pulling" })
    try {
      const cursor = await store.getMeta(PULL_CURSOR_KEY)
      // An unusable cursor (never pulled, or not the ms-timestamp shape the
      // server compares against) degrades to a full pull — always correct,
      // just bigger.
      const body =
        cursor !== null && /^\d+$/.test(cursor)
          ? await activation.source.pullSince(cursor)
          : await activation.source.pullFull()
      if (runtime !== activation) return

      const pulled = "changed" in body ? body.changed : body.notes
      const remoteIds = "changed" in body ? body.ids : body.notes.map((entry) => entry.note.id)
      const files = jotai().get(databaseFilesAtom)
      const local = notesFromFiles(files)
      const localViewStates: Record<NoteId, string[]> = {}
      for (const entry of pulled) {
        localViewStates[entry.note.id] = readNoteViewState(files, entry.note.id)
      }

      const plan = planPullApplication({
        local,
        localViewStates,
        pulled,
        remoteIds,
        pending: activation.replica?.pendingNoteIds?.() ?? new Set(),
      })

      if (Object.keys(plan.notes).length > 0) await store.writeNotes(plan.notes)
      for (const [noteId, collapsedIds] of Object.entries(plan.viewStates)) {
        await store.setViewState(noteId, collapsedIds)
      }
      if (Object.keys(plan.notes).length > 0 || Object.keys(plan.viewStates).length > 0) {
        applyToFilesAtom(plan.notes, plan.viewStates)
      }
      if (body.cursor !== null) await store.setMeta(PULL_CURSOR_KEY, body.cursor)

      patchStatus({
        pull: "idle",
        lastPullAt: Date.now(),
        lastPullError: null,
        emptyOffline: false,
      })
      patchDiagnostics({
        ingestedNotes: Object.keys(notesFromFiles(jotai().get(databaseFilesAtom))).length,
      })
    } catch (error) {
      if (runtime !== activation) return
      const message = error instanceof Error ? error.message : String(error)
      const localCount = Object.keys(notesFromFiles(jotai().get(databaseFilesAtom))).length
      patchStatus({
        pull: "error",
        lastPullError: message,
        // First-ever boot with an unreachable replica: nothing to show, and
        // that deserves an explanation rather than a silent empty list.
        emptyOffline: localCount === 0,
      })
      const retryMs = activation.options.pullRetryMs ?? PULL_RETRY_MS
      activation.pullRetryTimer = setTimeout(() => {
        activation.pullRetryTimer = null
        if (runtime === activation) runPull(activation)
      }, retryMs)
    }
  })
}

/** Wait for all queued work — tests only. */
export function flushDatabaseMode(): Promise<void> {
  return queue
}
