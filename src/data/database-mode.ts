import { atom, getDefaultStore } from "jotai"
import type { ReplicaChangesBody } from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
import { SessionExpiredError } from "../utils/github-token"
import {
  createD1NoteSource,
  expandPendingNodeIds,
  planPullApplication,
  type D1NoteSource,
} from "./d1-note-source"
import { resetReplicaAccess } from "./replica-access"
import type { ReplicaSyncHandle } from "./replica-sync"
import type { SqlNoteStore } from "./sql-note-store"
import {
  OFF_STORAGE_DIAGNOSTICS,
  storageDiagnosticsAtom,
  type StorageDiagnostics,
} from "./storage-diagnostics"

/**
 * The database storage runtime (docs/graph-storage.md) — the app's one and
 * only store, mounted whenever a user is signed in.
 *
 * The local SQL store (sqlite-wasm over OPFS) is the runtime store; D1 behind
 * the Worker is the authoritative cross-device copy. Both hold the schema v2
 * graph (docs/graph-schema-v2.md): `nodes` + `link` rows are truth, markdown
 * is the rollup.
 *
 *   boot   open SQL store → discard it if its cache generation or its owner is
 *          not this one → serve local contents immediately → pull from D1
 *          (full on first boot, since-cursor after) → apply rows into the store
 *   saves  ingest into the SQL store as a row diff + hand that diff to the
 *          replica push queue (replica-sync.ts — write-behind, coalesced)
 *   sync   visibility/focus/online triggers re-run the since-cursor pull;
 *          hiding the tab flushes the push queue immediately
 *
 * **How the UI is fed.** Everything above `src/data` reads
 * `markdownFilesAtom` (notes, tags, templates, the editor's external-change
 * path). This module synthesizes the repo-file-shaped map those consumers
 * expect — `<id>.md` entries, each the rollup of its page node — into
 * `databaseFilesAtom`, and `markdownFilesAtom` serves it whenever a user is
 * signed in (see global-state.ts).
 *
 * **Conflicts are last-writer-wins per row**, decided by push order at the
 * replica. Pulls never touch rows of notes with queued/in-flight local pushes
 * (`ReplicaSyncHandle.pendingNoteIds`), and the editor's own remote-change
 * notice still protects unsaved (uncommitted) edits when a pulled change
 * lands under them.
 *
 * All SQL work is serialized on one promise queue; the files atom is updated
 * optimistically on write so the UI never waits on the database.
 */

const PULL_CURSOR_KEY = "d1_pull_cursor"
/** The identity (GitHub id, or login for pre-id sessions) whose notes the
 * local database holds. The server is owner-locked, but the OPFS cache
 * follows the browser profile — on a shared machine a different signed-in
 * account must never be shown another owner's locally cached notes. */
const OWNER_KEY = "store_owner"
/**
 * The generation of the row shapes the local database holds, and the meta key
 * it is stamped under.
 *
 * **The local store is a CACHE of D1, never a source of truth**, so it is
 * never data-migrated. Data migrations run ONCE, server-side, against D1;
 * a device whose cached copy predates one has no way to tell which of its rows
 * are stale, and merging pre-migration rows with pulled post-migration ones is
 * how the corpus breaks. So the cache is versioned instead: bump this constant
 * with every server-side data migration and each device discards its copy and
 * rebuilds it from a full pull. A few lines, no per-row logic.
 *
 * Generation `2` was the minted-page-id corpus (docs/page-identity-design.md).
 *
 * Generation `3` retires deletion-by-absence. Pulls no longer carry the full
 * key list of each table, so a row HARD-deleted at the replica before soft
 * deletes existed — one that left no tombstone to replicate — would sit in a
 * device's cache forever, invisible to every future pull. One clean re-pull
 * settles it.
 *
 * This is why the constant is bumped rather than merely re-documented: every
 * device that already booted on generation `2` has `"2"` stamped in its meta,
 * so folding a new change into the old number is a wipe that never fires.
 *
 * The wipe costs what an owner change costs: local rows that were never
 * pushed (edits made while the replica was unreachable, still only in this
 * browser) go with it. The push queue flushes within ~2s of a save and again
 * when the tab hides, so the window is small — but it is real, and it is why
 * this is bumped deliberately rather than routinely.
 */
export const CACHE_GENERATION = "3"
const CACHE_GENERATION_KEY = "cache_generation"
const PULL_RETRY_MS = 60_000
/** Minimum gap between automatic repair rebuilds after a SQL write failure. */
const REPAIR_COOLDOWN_MS = 30_000

