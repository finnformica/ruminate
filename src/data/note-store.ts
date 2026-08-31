import type { GraphDiff } from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"

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
  /**
   * Persist a batch of note writes/deletes in one transaction. Keys are
   * note ids; a string value writes that note, `null` deletes it. Returns the
   * row-level diff the write produced (what the replica queue pushes).
   */
  writeNotes(updates: Record<NoteId, string | null>): Promise<GraphDiff>
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
