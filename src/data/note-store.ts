import type { GraphDiff, LinkRow, NodeRow, ViewRow } from "../../worker/handlers/replica-payload"
import type { RuminateEvent } from "./events"
import type { GraphSnapshot } from "./graph"

/**
 * The storage contract behind the `src/data` seam: a row store for the
 * schema v2 graph (docs/graph-schema-v2.md) — `nodes` + `link` + `meta`.
 *
 * The app holds the live graph in memory (`databaseGraphAtom`) and edits it
 * with ops (`src/data/ops.ts`); the runtime turns each batch into the EVENTS
 * it amounts to (`opsToEvents`, docs/event-sourcing.md), and the store's job
 * is to keep those events — the device's own log, and its push queue — and
 * the rows they project to, hand the rows back on boot, and take the
 * replica's rows in on a pull. Everything markdown-shaped — parse, serialize, the rollup — lives above
 * this seam (`src/blocks`, `src/data/graph.ts`), so the store never sees
 * markdown. `openSqlNoteStore` (sql-note-store.ts) is the implementation the
 * app runs on.
 *
 * All methods are async so implementations backed by real databases fit
 * without changing callers.
 */
export interface NoteStore {
  /** The live graph — every non-tombstoned node and child link — indexed for
   * walking (`docFromGraph`, `noteDoc`). What the app renders from. */
  getGraph(): Promise<GraphSnapshot>
  /**
   * Record a batch of events this device made and apply them to the rows, in
   * one transaction: a `create` inserts (or revives) a row, an `update` sets
   * the fields its patch names, a `delete` tombstones, a `restore` revives —
   * for blocks, links and views alike (`src/data/events.ts`). The batch is
   * applied verbatim — the client decided what cascades (`docToOps`), so the
   * store and the snapshot the ops were applied to agree row for row.
   *
   * The events join the unpushed tail of the log, where a typing run
   * coalesces to its last event (`coalesceTyping`) — except events in
   * `frozen`, which a push has already picked up and must find as it left
   * them.
   */
  applyEvents(
    events: readonly RuminateEvent[],
    options?: { frozen?: ReadonlySet<string> },
  ): Promise<void>
  /** The events not yet acknowledged by the replica, oldest first — the push
   * queue, durable across reloads. */
  unpushedEvents(): Promise<RuminateEvent[]>
  /** Stamp events with the `seq` the replica gave them, and the rows they
   * changed with the same (a row's `seq` is its last event's). */
  markEventsPushed(seqs: readonly (readonly [id: string, seq: number])[]): Promise<void>
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
  /** Apply a planned pull (row upserts + deletes) in one transaction. Rows
   * land verbatim — remote `updated_at` and `deleted_at` are preserved. */
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
