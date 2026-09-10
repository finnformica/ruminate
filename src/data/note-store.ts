import type { GraphDiff } from "../../worker/handlers/replica-payload"
import type { BlockDoc } from "../blocks/types"
import type { NoteId } from "../schema"
import type { GraphSnapshot } from "./graph"
import type { Op } from "./ops"

/**
 * The storage contract behind the `src/data` seam, over the schema v2 graph
 * (docs/graph-schema-v2.md): note read/write/delete keyed by note id (reads
 * are the rollup, writes ingest markdown as row diffs), plus the graph
 * operations (containment queries, link add/remove with cycle rejection and
 * delete-rescue). `SqlNoteStore` (sql-note-store.ts) is the implementation the
 * app runs on; the conformance suite (`note-store-conformance.ts`) is the
 * executable specification any implementation must pass.
 *
 * All methods are async so implementations backed by real databases fit
 * without changing callers.
 */
export interface NoteStore {
  /** Rolled-up markdown of one note, or null when it does not exist. */
  getNote(id: NoteId): Promise<string | null>
  /** Rolled-up markdown of every note, keyed by note id. */
  getAllNotes(): Promise<Record<NoteId, string>>
  /** The live graph — every non-tombstoned node and child link — indexed for
   * walking (`docFromGraph`, `pageDoc`). What the app renders from. */
  getGraph(): Promise<GraphSnapshot>
  /**
   * Persist a batch of note writes/deletes in one transaction, from
   * markdown. Keys are note ids; a string value writes that note, `null`
   * deletes it. Returns the row-level diff the write produced (what the
   * replica queue pushes). This is the IMPORT path: the markdown is parsed
   * into typed blocks first — the editor's own saves go through
   * `writeNoteDocs`.
   */
  writeNotes(updates: Record<NoteId, string | null>): Promise<GraphDiff>
  /**
   * Persist a batch of note docs — the editor's typed blocks, exactly as it
   * holds them — with no markdown in between: `docToParts` turns each doc
   * into rows and the store reconciles them against what it has. A block the
   * doc names under two parents stays ONE node with two links. `null`
   * deletes. Returns the row-level diff.
   */
  writeNoteDocs(updates: Record<NoteId, BlockDoc | null>): Promise<GraphDiff>
  /**
   * Apply a batch of graph ops (`src/data/ops.ts`) as row writes, in one
   * transaction: `create`/`set*` upsert node rows, `link` upserts a link row
   * with the key the op carries, `unlink` and `delete` tombstone. The batch
   * is applied verbatim — the client decided what cascades (`docToOps`), so
   * the store and the snapshot it was applied to agree row for row. Returns
   * the row-level diff.
   */
  applyOps(ops: readonly Op[]): Promise<GraphDiff>
  /** Delete a single note (no-op when it does not exist). */
  deleteNote(id: NoteId): Promise<GraphDiff>
  /** Ids of the nodes containing this node (child links, deterministic order). */
  upstream(id: string): Promise<string[]>
  /** Ordered child ids of this node (sort-key order). */
  downstream(id: string): Promise<string[]>
  /**
   * Add a containment link. `position.after` names the sibling to insert
   * after (`null` = first; omitted = last). Rejects (throws) when either node
   * is missing, or when the link would create a cycle.
   */
  addLink(
    sourceId: string,
    destinationId: string,
    position?: { after?: string | null },
  ): Promise<void>
  /**
   * Remove a containment link — "delete" per the schema doc: unlink, and when
   * that removed the destination's last occurrence, delete its row and
   * re-parent its now-orphaned children to the page root (appended at the
   * end). Content is never destroyed while something still references it.
   */
  removeLink(sourceId: string, destinationId: string): Promise<void>
}
