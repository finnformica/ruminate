import type { GraphDiff, LinkRow, NodeRow, ViewRow } from "../../worker/handlers/replica-payload"
import type { EntityKeys, StampedState } from "./events"
import type { GraphSnapshot } from "./graph"
import type { DeltaMatValueRow, KeyEvent, LoggedKeyEvent } from "./key-events"

/**
 * The storage contract behind the `src/data` seam: a row store for the
 * schema v2 graph (docs/graph-schema-v2.md) — `nodes` + `link` + `meta`.
 *
 * The app holds the live graph in memory (`databaseGraphAtom`) and edits it
 * with ops (`src/data/ops.ts`); the runtime turns each batch into the per-key
 * EVENTS it amounts to (`opsToKeyEvents`, docs/event-sourcing.md). The store keeps
 * those events and the replica's — the log, the truth — and the rows as a
 * cache of the log's fold (docs/event-only-sync.md, "The cache"), updated in
 * the same transaction as each batch and each pulled page, and read by
 * index. Everything markdown-shaped — parse, serialize, the rollup — lives above
 * this seam (`src/blocks`, `src/data/graph.ts`), so the store never sees
 * markdown. `openSqlNoteStore` (sql-note-store.ts) is the implementation the
 * app runs on.
 *
 * All methods are async so implementations backed by real databases fit
 * without changing callers.
 */
export interface NoteStore {
  /** The live graph of the cache — every non-tombstoned node, and every
   * child link whose ends are live — indexed for walking (`docFromGraph`,
   * `noteDoc`). What the app renders from. */
  getGraph(): Promise<GraphSnapshot>
  /**
   * Record a batch of events this device made and apply them to the cache
   * rows they name, field by field by stamp, in one transaction — for
   * blocks, links and views alike (`src/data/events.ts`). The batch is
   * applied verbatim — the client decided what cascades (`docToOps`), so the
   * store and the snapshot the ops were applied to agree row for row.
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
  /** Stamp events with the `seq` the replica gave them, and the rows they
   * changed with it (the cursors' order; a row's `seq` is its last
   * event's). */
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
  /** The fold by stamp (`foldKeysByStamp`, assembled) of the named entities'
   * events, read by the `events_log_entity` index — or of the whole log,
   * with no keys. The fold check compares it with the cache
   * (`src/data/fold-check.ts`). */
  foldOfLog(keys?: EntityKeys): Promise<StampedState>
  /** The cache rows of the named entities, tombstones too: what the replica's
   * pulled rows are compared with. */
  getRowsOf(keys: EntityKeys): Promise<{ nodes: NodeRow[]; links: LinkRow[]; views: ViewRow[] }>
  /** The `delta_mat_values` rows of the named blocks: what the replica's pulled
   * key rows are compared with. */
  getDeltaMatValuesOf(ids: readonly string[]): Promise<DeltaMatValueRow[]>
  /** The lazy reads of the walk (docs/event-only-sync.md, "Lazy reads"):
   * the live child links of the named nodes, by `link_source`, in sibling
   * order; the live child links into them, by `link_destination` (an up
   * pivot); and the live nodes by id. A link with a tombstoned end is left
   * out, as `getGraph` leaves it out. */
  childLinksOf(sourceIds: readonly string[]): Promise<LinkRow[]>
  parentLinksOf(destinationIds: readonly string[]): Promise<LinkRow[]>
  nodesOf(ids: readonly string[]): Promise<NodeRow[]>
  /** Every row of every corpus table, **tombstones included** — the replica
   * full-push source, and a delete only reaches other devices if it travels. */
  getAllRows(): Promise<{ nodes: NodeRow[]; links: LinkRow[]; views: ViewRow[] }>
  /**
   * The live view rows (migrations/0015): the entrypoints into the graph —
   * where a view starts, what it keeps, how it lays that out, and whether it
   * is pinned. Not part of the graph, and not derivable from it: a view may
   * name a node somebody else owns, which is the whole reason it is a table.
   */
  getViews(): Promise<ViewRow[]>
  /** The live rows of the named entities, by the rules `getGraph` and
   * `getViews` read the whole tables with. The fold check after a batch
   * reads only what the batch touched (`src/data/fold-check.ts`). */
  getLiveRows(keys: EntityKeys): Promise<{ nodes: NodeRow[]; links: LinkRow[]; views: ViewRow[] }>
  /** Apply a planned pull (row upserts + deletes) in one transaction. Rows
   * land verbatim — remote `updated_at` and `deleted_at` are preserved — and
   * take the stamps their last event derives (`derivedStamps`). The pull of
   * rows no longer writes the cache; a repair from the screen does. */
  applyPull(plan: GraphDiff): Promise<void>
  /** Wipe every corpus row — nodes, links, views and the device's log (meta
   * is kept). A cache reset, not a delete: nothing is tombstoned, so nothing
   * replicates — and an event not yet pushed goes with it, as an unpushed
   * row always did. */
  clear(): Promise<void>
  /** Read a `meta` key (e.g. the D1 pull cursor), or null when unset. */
  getMeta(key: string): Promise<string | null>
  /** Write a `meta` key. Kept in the same database as the rows it describes,
   * so wiping the store can never leave a stale cursor behind. */
  setMeta(key: string, value: string): Promise<void>
  close(): Promise<void>
}
