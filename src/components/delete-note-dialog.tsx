import { atom, useAtom, useAtomValue } from "jotai"
import { useDeleteNote } from "../hooks/note"
import { useNoteShare } from "../hooks/share"
import { notesAtom } from "../global-state"
import type { NoteId } from "../schema"
import { ConfirmDialog } from "./ui/confirm-dialog"

/**
 * "Delete" from a note's menu, in the header or on a sidebar row: the note
 * is named, so the dialog only asks whether to go ahead — a delete takes
 * everything only the note holds with it, and a menu item is one slip away
 * from the items beside it. Mounted once by the app root; a menu opens it by
 * setting `deleteNoteDialogAtom` to the note, with what to do once the note
 * is gone (the open note's page navigates away).
 *
 * The delete is the ordinary one (`deleteNoteOps`), and so recoverable: the
 * rows are only tombstoned, and Settings' Recently deleted restores them
 * (`src/data/deleted-notes.ts`). A note someone shared with the user is the
 * owner's, though — deleting it tombstones the owner's rows — so there the
 * dialog says so instead.
 */
export const deleteNoteDialogAtom = atom<DeleteNoteRequest | null>(null)

export interface DeleteNoteRequest {
  noteId: NoteId
  /** Called once the note is deleted, so the page it was open on can leave. */
  onDeleted?: () => void
}

/** How much of a title names the note in the dialog's title. */
const LABEL_LENGTH = 60

export function DeleteNoteDialog() {
  const [request, setRequest] = useAtom(deleteNoteDialogAtom)
  const notes = useAtomValue(notesAtom)
  const share = useNoteShare(request?.noteId)
  const deleteNote = useDeleteNote()

  const note = request === null ? undefined : notes.get(request.noteId)
  const text = note?.displayName ?? ""
  const label = text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 1)}…` : text

  return (
    <ConfirmDialog
      open={request !== null && note !== undefined}
      onOpenChange={(open) => (open ? undefined : setRequest(null))}
      title={`Delete “${label || "Untitled"}”?`}
      confirmLabel="Delete"
      variant="danger"
      onConfirm={() => {
        if (!request) return
        deleteNote(request.noteId)
        request.onDeleted?.()
      }}
    >
      {share === null ? (
        <>
          The note and everything only it holds will be deleted. You can restore it from{" "}
          <span className="text-text">Recently deleted</span> in Settings.
        </>
      ) : (
        <>
          This note was shared with you: deleting it deletes it from its owner’s notes too, along
          with everything only it holds.
        </>
      )}
    </ConfirmDialog>
  )
}
