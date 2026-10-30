import { atom, getDefaultStore } from "jotai"
import type { CachePageCursor } from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
import { SessionExpiredError } from "../utils/github-token"
import { createD1NoteSource, type D1NoteSource } from "./d1-note-source"
import type { EntityKeys, EventContext } from "./events"
import { cacheDifferences } from "./fold-check"
import {
  coalesceTypingKeys,
  keyEventStamp,
  opsToKeyEvents,
  type KeyEvent,
  type LoggedKeyEvent,
} from "./key-events"
import { buildGraphSnapshot, isNoteType, type GraphSnapshot } from "./graph"
import { emptyLazyGraph, mergeFragment, patchSnapshot, type GraphFragment } from "./graph-patch"
import { decodeHlc, encodeHlc, receiveHlc, tickHlc, type Hlc } from "./hlc"
import { applyOps, notesTouchedBy, type Op } from "./ops"
import { mintWriterId, writerDevice, writerTimezone } from "./writer-identity"
import { resetReplicaAccess } from "./replica-access"
import type { ReplicaSyncHandle } from "./replica-sync"
import type { CorpusRows } from "./deleted-notes"
import type { NoteStore } from "./note-store"
import { isBrowserOffline } from "../utils/network"
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
 *          not this one → serve local contents immediately → a device whose
 *          cache is empty takes a snapshot of the replica's (`pullCacheSnapshot`)
 *          → pull the log past the events cursor (`pullEventLog`)
 *   edits  the editor's ops (src/data/ops.ts) apply to the graph atom at
 *          once and become the EVENTS they amount to (`opsToEvents`,
 *          docs/event-sourcing.md); those coalesce for a moment, then land in
 *          the SQL store — appended to the device's log and applied to its
 *          rows in one transaction — and the push loop (replica-sync.ts —
 *          write-behind, coalesced) sends the log's unpushed tail to the
 *          replica
 *   sync   visibility/focus/online triggers re-run the since-cursor pull;
 *          hiding the tab flushes the push queue immediately. While the
 *          browser says it is offline neither pulls nor pushes are attempted
 *          — they wait for the `online` event, and nothing is an error
 *
 * **How the UI is fed.** The store's cache is the fold of the device's log,
 * key by key (docs/events-log-cache.md): each batch of this device's events
 * and each page of pulled events updates it in the same transaction as its
 * append. This module publishes the cache's live graph as
 * `databaseGraphAtom`, served as `graphSnapshotAtom` whenever a user is
 * signed in (see global-state.ts). The graph is loaded LAZILY (`loadGraph`,
 * `GraphSnapshot.loaded`): boot reads the first screen — the notes, their
 * order, one preview child each, the pinned nodes — so its cost grows with
 * the notes, not the blocks; a note is read whole when it is opened
 * (`databaseEnsureNote`), a subtree when a row is expanded
 * (`databaseEnsureBlocks`), and the whole corpus only when something asks
 * for all of it (`databaseEnsureAll`: search, the calendar). After a batch
 * only the entities it touched are read again and patched into the graph
 * (`patchGraph`), never the whole. Everything above reads that graph: the
 * note page walks its doc out of it, and note metadata and search are
 * derived from it (`src/data/note-meta.ts`). The fold check compares each
 * touched cache row with the fold of its entity's events (`fold-check.ts`)
 * and reports a difference with `console.error`. Sync is the log and
 * nothing else: no rows are pulled or pushed.
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

/** The last `seq` of the tenant's log this device has pulled into its own
 * (`NoteStore.eventLog`, docs/event-sourcing.md). */
const EVENTS_CURSOR_KEY = "events_pull_cursor"
/** Set once the device has taken a snapshot of the replica's cache
 * (`pullCacheSnapshot`); cleared with the cursor, so a wiped cache takes
 * one again before it pulls the log. */
const CACHE_SEEDED_KEY = "cache_seeded"
/** How many rows one page of the snapshot asks for (the replica's own
 * bound, `MAX_CACHE_PAGE`). */
const CACHE_PAGE = 20_000
/** How many events one page of the events pull asks for, and how many pages
 * one pull reads before leaving the rest to the next: a bound on a first
 * pull of a long log, never a limit on what arrives eventually. */
const EVENTS_PAGE = 2_000
const EVENTS_PAGES_PER_PULL = 10
/** The highest stamp this device has made or pulled (`src/data/hlc.ts`,
 * docs/event-only-sync.md), so a reload never stamps below it, even when the
 * clock went back meanwhile. Not a cursor: a wiped cache keeps it. */
