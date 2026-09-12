import { atom, getDefaultStore } from "jotai"
import {
  LEGACY_TIMESTAMP_CURSOR_FLOOR,
  type ReplicaChangesBody,
} from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
import { SessionExpiredError } from "../utils/github-token"
import {
  createD1NoteSource,
  expandPendingNodeIds,
  planPullApplication,
  type D1NoteSource,
} from "./d1-note-source"
import { PAGE_TYPE, buildGraphSnapshot, type GraphSnapshot } from "./graph"
import { applyOps, pagesTouchedBy, type Op } from "./ops"
import { resetReplicaAccess } from "./replica-access"
import type { ReplicaSyncHandle } from "./replica-sync"
import type { NoteStore } from "./note-store"
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
 *   edits  the editor's ops (src/data/ops.ts) apply to the graph atom at
 *          once, coalesce for a moment, then write the SQL store as rows and
 *          hand the row diff to the replica push queue (replica-sync.ts —
 *          write-behind, coalesced)
 *   sync   visibility/focus/online triggers re-run the since-cursor pull;
 *          hiding the tab flushes the push queue immediately
 *
 * **How the UI is fed.** This module publishes the store's indexed rows as
 * `databaseGraphAtom`, served as `graphSnapshotAtom` whenever a user is
 * signed in (see global-state.ts). Everything above reads that graph: the
 * note page walks its doc out of it, and note metadata, tags and search are
 * derived from it (`src/data/note-meta.ts`).
 *
 * **Conflicts are last-writer-wins per row**, decided by push order at the
 * replica. Pulls never touch rows of notes with queued/in-flight local pushes
 * (`ReplicaSyncHandle.pendingNoteIds`), and the editor's own remote-change
 * notice still protects unsaved (uncommitted) edits when a pulled change
 * lands under them.
 *
 * All SQL work is serialized on one promise queue; the graph and files atoms
 * are updated optimistically on write so the UI never waits on the database.
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
 * Generation `2` was the minted-page-id corpus (docs/graph-storage.md).
 *
 * Generation `3` retires deletion-by-absence. Pulls no longer carry the full
 * key list of each table, so a row HARD-deleted at the replica before soft
 * deletes existed — one that left no tombstone to replicate — would sit in a
 * device's cache forever, invisible to every future pull. One clean re-pull
 * settles it.
 *
 * Generation `4` is `notes_id` (migrations/0006): the replica backfilled every
 * block's note id; a cache from before carries none, and the local ladder
 * adds the column without a backfill, so one re-pull brings the ids down.
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
export const CACHE_GENERATION = "4"
const CACHE_GENERATION_KEY = "cache_generation"
const PULL_RETRY_MS = 60_000
/** How long a run of ops coalesces before it is written: a typed word is one
 * row write, not one per keystroke. Hiding the tab flushes at once. */
const OPS_FLUSH_MS = 150
/** Minimum gap between automatic repair rebuilds after a SQL write failure. */
const REPAIR_COOLDOWN_MS = 30_000

/** The graph with nothing in it — what the atom holds before the store opens
 * and after it closes. */
export const EMPTY_GRAPH: GraphSnapshot = buildGraphSnapshot([], [])

/**
 * The live graph (every node and child link the local store holds, indexed
 * for walking) served as `graphSnapshotAtom` while database mode is active.
 * The editor walks its note out of this; the files atom above is the same
 * data rolled up per page for the consumers that still read markdown.
 * Written only by this module: optimistically on a doc write, and from the
 * store after every ingest, repair and pull.
 */
export const databaseGraphAtom = atom<GraphSnapshot>(EMPTY_GRAPH)

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
    store: NoteStore
    persistence: "opfs" | "memory"
    /** Why persistence degraded to memory (e.g. another tab holds OPFS). */
    persistenceReason?: "another-tab" | "unavailable" | null
  }>
  /** Injectable for tests; defaults to the real replica push loop. Return
   * null to run without pushing. */
  openReplicaSync?: (
    getNoteCount: () => number,
    getAllRows: NoteStore["getAllRows"],
  ) => Promise<ReplicaSyncHandle | null>
  /** Injectable for tests; defaults to the real authed fetch source. */
  source?: D1NoteSource
  pullRetryMs?: number
}

