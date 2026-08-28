import { atom } from "jotai"

/**
 * Whether the note history dialog (for the currently open note) is visible.
 *
 * Lives in its own module — not in note-history-dialog.tsx — so entry points
 * (the note actions menu, the command palette) can open the dialog without
 * importing the dialog's heavy dependency graph (block editor, git layer).
 */
export const isNoteHistoryDialogOpenAtom = atom(false)

/**
 * Commit sha to preselect when the dialog opens (e.g. jumping straight to the
 * version a sync-conflict banner points at). Cleared when the dialog closes.
 */
export const noteHistoryInitialShaAtom = atom<string | null>(null)

/**
 * Programmatic entry point: open the history dialog, optionally at a specific
 * version. `useSetAtom(openNoteHistoryDialogAtom)` then `open({ sha })`.
 */
export const openNoteHistoryDialogAtom = atom(null, (_get, set, params?: { sha?: string }) => {
  set(noteHistoryInitialShaAtom, params?.sha ?? null)
  set(isNoteHistoryDialogOpenAtom, true)
})