const HLC_KEY = "hlc_last"
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
 * Generation `2` was the minted-note-id corpus (docs/graph-storage.md).
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
 * Generation `5` is the stored note-root type value (migrations/0008): every
 * cache holds `type = 'page'` note rows, and the code now looks for `'note'`
 * (`NOTE_TYPE`), so a cache left in place renders a corpus with no notes in
 * it. Unlike the generations above, though, the wipe is NOT the delivery
 * channel here: 0008 advances each rewritten row's `seq`, so the ordinary
 * since-pull carries it — one row per note — and a cache converges on its own.
 * The bump is kept as the belt to that pair of braces, for the gap the pull
 * cannot cover: a store is served into the atoms at boot BEFORE the first pull
 * lands, and stale `page` rows in that window are an empty corpus on screen
 * rather than the loading state a cleared store shows. Discarding once also
 * settles a device whose cursor is somehow ahead of the rewrite.
 *
 * Generation `7` is the board type (migrations/0020): every board's root is
 * retyped from `note` with a `board` prop to `board`, with its `updated_at`
 * moved so the since-pull carries the row as 0016 did; the wipe is the belt
 * to those braces for the same reason as generation `5` — a cache served at
 * boot before the first pull lands would show the old shape, which the new
 * code still reads (`isLegacyBoard`), until the pull replaced it.
 *
 * Generation `8` is the note view rows (migrations/0021): every note and
 * board is given a pinned view row, and the Views list is the pinned rows
 * (`src/data/views.ts`). The rows take fresh `seq` values, so the since-pull
 * carries them; the wipe is the belt to those braces, as for `5` and `7` —
 * a cache served at boot before the first pull lands holds no row for any
 * note, which the new code reads as an empty Views list until the pull
 * fills it.
 *
 * Generation `9` is the cache's `seq` columns (`LOCAL_V9_SQL`,
 * src/data/corpus-schema.ts): every row now records the replica's sequence
 * for it as last pulled, which is what an edit made here says it believed it
 * was changing (`base_seq`, docs/event-sourcing.md). The ladder adds the
 * columns empty; one re-pull fills them. Not a correctness matter — a null
 * `base_seq` is "the writer did not say" — but a cache whose every row says
 * that is a history that cannot tell an offline week's edit from a fresh one.
 *
 * Generation `10` is the per-key log (`LOCAL_V15_SQL`, migrations/0028,
 * docs/event-sourcing.md, "Per-key events"): the device's log is
 * `events_log`, one row per key, and each cache row holds a stamp per key of
 * its props. A cache from before holds one `props` stamp per row and the old
 * log; one re-pull brings the per-key log down and folds the rows from it.
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
export const CACHE_GENERATION = "11"
/**
 * The database the local copy was last pulled from — `"production"`, or a
 * preview clone's id — as the replica reports it (`replica_id` on every pull,
 * `Env.REPLICA_ID` on the Worker). A pull cursor is a row sequence issued by
 * ONE database: a preview clone rebuilt from production starts its sequence
 * wherever production was that day, which is behind any device that had
 * pushed to the previous clone at the same URL, so its since-pulls would
 * fetch nothing forever. When the id changes, the cache goes the way of a
 * stale generation: wiped, cursor included, and pulled again in full
 * (docs/preview-databases.md).
 */
const REPLICA_ID_KEY = "replica_id"

/**
 * Has the replica behind this URL been swapped for another database since
 * the local copy last pulled? Unknown (an older Worker sends no id) and
 * first contact (nothing stored yet) are both "no": neither is evidence of a
 * swap, and wiping on either would cost a device its unpushed edits for
 * nothing.
 */
function replicaIdentityChanged(stored: string | null, seen: string | undefined) {
  return typeof seen === "string" && seen.length > 0 && stored !== null && stored !== seen
}
const CACHE_GENERATION_KEY = "cache_generation"
const PULL_RETRY_MS = 60_000
/** How long a run of ops coalesces before it is written: a typed word is one
 * row write, not one per keystroke. Hiding the tab flushes at once. */
const OPS_FLUSH_MS = 150
/** Minimum gap between automatic repair rebuilds after a SQL write failure. */
const REPAIR_COOLDOWN_MS = 30_000
/** At most one fold check of a batch in this gap: the touched keys gather
 * meanwhile, so a typing run is one check. */
const FOLD_CHECK_MS = 10_000

/** The graph with nothing in it — what the atom holds before the store opens
 * and after it closes. */
export const EMPTY_GRAPH: GraphSnapshot = buildGraphSnapshot([], [])

/**
 * The live graph (every node and child link the local store holds, indexed
 * for walking) served as `graphSnapshotAtom` while database mode is active.
 * The editor walks its note out of this; the files atom above is the same
 * data rolled up per note for the consumers that still read markdown.
 * Written only by this module: optimistically on a doc write, and from the
 * store after every ingest, repair and pull.
 */
export const databaseGraphAtom = atom<GraphSnapshot>(EMPTY_GRAPH)

/**
 * Bumped whenever the device's log changed — a flush of its own events, a
 * pull of everyone's — so a reader of `databaseEventLog` (the calendar's day
 * view) knows to read again. The log itself is not held in an atom: it is
 * read from the store when a page needs it, which is rarely.
 */
