/**
 * Repo-relative paths of the synced view-state sidecar files.
 *
 * View state (e.g. which blocks are collapsed) is per-note UI state, kept in
 * `.ruminate/` — separate from note content — so folding a block never rewrites
 * a note file. It rides the same git sync as notes but is filtered out of the
 * note pipeline (see `notesAtom` and `noteContentsAtom`).
 *
 * View state is stored per note (`.ruminate/view-state/<noteId>.json`) so two
 * devices folding blocks in different notes never touch the same file — the
 * single global sidecar used to be the main cross-device merge-conflict hot
 * spot. The legacy single-file sidecar (`.ruminate/view-state.json`) is still
 * read for a one-time lazy migration.
 */

/** Legacy single-file sidecar. Read-only; split into per-note files on the first write. */
export const LEGACY_VIEW_STATE_PATH = ".ruminate/view-state.json"

/** Directory holding one view-state file per note. */
export const VIEW_STATE_DIR = ".ruminate/view-state"

/** Repo-relative path of the view-state file for one note. */
export function viewStatePath(noteId: string): string {
  return `${VIEW_STATE_DIR}/${noteId}.json`
}
