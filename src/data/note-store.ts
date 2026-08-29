import type { NoteId } from "../schema"
import { buildViewStateWrite, readNoteViewState } from "./view-state-parse"

/**
 * The storage contract behind the `src/data` seam.
 *
 * `NoteStore` is the typed shape of what `src/data` provides today via hooks
 * (`useWriteNotes` / `useDeleteNoteFile` / `useGetNoteContents` +
 * view-state): note CRUD keyed by note id, bulk read, and per-note view-state
 * get/set. It exists so the backing store can be swapped — the git/markdown
 * implementation below wraps the existing machine-driven behavior, and Phase 2's
 * SQLite-backed store implements the same interface and must pass the same
 * conformance suite (`note-store-conformance.ts`) unchanged.
 *
 * All methods are async so implementations backed by real databases fit
 * without changing callers; the git adapter resolves synchronously underneath.
 */
export interface NoteStore {
  /** Raw markdown of one note, or null when it does not exist. */
  getNote(id: NoteId): Promise<string | null>
  /** Raw markdown of every note, keyed by note id. Never includes non-note files. */
  getAllNotes(): Promise<Record<NoteId, string>>
  /**
   * Persist a batch of note writes/deletes in one commit/transaction. Keys are
   * note ids; a string value writes that note, `null` deletes it.
   */
  writeNotes(updates: Record<NoteId, string | null>, commitMessage?: string): Promise<void>
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

/**
 * The primitives the git-backed store is built on — exactly the operations the
 * XState machine exposes today (`WRITE_FILES` with `null` deletes, and the
 * dedicated `DELETE_FILE` path). In the app these are wired to the machine; in
 * tests they are backed by an in-memory file map with the same semantics.
 */
export interface GitStoreBackend {
  /** Current repo files: path -> raw content. */
  getFiles(): Record<string, string>
  /** Write/delete a batch of files in one commit (`null` deletes). */
  writeFiles(files: Record<string, string | null>, commitMessage?: string): void
  /** Delete a single file (the machine's dedicated `DELETE_FILE` path). */
  deleteFile(filepath: string): void
}

const noteIdToPath = (id: NoteId) => `${id}.md`

/**
 * The current (git/markdown) implementation of `NoteStore`: a thin adapter over
 * the machine primitives. It reuses the exact same conventions as the hooks in
 * `store.ts` (`<id>.md` files, non-note-file exclusion) and the view-state
 * sidecar planning in `view-state-parse.ts` — no behavior is reimplemented.
 */
export function createGitNoteStore(backend: GitStoreBackend): NoteStore {
  return {
    getNote: (id) => {
      const content = backend.getFiles()[noteIdToPath(id)]
      return Promise.resolve(content ?? null)
    },

    getAllNotes: () => {
      const files = backend.getFiles()
      const contents: Record<NoteId, string> = {}
      for (const filepath in files) {
        if (!filepath.endsWith(".md")) continue
        contents[filepath.replace(/\.md$/, "")] = files[filepath]
      }
      return Promise.resolve(contents)
    },

    writeNotes: (updates, commitMessage) => {
      const files: Record<string, string | null> = {}
      for (const [id, content] of Object.entries(updates)) {
        files[noteIdToPath(id)] = content
      }
      backend.writeFiles(files, commitMessage)
      return Promise.resolve()
    },

    deleteNote: (id) => {
      backend.deleteFile(noteIdToPath(id))
      return Promise.resolve()
    },

    getViewState: (noteId) => {
      return Promise.resolve(readNoteViewState(backend.getFiles(), noteId))
    },

    setViewState: (noteId, collapsedIds) => {
      const updates = buildViewStateWrite(backend.getFiles(), noteId, collapsedIds)
      if (updates) backend.writeFiles(updates, "Update view state")
      return Promise.resolve()
    },
  }
}