export const eventLogVersionAtom = atom(0)

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
  openReplicaSync?: (store: ReplicaStoreAccess) => Promise<ReplicaSyncHandle | null>
  /** Injectable for tests; defaults to the real authed fetch source. */
  source?: D1NoteSource
  pullRetryMs?: number
  /** Injectable for tests: the gap between fold checks (`FOLD_CHECK_MS`). */
  foldCheckMs?: number
}

/** What the push loop reads and writes of the store: the queue of unpushed
 * events, and their acknowledgement. */
type ReplicaStoreAccess = Pick<NoteStore, "unpushedEvents" | "markEventsPushed">

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
  /** The same ops as the per-key events they amount to —
   * what the flush writes. A typing run coalesces to one event before it lands. */
  pendingEvents: KeyEvent[]
  /** Notes those ops touched — whose rollups the flush refreshes. */
  pendingNoteIds: Set<NoteId>
  opsFlushTimer: ReturnType<typeof setTimeout> | null
  /** The highest stamp this device has made or pulled: the next event's is
   * after it (`tickHlc`). Held here, saved under `HLC_KEY`. */
  lastStamp: Hlc | null
  /** The last events pull stopped at its page bound: the log is behind the
   * replica's, and the next pages are queued. The fold check waits. */
  logBehind: boolean
  foldCheckTimer: ReturnType<typeof setTimeout> | null
  /** The entities batches and pulls touched since the last fold check. */
  foldCheckKeys: { blocks: Set<string>; links: Set<string> }
  /** The notes the graph holds whole (`LazyReads.noteView`): opened once,
   * read again after a snapshot or a repair. */
  loadedNotes: Set<string>
  /** The whole corpus is in the graph (`databaseEnsureAll`): every read is
   * the whole graph from here on. */
  allLoaded: boolean
  /** Loads in flight, by what they load, so a second ask joins the first. */
  loading: Map<string, Promise<void>>
}

let runtime: DatabaseModeRuntime | null = null
let generation = 0
let queue: Promise<void> = Promise.resolve()

