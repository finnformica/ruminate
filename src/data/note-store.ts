import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import type { CacheRow } from "./cache-rows"
import type { EntityKeys } from "./events"
import type { GraphSnapshot } from "./graph"
import type { KeyEvent, LoggedKeyEvent } from "./key-events"
import type { LazyReads } from "./sql-lazy-reads"

/**
 * The storage contract behind the `src/data` seam: the device's log and the
 * cache of its fold (docs/events-log-cache.md) — `events_log`,
 * `events_log_cache` and `meta`.
 *
 * The app holds the live graph in memory (`databaseGraphAtom`) and edits it
 * with ops (`src/data/ops.ts`); the runtime turns each batch into the
 * per-key EVENTS it amounts to (`opsToKeyEvents`, docs/event-sourcing.md).
 * The store keeps those events and the replica's — the log, the truth — and
 * the cache, one row per key of every block and link, updated in the same
 * transaction as each batch and each pulled page. Everything
 * markdown-shaped — parse, serialize, the rollup — lives above this seam
 * (`src/blocks`, `src/data/graph.ts`), so the store never sees markdown.
 * `openSqlNoteStore` (sql-note-store.ts) is the implementation the app runs
 * on.
 *
 * All methods are async so implementations backed by real databases fit
 * without changing callers.
 */
export interface NoteStore {
  /** The WHOLE live graph of the cache — every non-tombstoned node, and
   * every child link whose ends are live — indexed for walking
   * (`docFromGraph`, `noteDoc`), in one grouped read. What search and the
   * calendar ask for; the first screen and a note come lazily (`lazy`). */
  getGraph(): Promise<GraphSnapshot>
  /**
   * Record a batch of events this device made and apply them to the cache
   * rows they name, by stamp, in one transaction. The batch is applied
   * verbatim — the client decided what cascades (`docToOps`), so the store
   * and the snapshot the ops were applied to agree row for row.
   *
   * The events join the unpushed tail of the log, where a typing run
   * coalesces to its last event (`coalesceTyping`) — except events in
   * `frozen`, which a push has already picked up and must find as it left
   * them.
   */
  applyEvents(
    events: readonly KeyEvent[],
    options?: { frozen?: ReadonlySet<string> },
  ): Promise<void>
  /** The events not yet acknowledged by the replica, oldest first — the push
   * queue, durable across reloads. */
  unpushedEvents(): Promise<KeyEvent[]>
  /** Stamp events with the `seq` the replica gave them, and the cache rows
   * they set with it (a row's `seq` is its event's). */
  markEventsPushed(seqs: readonly (readonly [id: string, seq: number])[]): Promise<void>
  /**
   * Take in events pulled from the replica — everything the tenant's log
   * holds past the device's events cursor, this device's own among them, now
   * placed — and apply them to the cache rows they name, in one transaction.
   * An event already held (one of this device's own, pushed but never
   * answered) takes the `seq` it is pulled with, and changes nothing else.
   */
  applyPulledEvents(events: readonly LoggedKeyEvent[]): Promise<void>
  /** The tenant's log as this device holds it, in order: every placed event,
   * then this device's unpushed ones, provisionally sequenced after them
   * (`LoggedKeyEvent.pending`). What a day on the calendar is folded from. */
  eventLog(): Promise<LoggedKeyEvent[]>
  /** The fold by stamp of the named entities' events (`foldEventsToCache`),
   * read by the `events_log_entity` index — or of the whole log, with no
   * keys — as cache rows by `cacheRowKey`. The fold check compares it with
   * the cache (`src/data/fold-check.ts`). */
  foldOfLog(keys?: EntityKeys): Promise<Map<string, CacheRow>>
  /** The cache rows of the named entities, every key, tombstones too. */
  cacheRowsOf(keys: EntityKeys): Promise<CacheRow[]>
  /**
   * What a patch of the graph after a batch needs (`patchSnapshot`): the
   * live rows of the named blocks, and every live link among the named
   * links or adjacent to a named block — live by its own `deleted` row; the
   * patch judges its ends against the graph.
   */
  liveEntitiesOf(keys: EntityKeys): Promise<{ nodes: NodeRow[]; links: LinkRow[] }>
  /** Every block and link, **tombstones included** — what Settings' Recently
   * deleted reads, and the replica full-push source. */
  getAllRows(): Promise<{ nodes: NodeRow[]; links: LinkRow[] }>
  /** Take in one page of the replica's cache (docs/events-log-cache.md,
   * "Sync"): the rows land by stamp, as a batch's do. */
  importCacheRows(rows: readonly CacheRow[]): Promise<void>
  /** Apply the unpushed tail of the log to the cache by stamp, once more:
   * after a snapshot, so a local edit not yet pushed still wins where its
   * stamp is higher. */
  applyUnpushedToCache(): Promise<void>
  /** Rebuild the cache from the device's own log: the repair after a
   * failed write. */
  rebuildCacheFromLog(): Promise<void>
  /** Wipe the cache and keep the log: a device re-snapshots the replica's
   * (a new cache generation), its unpushed events still queued. */
  clearCache(): Promise<void>
  /** Wipe every corpus row — the cache and the device's log (meta is
   * kept). A cache reset, not a delete: nothing is tombstoned, so nothing
   * replicates — and an event not yet pushed goes with it, as an unpushed
   * row always did. */
  clear(): Promise<void>
  /** The lazy reads of the graph (`src/data/sql-lazy-reads.ts`): the first
   * screen at boot, a note when it is opened, a subtree when a row is
   * expanded, nodes by id. `getGraph` is the whole corpus, for what asks
   * for all of it. */
  lazy: LazyReads
  /** Read a `meta` key (e.g. the events cursor), or null when unset. */
  getMeta(key: string): Promise<string | null>
  /** Write a `meta` key. Kept in the same database as the rows it describes,
   * so wiping the store can never leave a stale cursor behind. */
  setMeta(key: string, value: string): Promise<void>
  close(): Promise<void>
}
