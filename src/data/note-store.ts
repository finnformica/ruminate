import type { GraphDiff, LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import type { GraphSnapshot } from "./graph"
import type { Op } from "./ops"

/**
 * The storage contract behind the `src/data` seam: a row store for the
 * schema v2 graph (docs/graph-schema-v2.md) — `nodes` + `link` + `meta`.
 *
 * The app holds the live graph in memory (`databaseGraphAtom`) and edits it
 * with ops (`src/data/ops.ts`); the store's job is to persist those ops as
 * rows, hand the rows back on boot, and exchange them with the replica.
 * Everything markdown-shaped — parse, serialize, the rollup — lives above
 * this seam (`src/blocks`, `src/data/graph.ts`), so the store never sees
 * markdown. `openSqlNoteStore` (sql-note-store.ts) is the implementation the
 * app runs on.
 *
 * All methods are async so implementations backed by real databases fit
 * without changing callers.
 */
export interface NoteStore {
  /** The live graph — every non-tombstoned node and child link — indexed for
   * walking (`docFromGraph`, `pageDoc`). What the app renders from. */
  getGraph(): Promise<GraphSnapshot>
  /**
   * Apply a batch of graph ops as row writes, in one transaction:
   * `create`/`set*` upsert node rows, `link` upserts a link row with the key
   * the op carries, `unlink` and `delete` tombstone. The batch is applied
   * verbatim — the client decided what cascades (`docToOps`), so the store
   * and the snapshot it was applied to agree row for row. Returns the
   * row-level diff (what the replica queue pushes).
   */
  applyOps(ops: readonly Op[]): Promise<GraphDiff>
  /** Every row of both tables, **tombstones included** — the replica
   * full-push source, and a delete only reaches other devices if it travels. */
  getAllRows(): Promise<{ nodes: NodeRow[]; links: LinkRow[] }>
  /** Apply a planned pull (row upserts + deletes) in one transaction. Rows
   * land verbatim — remote `updated_at` and `deleted_at` are preserved. */
  applyPull(plan: GraphDiff): Promise<void>
  /** Wipe every node and link row (meta is kept). A cache reset, not a
   * delete: nothing is tombstoned, so nothing replicates. */
  clear(): Promise<void>
  /** Read a `meta` key (e.g. the D1 pull cursor), or null when unset. */
  getMeta(key: string): Promise<string | null>
  /** Write a `meta` key. Kept in the same database as the rows it describes,
   * so wiping the store can never leave a stale cursor behind. */
  setMeta(key: string, value: string): Promise<void>
  close(): Promise<void>
}