/** Serialize all SQL/pull work; one task's failure never breaks the chain. */
function enqueue(task: () => Promise<void>) {
  queue = queue.then(task).catch((error) => recordWriteError(error))
  return queue
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

/** A SQL-side write that failed: the atom and the push queue still carry
 * the content (a repair rebuilds the store from them). */
function recordWriteError(error: unknown) {
  console.error("[ruminate] store write failed:", error)
}

/** A wiped cache takes a snapshot again, and pulls the log again from the
 * start. */
async function resetCursors(store: NoteStore) {
  await store.setMeta(CACHE_SEEDED_KEY, "")
  await store.setMeta(EVENTS_CURSOR_KEY, "")
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

async function defaultOpenReplicaSync(store: ReplicaStoreAccess) {
  const { startReplicaSync } = await import("./replica-sync")
  // Every tab pushes its own writes; concurrent tabs converge per key by
  // stamp at the replica.
  return startReplicaSync({
    getUnpushedEvents: () => store.unpushedEvents(),
    markEventsPushed: (seqs) => store.markEventsPushed(seqs),
  })
}

/** How many notes the graph holds (the diagnostics' note count). */
function noteCount(graph: GraphSnapshot): number {
  let count = 0
  for (const node of graph.nodes.values()) if (isNoteType(node.type)) count += 1
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
    pendingEvents: [],
    pendingNoteIds: new Set(),
    opsFlushTimer: null,
    lastStamp: null,
    logBehind: false,
    foldCheckTimer: null,
    foldCheckKeys: noKeys(),
    loadedNotes: new Set(),
    allLoaded: false,
    loading: new Map(),
  }
  runtime = activation
  // Backgrounding the tab must not strand a coalescing run of ops.
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHidden)
    document.addEventListener("visibilitychange", onPageHidden)
  }
  jotai().set(databaseModeStatusAtom, { ...OFF_STATUS, status: "opening" })

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
      // — the cache, and the cursor with it, so the device takes a snapshot
      // again — rather than migrated in place. The log stays: its unpushed
      // events are still this device's to push, and the snapshot replays
      // them on top (`pullCacheSnapshot`).
      if ((await opened.store.getMeta(CACHE_GENERATION_KEY)) !== CACHE_GENERATION) {
        await opened.store.clearCache()
        await resetCursors(opened.store)
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
            await resetCursors(opened.store)
          }
          await opened.store.setMeta(OWNER_KEY, options.owner)
        }
        if (runtime !== activation) return
      }

      // The stamp the last session reached: an edit made while the store was
      // opening has stamped from the clock alone, so keep the higher.
      const saved = decodeHlc((await opened.store.getMeta(HLC_KEY)) ?? "")
      if (saved !== null) activation.lastStamp = receiveHlc(activation.lastStamp, saved)

      // The cache is the state: boot reads it, with nothing to fold.
      await refreshGraph(activation)
      if (runtime !== activation) return
      patchStatus({ status: "ready" })

      // Start the push loop before the first pull, so the pull can consult
      // `pendingNoteIds` (edits made while the pull is in flight are safe).
      try {
        const replica = await (options.openReplicaSync ?? defaultOpenReplicaSync)({
          unpushedEvents: () => activation.store?.unpushedEvents() ?? Promise.resolve([]),
          markEventsPushed: (seqs) => activation.store?.markEventsPushed(seqs) ?? Promise.resolve(),
        })
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
        recordWriteError(error)
      }
    }
  })

  // The initial pull: a snapshot of the cache on first boot, then the log.
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
  if (stopped.foldCheckTimer !== null) clearTimeout(stopped.foldCheckTimer)
  if (typeof window !== "undefined") {
    window.removeEventListener("pagehide", onPageHidden)
    document.removeEventListener("visibilitychange", onPageHidden)
  }
  enqueue(async () => {
    // Events still coalescing are written before the store closes (no
    // replica to notify any more — they wait in the log, and the next boot's
    // push loop finds them unpushed).
    const events = coalesceTypingKeys(stopped.pendingEvents)
    stopped.pendingOps = []
    stopped.pendingEvents = []
    const closing = stopped.store
    if (events.length > 0 && closing) {
      await closing
        .applyEvents(events)
        .then(() => saveStamp(stopped, closing))
        .catch(recordWriteError)
    }
    await closing?.close().catch(() => {})
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
 * The envelope one gesture's events share (docs/event-sourcing.md): a batch
 * id, this tab, the command when the caller names one, the writer's clock and
 * its zone. The ids and the stamps are minted here; `events.ts` makes none.
 * Each event takes the next stamp after the device's last (`tickHlc`), so the
 * events of one gesture stamp in the order they were made.
 */
function eventContext(activation: DatabaseModeRuntime, now: number, cause?: string): EventContext {
  const device = writerDevice()
  return {
    batch: mintWriterId("bat"),
    device,
    ...(cause ? { cause } : {}),
    at: now,
    tz: writerTimezone(),
    mintId: () => mintWriterId("evt"),
    stamp: () => {
      activation.lastStamp = tickHlc(activation.lastStamp, now, device)
      return encodeHlc(activation.lastStamp)
    },
  }
}

/** Save the device's last stamp beside the log it stamped (`HLC_KEY`). */
async function saveStamp(activation: DatabaseModeRuntime, store: NoteStore) {
  if (activation.lastStamp !== null) {
    await store.setMeta(HLC_KEY, encodeHlc(activation.lastStamp))
  }
}

/** Arm the coalescing flush: a run of ops is one store write. */
function scheduleFlush(activation: DatabaseModeRuntime) {
  if (activation.opsFlushTimer !== null) clearTimeout(activation.opsFlushTimer)
  activation.opsFlushTimer = setTimeout(() => {
    activation.opsFlushTimer = null
    if (runtime === activation) enqueue(() => flushOps(activation))
  }, OPS_FLUSH_MS)
}

/**
 * Apply a batch of graph ops (`src/data/ops.ts`) — the app's one change path.
 * The graph atom takes the ops synchronously (the screen never waits); the
 * ops become the events they amount to against the graph they were planned
 * on (`opsToEvents`), which coalesce for `OPS_FLUSH_MS` and then land in the
 * store — the device's log and its rows, in one write — for the push loop to
 * carry. Nothing here parses or reconciles: the ops are the events.
 * `cause` names the command, when the caller has one, for the history.
 */
export function databaseApplyOps(ops: readonly Op[], cause?: string) {
  const activation = runtime
  if (!activation || ops.length === 0) return
  const now = Date.now()
  const ctx = eventContext(activation, now, cause)

  const store = jotai()
  const before = store.get(databaseGraphAtom)
  const after = applyOps(before, ops, now)
  store.set(databaseGraphAtom, after)
  // Notes that reached a touched node before (an unlink) or after (a link).
  for (const note of notesTouchedBy(before, ops)) activation.pendingNoteIds.add(note)
  for (const note of notesTouchedBy(after, ops)) activation.pendingNoteIds.add(note)
  activation.pendingOps.push(...ops)
  activation.pendingEvents.push(...opsToKeyEvents(before, ops, ctx))
  patchStatus({ emptyOffline: false })
  scheduleFlush(activation)
}

/**
 * Write the coalesced ops now (⌘S, tab hidden, before an update reload).
 *
 * Resolves once the write has landed, so a caller that is about to throw the
 * page away (⌘⇧U) can wait for it; fire-and-forget callers ignore it.
 */
export function requestDatabaseFlush(): Promise<void> {
  const activation = runtime
  if (!activation || activation.pendingEvents.length === 0) return Promise.resolve()
  if (activation.opsFlushTimer !== null) {
    clearTimeout(activation.opsFlushTimer)
    activation.opsFlushTimer = null
  }
  return enqueue(() => flushOps(activation))
}

const bumpEventLog = () => jotai().set(eventLogVersionAtom, (n) => n + 1)

/**
 * The tenant's log as this device holds it (`NoteStore.eventLog`), once the
 * events still coalescing have landed — what the calendar folds a day from
 * (`src/data/day-changes.ts`). Null while the runtime is down or still
 * opening its store.
 */
export async function databaseEventLog(): Promise<LoggedKeyEvent[] | null> {
  const activation = runtime
  if (!activation) return null
  let log: LoggedKeyEvent[] | null = null
  await enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    await flushOps(activation)
    log = await activation.store.eventLog()
  })
  return log
}

