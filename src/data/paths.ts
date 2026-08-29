/**
 * Paths of the view-state sidecar entries in the repo-file-shaped map.
 *
 * View state (e.g. which blocks are collapsed) is per-note UI state, kept in
 * `.ruminate/` — separate from note content — so folding a block never rewrites
 * a note. It is stored per note (`.ruminate/view-state/<noteId>.json`), backed
 * by the store's `view_state` table, and filtered out of the note pipeline
 * (see `notesAtom` and `noteContentsAtom`).
 */

/** Directory holding one view-state entry per note. */
export const VIEW_STATE_DIR = ".ruminate/view-state"

/** Path of the view-state entry for one note. */
export function viewStatePath(noteId: string): string {
  return `${VIEW_STATE_DIR}/${noteId}.json`
}