interface DatabaseModeRuntime {
  options: DatabaseModeOptions
  store: NoteStore | null
  replica: ReplicaSyncHandle | null
  source: D1NoteSource
  pullRetryTimer: ReturnType<typeof setTimeout> | null
  /** Pending coalesced ambient pull (see `requestAmbientDatabasePull`). */
  ambientPullTimer: ReturnType<typeof setTimeout> | null
  /** When the last pull STARTED — the clock the ambient gap is measured on. */
  lastPullStartedAt: number
  lastRepairAt: number
  generation: number
  /** Ops applied to the graph atom and not yet written to the store. */
  pendingOps: Op[]
  /** Pages those ops touched — whose rollups the flush refreshes. */
  pendingPages: Set<NoteId>
  opsFlushTimer: ReturnType<typeof setTimeout> | null
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
  getNoteCount: () => number,
  getAllRows: NoteStore["getAllRows"],
) {
  const { startReplicaSync } = await import("./replica-sync")
  // Every tab pushes its own writes; concurrent tabs converge by per-row
  // last-writer-wins at the replica.
  return startReplicaSync({ getNoteCount, getAllRows })
}

/** How many pages the graph holds (the diagnostics' note count). */
function pageCount(graph: GraphSnapshot): number {
  let count = 0
  for (const node of graph.nodes.values()) if (node.type === PAGE_TYPE) count += 1
  return count
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
    pendingOps: [],
    pendingPages: new Set(),
    opsFlushTimer: null,
  }
  runtime = activation
  // Backgrounding the tab must not strand a coalescing run of ops.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHidden)
    document.addEventListener("visibilitychange", onPageHidden)
  }
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
        await opened.store.clear()
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
            await opened.store.clear()
            await opened.store.setMeta(PULL_CURSOR_KEY, "")
          }
          await opened.store.setMeta(OWNER_KEY, options.owner)
        }
        if (runtime !== activation) return
      }

      const graph = await opened.store.getGraph()
      if (runtime !== activation) return
      jotai().set(databaseGraphAtom, graph)
      patchStatus({ status: "ready" })
      patchDiagnostics({ status: "ready", notes: pageCount(graph) })

      // Start the push loop before the first pull, so the pull can consult
      // `pendingNoteIds` (edits made while the pull is in flight are safe).
      try {
        const replica = await (options.openReplicaSync ?? defaultOpenReplicaSync)(
          () => pageCount(jotai().get(databaseGraphAtom)),
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
  if (stopped.opsFlushTimer !== null) clearTimeout(stopped.opsFlushTimer)
  if (typeof window !== "undefined") {
    window.removeEventListener("pagehide", onPageHidden)
    document.removeEventListener("visibilitychange", onPageHidden)
  }
  enqueue(async () => {
    // Ops still coalescing are written before the store closes (no replica
    // to notify any more — the next boot's full push carries them).
    const ops = stopped.pendingOps
    stopped.pendingOps = []
    if (ops.length > 0) await stopped.store?.applyOps(ops).catch(recordWriteError)
    await stopped.store?.close().catch(() => {})
  })
  const store = jotai()
  store.set(databaseModeStatusAtom, OFF_STATUS)
  store.set(databaseGraphAtom, EMPTY_GRAPH)
  store.set(storageDiagnosticsAtom, OFF_STORAGE_DIAGNOSTICS)
  // A denial belongs to the account that was refused; the signed-out screen
  // (and any next sign-in) starts clean.
  resetReplicaAccess()
}

// -----------------------------------------------------------------------------
// Writes (the `store.ts` seam routes here in database mode)
// -----------------------------------------------------------------------------

/**
 * Apply a batch of graph ops (`src/data/ops.ts`) — the app's one change path.
 * The graph atom takes the ops synchronously (the screen never waits); the
 * store write coalesces for `OPS_FLUSH_MS` and then lands the same rows and
 * hands the row diff to the replica queue. Nothing here parses or
 * reconciles: the ops are the rows.
 */
export function databaseApplyOps(ops: readonly Op[]) {
  const activation = runtime
  if (!activation || ops.length === 0) return

  const store = jotai()
  const before = store.get(databaseGraphAtom)
  const after = applyOps(before, ops, Date.now())
  store.set(databaseGraphAtom, after)
  // Pages that reached a touched node before (an unlink) or after (a link).
  for (const page of pagesTouchedBy(before, ops)) activation.pendingPages.add(page)
  for (const page of pagesTouchedBy(after, ops)) activation.pendingPages.add(page)
  activation.pendingOps.push(...ops)
  patchStatus({ emptyOffline: false })

  if (activation.opsFlushTimer !== null) clearTimeout(activation.opsFlushTimer)
  activation.opsFlushTimer = setTimeout(() => {
    activation.opsFlushTimer = null
    if (runtime === activation) enqueue(() => flushOps(activation))
  }, OPS_FLUSH_MS)
}

/** Write the coalesced ops now (⌘S, tab hidden). */
export function requestDatabaseFlush() {
  const activation = runtime
  if (!activation || activation.pendingOps.length === 0) return
  if (activation.opsFlushTimer !== null) {
    clearTimeout(activation.opsFlushTimer)
    activation.opsFlushTimer = null
  }
  enqueue(() => flushOps(activation))
}

function onPageHidden() {
  if (typeof document !== "undefined" && document.visibilityState !== "hidden") return
  requestDatabaseFlush()
}

/**
 * Land the pending ops in the store: runs on the serial queue, and at the
 * head of every other queued task (a repair, a pull) so the store never
 * reads or rebuilds behind what the screen already shows.
 */
async function flushOps(activation: DatabaseModeRuntime) {
  if (runtime !== activation || !activation.store) return
  const ops = activation.pendingOps
  const pages = [...activation.pendingPages]
  if (ops.length === 0) return
  activation.pendingOps = []
  activation.pendingPages = new Set()
  try {
    const diff = await activation.store.applyOps(ops)
    activation.replica?.notifyGraphChange(pages, diff)
    patchDiagnostics({ notes: pageCount(jotai().get(databaseGraphAtom)) })
  } catch (error) {
    recordWriteError(error)
    scheduleRepair(activation)
  }
}

/** Re-read the graph atom from the store (after an ingest, repair or pull),
 * with any ops that arrived meanwhile re-applied on top — they are applied
 * on screen already and will land in the store on their own flush. */
async function refreshGraph(activation: DatabaseModeRuntime) {
  if (runtime !== activation || !activation.store) return
  const graph = await activation.store.getGraph()
  if (runtime !== activation) return
  jotai().set(databaseGraphAtom, applyOps(graph, activation.pendingOps, Date.now()))
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

/** After a SQL-side failure, rebuild the store from the graph atom (the
 * authoritative in-memory copy), cooldown-guarded, then push the full corpus
 * so the replica converges on the repaired rows. */
function scheduleRepair(activation: DatabaseModeRuntime) {
  const now = Date.now()
  if (now - activation.lastRepairAt < REPAIR_COOLDOWN_MS) return
  activation.lastRepairAt = now
  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    // The graph atom is the authoritative in-memory copy: rebuild from its
    // rows (the pending ops are in it already, so they are dropped here and
    // land through the rebuild).
    activation.pendingOps = []
    activation.pendingPages = new Set()
    const graph = jotai().get(databaseGraphAtom)
    await activation.store.clear()
    await activation.store.applyPull({
      nodes: [...graph.nodes.values()],
      links: [...graph.childLinks.values()].flat(),
      deleteNodes: [],
      deleteLinks: [],
    })
    await refreshGraph(activation)
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
      await flushOps(activation)
      const cursor = await store.getMeta(PULL_CURSOR_KEY)
      // An unusable cursor — never pulled, malformed, or a retired
      // pre-0005 timestamp — degrades to a full pull: always correct, just
      // bigger, and it comes back with a sequence cursor. Both pulls answer
      // in the same shape; a full pull is simply "everything changed".
      const useSince =
        cursor !== null && /^\d+$/.test(cursor) && Number(cursor) < LEGACY_TIMESTAMP_CURSOR_FLOOR
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
        await refreshGraph(activation)
      }
      if (body.cursor !== null) await store.setMeta(PULL_CURSOR_KEY, body.cursor)

      patchStatus({
        pull: "idle",
        lastPullAt: Date.now(),
        lastPullError: null,
        emptyOffline: false,
      })
      patchDiagnostics({ notes: pageCount(jotai().get(databaseGraphAtom)) })
    } catch (error) {
      if (runtime !== activation) return
      const message = error instanceof Error ? error.message : String(error)
      // A failed pull can leave the app showing nothing at all, so say why —
      // in the console as well as the status atom. Without this the only
      // symptom is an empty note list with no explanation anywhere.
      console.error("[ruminate] pull failed:", error)
      const localCount = pageCount(jotai().get(databaseGraphAtom))
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

/** Flush coalescing ops and wait for all queued work — tests only. */
export function flushDatabaseMode(): Promise<void> {
  requestDatabaseFlush()
  return queue
}