/**
 * Every row the local store holds, tombstones included, once the ops still
 * coalescing have landed — what Settings' Recently deleted reads
 * (`src/data/deleted-notes.ts`). Null while the runtime is down or still
 * opening its store.
 */
export async function databaseAllRows(): Promise<CorpusRows | null> {
  const activation = runtime
  if (!activation) return null
  let rows: CorpusRows | null = null
  await enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    await flushOps(activation)
    rows = await activation.store.getAllRows()
  })
  return rows
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
  // A typing run is one event, not one per keystroke — coalesced here, where
  // the whole run is in hand, and again in the store against the unpushed
  // tail of the log (`NoteStore.applyEvents`).
  const events = coalesceTypingKeys(activation.pendingEvents)
  const notes = [...activation.pendingNoteIds]
  if (events.length === 0) return
  activation.pendingOps = []
  activation.pendingEvents = []
  activation.pendingNoteIds = new Set()
  touchEvents(activation, events)
  try {
    if (events.length > 0) {
      await activation.store.applyEvents(events, {
        frozen: activation.replica?.inFlightEventIds?.() ?? new Set(),
      })
      await saveStamp(activation, activation.store)
      // The screen has the ops already (`databaseApplyOps`); the patch
      // reconciles it with the cache, where a pulled event with a higher
      // stamp may have landed on the same key meanwhile.
      await patchGraph(activation, keysOf(events))
    }
    if (events.length > 0) {
      activation.replica?.notifyChange(notes)
      bumpEventLog()
    }
    scheduleFoldCheck(activation)
  } catch (error) {
    recordWriteError(error)
    scheduleRepair(activation)
  }
}

/**
 * The graph as the runtime holds it (docs/events-log-cache.md, "The
 * client"): the first screen (`rootView`) plus every note opened so far,
 * read whole again — or, once something asked for all of it, the whole
 * corpus in one grouped read, with every node loaded.
 */
async function loadGraph(
  activation: DatabaseModeRuntime,
  store: NoteStore,
): Promise<GraphSnapshot> {
  if (activation.allLoaded) {
    const graph = await store.getGraph()
    return { ...graph, loaded: new Set(graph.nodes.keys()) }
  }
  let graph = mergeFragment(emptyLazyGraph(), await store.lazy.rootView())
  for (const id of activation.loadedNotes) {
    graph = mergeFragment(graph, await store.lazy.noteView(id))
  }
  return graph
}

/** Re-read the graph atom from the cache (at boot, after a snapshot or a
 * repair), with any ops that arrived meanwhile re-applied on top — they are
 * applied on screen already and will land in the cache on their own flush.
 * After a batch, `patchGraph` instead. */
async function refreshGraph(activation: DatabaseModeRuntime) {
  if (runtime !== activation || !activation.store) return
  const graph = await loadGraph(activation, activation.store)
  if (runtime !== activation) return
  jotai().set(databaseGraphAtom, applyOps(graph, activation.pendingOps, Date.now()))
}

/** Merge a fragment into the graph atom, the pending ops re-applied on top
 * (a list the fragment holds whole may not know a link still coalescing). */
function mergeIntoGraph(activation: DatabaseModeRuntime, fragment: GraphFragment) {
  const store = jotai()
  const merged = mergeFragment(store.get(databaseGraphAtom), fragment)
  store.set(databaseGraphAtom, applyOps(merged, activation.pendingOps, Date.now()))
}

/** One load at a time per key: a second ask while one is in flight waits
 * for it rather than reading again. Runs on the queue, after the ops still
 * coalescing have landed, so the fragment is read from a cache the screen
 * is not ahead of. */
function loadOnce(activation: DatabaseModeRuntime, key: string, load: () => Promise<void>) {
  const held = activation.loading.get(key)
  if (held) return held
  const task = enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    await flushOps(activation)
    if (runtime !== activation) return
    await load()
  }).finally(() => activation.loading.delete(key))
  activation.loading.set(key, task)
  return task
}

