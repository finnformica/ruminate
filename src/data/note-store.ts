import type { NoteId } from "../schema"

/**
 * The storage contract behind the `src/data` seam: note CRUD keyed by note id,
 * bulk read, and per-note view-state get/set. `SqlNoteStore`
 * (`sql-note-store.ts`) is the implementation the app runs on; the conformance
 * suite (`note-store-conformance.ts`) is the executable specification any
 * implementation must pass.
 *
 * All methods are async so implementations backed by real databases fit
 * without changing callers.
 */
export interface NoteStore {
  /** Raw markdown of one note, or null when it does not exist. */
  getNote(id: NoteId): Promise<string | null>
  /** Raw markdown of every note, keyed by note id. Never includes non-note files. */
  getAllNotes(): Promise<Record<NoteId, string>>
  /**
   * Persist a batch of note writes/deletes in one transaction. Keys are
   * note ids; a string value writes that note, `null` deletes it.
   */
  writeNotes(updates: Record<NoteId, string | null>): Promise<void>
  /** Delete a single note (no-op when it does not exist). */
  deleteNote(id: NoteId): Promise<void>
  /** Collapsed block ids for one note (empty when none recorded). */
  getViewState(noteId: NoteId): Promise<string[]>
  /**
   * Persist one note's collapsed block ids. An empty array clears the record.
   * The stored set is canonical (sorted, de-duplicated).
   */
  setViewState(noteId: NoteId, collapsedIds: string[]): Promise<void>
}
