import { atom } from "jotai"

/**
 * Whether the note history dialog (for the currently open note) is visible.
 *
 * Lives in its own module — not in note-history-dialog.tsx — so entry points
 * (the note actions menu, the command palette, the merge-notice banner) can
 * open the dialog without importing the dialog's heavy dependency graph
 * (block editor, git layer).
 */
export const isNoteHistoryDialogOpenAtom = atom(false)

/**
 * Identifies a version to preselect when the dialog opens: the commit sha
 * that produced it, the file's blob oid at that version, or both. An oid
 * match is preferred — a merge-notice's losing commit sha may not itself be
 * a version entry (the losing tip may not have touched the note), but the
 * blob oid always matches the merge-side entry that carries the content.
 */
export type NoteHistoryTarget = { sha?: string; oid?: string }

/**
 * Version to preselect when the dialog opens (e.g. jumping straight to the
 * losing version a sync-conflict banner points at). Cleared when the dialog
 * closes.
 */
export const noteHistoryInitialVersionAtom = atom<NoteHistoryTarget | null>(null)

/**
 * Programmatic entry point: open the history dialog, optionally at a specific
 * version. `useSetAtom(openNoteHistoryDialogAtom)` then `open({ sha, oid })`.
 */
export const openNoteHistoryDialogAtom = atom(null, (_get, set, params?: NoteHistoryTarget) => {
  set(noteHistoryInitialVersionAtom, params ?? null)
  set(isNoteHistoryDialogOpenAtom, true)
})