/**
 * Load a note whole — its subtree, the blocks written in it and their
 * subtrees, and what else reaches any of them (`LazyReads.noteView`) — the
 * moment it is opened, so its page, its basket, a delete and a place count
 * read exactly. Nothing when the note is loaded already, the corpus is, or
 * the runtime is down. Resolves once the graph holds it.
 */
export function databaseEnsureNote(noteId: NoteId): Promise<void> {
  const activation = runtime
  if (!activation || activation.allLoaded || activation.loadedNotes.has(noteId)) {
    return Promise.resolve()
  }
  return loadOnce(activation, `note ${noteId}`, async () => {
    if (!activation.store || activation.allLoaded || activation.loadedNotes.has(noteId)) return
    const fragment = await activation.store.lazy.noteView(noteId)
    if (runtime !== activation) return
    activation.loadedNotes.add(noteId)
    mergeIntoGraph(activation, fragment)
  })
}

/**
 * Load the subtrees beneath these blocks: the rows a walk opened whose
 * children the graph held only in part (`GraphView.unloaded`). Ids the
 * graph holds whole already are skipped.
 */
export function databaseEnsureBlocks(ids: readonly string[]): Promise<void> {
  const activation = runtime
  if (!activation || activation.allLoaded) return Promise.resolve()
  const loaded = jotai().get(databaseGraphAtom).loaded
  const wanted = [...new Set(ids)].filter((id) => !(loaded?.has(id) ?? true)).sort()
  if (wanted.length === 0) return Promise.resolve()
  return loadOnce(activation, `blocks ${wanted.join(" ")}`, async () => {
    if (!activation.store || activation.allLoaded) return
    const fragment = await activation.store.lazy.subtreeView(wanted)
    if (runtime !== activation) return
    mergeIntoGraph(activation, fragment)
  })
}

/** Load just these nodes (a recent block, a pinned one the list names),
 * nothing beneath them. Ids the graph holds are skipped. */
export function databaseEnsureNodes(ids: readonly string[]): Promise<void> {
  const activation = runtime
  if (!activation || activation.allLoaded) return Promise.resolve()
  const nodes = jotai().get(databaseGraphAtom).nodes
  const wanted = [...new Set(ids)].filter((id) => !nodes.has(id)).sort()
  if (wanted.length === 0) return Promise.resolve()
  return loadOnce(activation, `nodes ${wanted.join(" ")}`, async () => {
    if (!activation.store || activation.allLoaded) return
    const fragment = await activation.store.lazy.nodesView(wanted)
    if (runtime !== activation) return
    mergeIntoGraph(activation, fragment)
  })
}

/**
 * Load the whole corpus, once: what search, the calendar's date mentions
 * and anything else that asks a question of every block need. From then
 * on every read of the graph is the whole graph.
 */
export function databaseEnsureAll(): Promise<void> {
  const activation = runtime
  if (!activation || activation.allLoaded) return Promise.resolve()
  return loadOnce(activation, "all", async () => {
    if (!activation.store || activation.allLoaded) return
    activation.allLoaded = true
    await refreshGraph(activation)
  })
}

/**
 * Patch the graph atom with the entities a batch touched
 * (docs/events-log-cache.md, "Each new event"): their live rows and the
 * live links adjacent to them are read again (`liveEntitiesOf`), and only
 * they are replaced (`patchSnapshot`); any ops that arrived meanwhile are
 * re-applied on top, as `refreshGraph` does. Nothing is rebuilt from every
 * row.
 */
async function patchGraph(activation: DatabaseModeRuntime, keys: EntityKeys) {
  if (runtime !== activation || !activation.store) return
  if (keys.blocks.size + keys.links.size === 0) return
  const rows = await activation.store.liveEntitiesOf(keys)
  if (runtime !== activation) return
  const store = jotai()
  const patched = patchSnapshot(store.get(databaseGraphAtom), keys, rows)
  store.set(databaseGraphAtom, applyOps(patched, activation.pendingOps, Date.now()))
}

const noKeys = () => ({ blocks: new Set<string>(), links: new Set<string>() })

/** The cached entities a batch of events names. A view event is history
 * only (docs/removing-views.md): no cache row, nothing to check or patch. */
function keysOf(events: readonly KeyEvent[]): { blocks: Set<string>; links: Set<string> } {
  const keys = noKeys()
  for (const event of events) {
    if (event.entity === "block") keys.blocks.add(event.entity_id)
    else if (event.entity === "link") keys.links.add(event.entity_id)
  }
  return keys
}

/** Note the entities a batch of events names, for the next fold check. */
function touchEvents(activation: DatabaseModeRuntime, events: readonly KeyEvent[]) {
  const keys = keysOf(events)
  for (const id of keys.blocks) activation.foldCheckKeys.blocks.add(id)
  for (const id of keys.links) activation.foldCheckKeys.links.add(id)
}