/**
 * The synthesized repo-file-shaped map (note rollups) served as
 * `markdownFilesAtom` while database mode is active. Written only by this
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
  /** The signed-in identity the store belongs to. When it differs from the
   * identity recorded in the local database, the local contents are wiped
   * before anything renders (see OWNER_KEY). Omit to skip the check (tests). */
  owner?: string
  /** Injectable for tests; defaults to the wasm worker driver. */
  openStore?: () => Promise<{
    store: SqlNoteStore
    persistence: "opfs" | "memory"
    /** Why persistence degraded to memory (e.g. another tab holds OPFS). */
    persistenceReason?: "another-tab" | "unavailable" | null
  }>
  /** Injectable for tests; defaults to the real replica push loop. Return
   * null to run without pushing. */
  openReplicaSync?: (
    getFiles: () => Record<string, string>,
    getAllRows: SqlNoteStore["getAllRows"],
  ) => Promise<ReplicaSyncHandle | null>
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
  /** Pending coalesced ambient pull (see `requestAmbientDatabasePull`). */
  ambientPullTimer: ReturnType<typeof setTimeout> | null
  /** When the last pull STARTED — the clock the ambient gap is measured on. */
  lastPullStartedAt: number
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

/** Is the database runtime up (or starting)? Writes through the `store.ts`
 * seam are no-ops (sample-notes mode) when this is false. */
export function isDatabaseModeActive(): boolean {
  return runtime !== null
}

// -----------------------------------------------------------------------------
// Files-map synthesis
// -----------------------------------------------------------------------------

/** Build the repo-file-shaped map from store contents (note rollups). */
function synthesizeFiles(notes: Record<NoteId, string>): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [id, content] of Object.entries(notes)) files[`${id}.md`] = content
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