/** Queue a fold check of what batches touched, at most one per
 * `FOLD_CHECK_MS`. Called after each batch: an edit, a pull. */
function scheduleFoldCheck(activation: DatabaseModeRuntime) {
  if (activation.foldCheckTimer !== null) return
  activation.foldCheckTimer = setTimeout(() => {
    activation.foldCheckTimer = null
    if (runtime === activation) enqueue(() => checkFold(activation))
  }, activation.options.foldCheckMs ?? FOLD_CHECK_MS)
}

/**
 * The fold check (`fold-check.ts`): find where the cache differs from the
 * truth, and report it with `console.error`, one line per register with its
 * entity's id. There is no reporting path to the Worker, so the report
 * stays in the browser's console; the replica's own check is
 * `GET /api/replica/verify`. Runs on the queue, so no write lands between
 * its reads, and reads only what batches touched since the last check:
 * each touched entity's cache rows against the fold of its events in the
 * log (`foldOfLog`, by the `events_log_entity` index).
 *
 * While the events pull is behind, there is no check: what it needs waits.
 */
async function checkFold(activation: DatabaseModeRuntime) {
  if (runtime !== activation || !activation.store) return
  if (activation.logBehind) return
  const store = activation.store
  const keys: EntityKeys = activation.foldCheckKeys
  activation.foldCheckKeys = noKeys()
  if (keys.blocks.size + keys.links.size === 0) return
  try {
    const found = cacheDifferences(await store.foldOfLog(keys), await store.cacheRowsOf(keys))
    if (runtime !== activation) return
    if (found.length > 0) {
      console.error("[ruminate] fold check: the cache differs from the truth:", found)
    }
  } catch (error) {
    console.error("[ruminate] fold check failed", error)
  }
}

/** After a SQL-side failure, rebuild the cache from the device's own log
 * (the truth it holds), cooldown-guarded. The ops still coalescing are
 * written again first; the unpushed tail stays queued for the push loop. */
function scheduleRepair(activation: DatabaseModeRuntime) {
  const now = Date.now()
  if (now - activation.lastRepairAt < REPAIR_COOLDOWN_MS) return
  activation.lastRepairAt = now
  enqueue(async () => {
    if (runtime !== activation || !activation.store) return
    await flushOps(activation)
    if (runtime !== activation || !activation.store) return
    await activation.store.rebuildCacheFromLog()
    await refreshGraph(activation)
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
    // No network: skip rather than fail. The status stays as it was (the
    // sidebar reads "Offline" over it), the `online` event pulls when the
    // network is back (use-database-mode.ts), and the retry timer re-checks
    // in case the flag flips without one. A first-ever boot with nothing
    // local still gets the empty-offline notice.
    if (isBrowserOffline()) {
      patchStatus({ emptyOffline: noteCount(jotai().get(databaseGraphAtom)) === 0 })
      // A skipped pull is not a pull: leave the ambient gap open, so the
      // `online` event's pull runs at once rather than up to 30s later.
      activation.lastPullStartedAt = 0
      activation.pullRetryTimer = setTimeout(() => {
        activation.pullRetryTimer = null
        if (runtime === activation) runPull(activation)
      }, activation.options.pullRetryMs ?? PULL_RETRY_MS)
      return
    }
    patchStatus({ pull: "pulling" })
    try {
      await flushOps(activation)
      // A device whose cache is empty — a fresh profile, a wiped cache —
      // takes a snapshot of the replica's first, so every note shows now,
      // and the log catches up behind it. A different database behind the
      // URL wipes everything and starts the pull over, once.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!(await cacheSeeded(store))) {
          await pullCacheSnapshot(activation, store)
          if (runtime !== activation) return
        }
        const startOver = await pullEventLog(activation, store)
        if (runtime !== activation) return
        if (!startOver) break
      }

      patchStatus({
        pull: "idle",
        lastPullAt: Date.now(),
        lastPullError: null,
        emptyOffline: false,
      })
      scheduleFoldCheck(activation)
    } catch (error) {
      if (runtime !== activation) return
      const message = error instanceof Error ? error.message : String(error)
      // A failed pull can leave the app showing nothing at all, so say why —
      // in the console as well as the status atom. Without this the only
      // symptom is an empty note list with no explanation anywhere.
      console.error("[ruminate] pull failed:", error)
      const localCount = noteCount(jotai().get(databaseGraphAtom))
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

/** Has this device taken a snapshot of the replica's cache? False on a
 * fresh profile and after a wipe (`resetCursors`). */
async function cacheSeeded(store: NoteStore): Promise<boolean> {
  const held = await store.getMeta(CACHE_SEEDED_KEY)
  return held !== null && held !== ""
}

/**
 * A different database behind the same URL (a rebuilt preview clone): the
 * rows AND the cursors belong to the old one. Same wipe as a stale cache
 * generation; the caller starts the pull over. Records the id otherwise.
 */
async function adoptReplica(
  activation: DatabaseModeRuntime,
  store: NoteStore,
  seen: string | undefined,
): Promise<boolean> {
  const changed = replicaIdentityChanged(await store.getMeta(REPLICA_ID_KEY), seen)
  if (changed) {
    // The cache, the log AND the cursors belong to the old database: its
    // placed events are not this one's history, so all of it goes, as an
    // owner change wipes it.
    await store.clear()
    await resetCursors(store)
    activation.loadedNotes.clear()
  }
  // The id is recorded either way, so the next page is this database's.
  if (typeof seen === "string" && seen.length > 0) await store.setMeta(REPLICA_ID_KEY, seen)
  return changed
}

/**
 * The first screen of a device whose cache is empty: the replica's cache,
 * page by page (`pullCache`, keyset-paged), written as it is — every row at
 * the stamp the replica holds for it — then this device's unpushed events
 * replayed on top by stamp, so a local edit not yet pushed still wins where
 * it should, and the graph drawn at once. The log then catches up in pages
 * behind the screen (`pullEventLog`): an event the cache already holds
 * changes nothing (its stamp does not beat the row's), a later one lands as
 * on any cache row (docs/events-log-cache.md, "Sync is the log").
 */
async function pullCacheSnapshot(activation: DatabaseModeRuntime, store: NoteStore) {
  let after: CachePageCursor | null = null
  for (;;) {
    const page = await activation.source.pullCache(after, CACHE_PAGE)
    if (runtime !== activation) return
    if (after === null && (await adoptReplica(activation, store, page.replica_id))) {
      // The cache was wiped under us: start the snapshot over, on the new
      // database's rows.
      continue
    }
    await store.importCacheRows(page.rows)
    if (page.cursor === null) break
    after = page.cursor
  }
  await store.applyUnpushedToCache()
  await store.setMeta(CACHE_SEEDED_KEY, String(Date.now()))
  await refreshGraph(activation)
}

/**
 * Bring the device's log up to the replica's: every event past the events
 * cursor, in pages, into the store's log and cache (`applyPulledEvents`) —
 * this device's own among them, placed. A long log (a first pull) is read
 * a bounded number of pages at a time, and the next run queued at once
 * (`logBehind`) until it is caught up. On a device that just took a
 * snapshot the log starts from 0: the pages up to the snapshot change
 * nothing in the cache (their stamps do not beat the rows'), and the log
 * is pulled whole for history, which the calendar folds a day from.
 *
 * The graph is patched after **each page** that brought events, with the
 * entities the page touched (`patchGraph`), never rebuilt whole.
 */
async function pullEventLog(activation: DatabaseModeRuntime, store: NoteStore): Promise<boolean> {
  const held = await store.getMeta(EVENTS_CURSOR_KEY)
  let since = held !== null && /^\d+$/.test(held) ? Number(held) : 0
  let changed = false
  let behind = false
  for (let page = 0; page < EVENTS_PAGES_PER_PULL; page += 1) {
    const { events, cursor, replica_id } = await activation.source.pullEvents(since, EVENTS_PAGE)
    if (runtime !== activation) return false
    if (page === 0 && (await adoptReplica(activation, store, replica_id))) {
      // A different database answered: everything was wiped, and the pull
      // starts over — a snapshot of this one's, and its log from the start.
      return true
    }
    if (events.length > 0) {
      await store.applyPulledEvents(events)
      touchEvents(activation, events)
      // A device that has seen an edit stamps after it, whatever its clock
      // says. An event from before stamps moves it by the stamp it derives.
      for (const event of events) {
        const stamp = decodeHlc(keyEventStamp(event))
        if (stamp !== null) activation.lastStamp = receiveHlc(activation.lastStamp, stamp)
      }
      await saveStamp(activation, store)
      await patchGraph(activation, keysOf(events))
      if (runtime !== activation) return false
      changed = true
    }
    if (cursor === null || cursor <= since) break
    since = cursor
    await store.setMeta(EVENTS_CURSOR_KEY, String(since))
    if (events.length < EVENTS_PAGE) break
    behind = page === EVENTS_PAGES_PER_PULL - 1
  }
  activation.logBehind = behind
  if (changed) bumpEventLog()
  if (behind) {
    enqueue(async () => {
      if (runtime !== activation || !activation.store) return
      await flushOps(activation)
      await pullEventLog(activation, activation.store).catch((error) => {
        // The next pull carries on from the cursor.
        console.error("[ruminate] events pull failed:", error)
      })
      if (!activation.logBehind) scheduleFoldCheck(activation)
    })
  }
  return false
}

/** Flush coalescing ops and wait for all queued work — tests only. */
export function flushDatabaseMode(): Promise<void> {
  requestDatabaseFlush()
  return queue
}