/** Apply note updates (`null` deletes) to the files atom. */
function applyToFilesAtom(noteUpdates: Record<NoteId, string | null>) {
  const store = jotai()
  const files = { ...store.get(databaseFilesAtom) }
  for (const [id, content] of Object.entries(noteUpdates)) {
    if (content === null) delete files[`${id}.md`]
    else files[`${id}.md`] = content
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
  return { store, persistence: driver.persistence, persistenceReason: driver.persistenceReason }
}

async function defaultOpenReplicaSync(
  getFiles: () => Record<string, string>,
  getAllRows: SqlNoteStore["getAllRows"],
) {
  const { startReplicaSync } = await import("./replica-sync")
  // Every tab pushes its own writes; concurrent tabs converge by per-row
  // last-writer-wins at the replica.
  return startReplicaSync({ getFiles, getAllRows })
}

/** Start the database runtime. Idempotent per activation. */
export function startDatabaseMode(options: DatabaseModeOptions = {}) {
  if (runtime) return
  generation += 1
  const activation: DatabaseModeRuntime = {
    options,
    store: null,
    replica: null,
    source: options.source ?? createD1NoteSource(),
    pullRetryTimer: null,
    ambientPullTimer: null,
    lastPullStartedAt: 0,
    lastRepairAt: 0,
    generation,
  }
  runtime = activation
  jotai().set(databaseModeStatusAtom, { ...OFF_STATUS, status: "opening" })
  patchDiagnostics({ status: "opening" })

  enqueue(async () => {
    try {
      const opened = await (options.openStore ?? defaultOpenStore)()
      if (runtime !== activation) {
        await opened.store.close().catch(() => {})
        return
      }
      activation.store = opened.store
      patchDiagnostics({
        persistence: opened.persistence,
        persistenceReason: opened.persistenceReason ?? null,
      })

      // Serve local contents immediately — offline boots (after the first)
      // show every note before any network work.

      // Cache generation: a copy left by an older generation is thrown away
      // wholesale — cursor included, so the next pull is a full one — rather
      // than migrated in place. Same wipe as the owner mismatch below; a store
      // that has never held anything loses nothing by it.
      if ((await opened.store.getMeta(CACHE_GENERATION_KEY)) !== CACHE_GENERATION) {
        await opened.store.replaceAll({})
        await opened.store.setMeta(PULL_CURSOR_KEY, "")
        await opened.store.setMeta(CACHE_GENERATION_KEY, CACHE_GENERATION)
      }
      if (runtime !== activation) return

      // Owner binding: a store populated under a different identity is wiped
      // (cursor included, so the next pull is a full one) before any local
      // read can surface it. The rightful owner on a fresh device just
      // re-pulls; anyone else gets an empty store and 403s from the replica.
      if (options.owner !== undefined) {
        const previous = await opened.store.getMeta(OWNER_KEY)
        if (previous !== options.owner) {
          if (previous !== null) {
            await opened.store.replaceAll({})
            await opened.store.setMeta(PULL_CURSOR_KEY, "")
          }
          await opened.store.setMeta(OWNER_KEY, options.owner)
        }
        if (runtime !== activation) return
      }

      const notes = await opened.store.getAllNotes()
      if (runtime !== activation) return
      jotai().set(databaseFilesAtom, synthesizeFiles(notes))
      patchStatus({ status: "ready" })
      patchDiagnostics({ status: "ready", notes: Object.keys(notes).length })

      // Start the push loop before the first pull, so the pull can consult
      // `pendingNoteIds` (edits made while the pull is in flight are safe).
      try {
        const replica = await (options.openReplicaSync ?? defaultOpenReplicaSync)(
          () => jotai().get(databaseFilesAtom),
          () => {
            const store = activation.store
            if (!store) return Promise.resolve({ nodes: [], links: [] })
            return store.getAllRows()
          },
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
  if (stopped.ambientPullTimer !== null) clearTimeout(stopped.ambientPullTimer)
  enqueue(async () => {
    await stopped.store?.close().catch(() => {})
  })
  const store = jotai()
  store.set(databaseModeStatusAtom, OFF_STATUS)
  store.set(databaseFilesAtom, {})
  store.set(storageDiagnosticsAtom, OFF_STORAGE_DIAGNOSTICS)
  // A denial belongs to the account that was refused; the signed-out screen
  // (and any next sign-in) starts clean.
  resetReplicaAccess()
}

// -----------------------------------------------------------------------------
// Writes (the `store.ts` seam routes here in database mode)
// -----------------------------------------------------------------------------

/**
 * Persist a batch of repo-file-shaped note writes (`null` deletes) — the
 * shapes the `store.ts` seam already produces. The files atom updates
 * synchronously (the UI never waits); the SQL ingest is queued; the row diff
 * it returns is handed to the replica queue.
 */
export function databaseWriteFiles(files: Record<string, string | null>) {
  const activation = runtime
  if (!activation) return

  const noteUpdates: Record<NoteId, string | null> = {}
  for (const [filepath, content] of Object.entries(files)) {
    // Only notes live in the graph; anything else has no meaning here.
    if (filepath.endsWith(".md")) noteUpdates[filepath.replace(/\.md$/, "")] = content
  }
  if (Object.keys(noteUpdates).length === 0) return

  applyToFilesAtom(noteUpdates)
  patchStatus({ emptyOffline: false })
  patchDiagnostics({
    notes: Object.keys(notesFromFiles(jotai().get(databaseFilesAtom))).length,
  })

  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    try {
      const diff = await activation.store.writeNotes(noteUpdates)
      activation.replica?.notifyGraphChange(Object.keys(noteUpdates), diff)
    } catch (error) {
      // The files atom still carries the content; repair the local store from
      // it (and follow with a full push) so neither copy can lose the write.
      recordWriteError(error)
      scheduleRepair(activation)
    }
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
 * authoritative in-memory copy), cooldown-guarded, then push the full corpus
 * so the replica converges on the repaired rows. */
function scheduleRepair(activation: DatabaseModeRuntime) {
  const now = Date.now()
  if (now - activation.lastRepairAt < REPAIR_COOLDOWN_MS) return
  activation.lastRepairAt = now
  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    const files = jotai().get(databaseFilesAtom)
    await activation.store.replaceAll(notesFromFiles(files))
    activation.replica?.requestFullPush()
  })
}

// -----------------------------------------------------------------------------
// Pulls (boot + the SYNC triggers: visibility, focus, online)
// -----------------------------------------------------------------------------

/**
 * Queue a pull NOW: since-cursor when a cursor is stored, else the full
 * corpus. For deliberate acts — the sync button, a repair — where the user is
 * waiting on the answer.
 */
export function requestDatabasePull() {
  const activation = runtime
  if (!activation) return
  runPull(activation)
}

/**
 * Minimum gap between pulls triggered by ambient browser events.
 *
 * `focus`, `visibilitychange` and `online` are not user intent — they fire on
 * every alt-tab, every window raise, and in PAIRS (a tab switch raises both
 * `focus` and `visibilitychange`), for every open tab, forever. Wired straight
 * to a pull they produced ~3,100 pulls in a day against a corpus nobody had
 * written to: 412k rows read, 61% of the day's entire D1 budget, to learn
 * nothing 3,099 times (docs/scaling-thresholds.md).
 *
 * 30s is chosen against what a pull is FOR — noticing another device's edit.
 * A cross-device change that lands within 30 seconds is already indis-
 * tinguishable from one that lands instantly, because the writing device's
 * own push is debounced 2s and the reading human takes longer than that to
 * look. What it removes is the burst: alt-tabbing four times in ten seconds
 * is one pull, not eight.
 */
const AMBIENT_PULL_INTERVAL_MS = 30_000

/**
 * Queue a pull from an ambient trigger, coalescing bursts.
 *
 * At most one pull per `AMBIENT_PULL_INTERVAL_MS`: a trigger inside the gap
 * schedules a single pull at the boundary rather than running one, and
 * further triggers before it fires are absorbed into it. Nothing is dropped —
 * every burst still results in a pull, just one of them.
 */
export function requestAmbientDatabasePull() {
  const activation = runtime
  if (!activation) return
  // A pull is already scheduled for the end of this gap; it will cover this
  // trigger too.
  if (activation.ambientPullTimer !== null) return

  const wait = AMBIENT_PULL_INTERVAL_MS - (Date.now() - activation.lastPullStartedAt)
  if (wait <= 0) {
    runPull(activation)
    return
  }
  activation.ambientPullTimer = setTimeout(() => {
    activation.ambientPullTimer = null
    if (runtime === activation) runPull(activation)
  }, wait)
}

function runPull(activation: DatabaseModeRuntime) {
  if (activation.pullRetryTimer !== null) {
    clearTimeout(activation.pullRetryTimer)
    activation.pullRetryTimer = null
  }
  // This pull covers whatever the pending ambient one was going to fetch.
  if (activation.ambientPullTimer !== null) {
    clearTimeout(activation.ambientPullTimer)
    activation.ambientPullTimer = null
  }
  activation.lastPullStartedAt = Date.now()
  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    const store = activation.store
    patchStatus({ pull: "pulling" })
    try {
      const cursor = await store.getMeta(PULL_CURSOR_KEY)
      // An unusable cursor (never pulled, or not the ms-timestamp shape the
      // server compares against) degrades to a full pull — always correct,
      // just bigger. Both pulls answer in the same shape; a full pull is
      // simply "everything changed".
      const useSince = cursor !== null && /^\d+$/.test(cursor)
      const body: ReplicaChangesBody = useSince
        ? await activation.source.pullSince(cursor)
        : await activation.source.pullFull()
      if (runtime !== activation) return

      const local = await store.getAllRows()
      const pendingNoteIds = activation.replica?.pendingNoteIds?.() ?? new Set<string>()
      const plan = planPullApplication({
        localNodes: local.nodes,
        localLinks: local.links,
        remoteNodes: body.nodes,
        remoteLinks: body.links,
        pendingNodeIds: expandPendingNodeIds(pendingNoteIds, local.links),
      })

      const planSize =
        plan.nodes.length + plan.links.length + plan.deleteNodes.length + plan.deleteLinks.length
      if (planSize > 0) {
        await store.applyPull(plan)
        // Re-synthesize the whole files map — rollups are cheap at this scale
        // and identical contents keep their string equality for consumers.
        jotai().set(databaseFilesAtom, synthesizeFiles(await store.getAllNotes()))
      }
      if (body.cursor !== null) await store.setMeta(PULL_CURSOR_KEY, body.cursor)

      patchStatus({
        pull: "idle",
        lastPullAt: Date.now(),
        lastPullError: null,
        emptyOffline: false,
      })
      patchDiagnostics({
        notes: Object.keys(notesFromFiles(jotai().get(databaseFilesAtom))).length,
      })
    } catch (error) {
      if (runtime !== activation) return
      const message = error instanceof Error ? error.message : String(error)
      // A failed pull can leave the app showing nothing at all, so say why —
      // in the console as well as the status atom. Without this the only
      // symptom is an empty note list with no explanation anywhere.
      console.error("[ruminate] pull failed:", error)
      const localCount = Object.keys(notesFromFiles(jotai().get(databaseFilesAtom))).length
      patchStatus({
        pull: "error",
        lastPullError: message,
        // First-ever boot with an unreachable replica: nothing to show, and
        // that deserves an explanation rather than a silent empty list. An
        // expired session is NOT that state — it signs the machine out and
        // gets its own honest message (see use-database-mode.ts).
        emptyOffline: localCount === 0 && !(error instanceof SessionExpiredError),
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
