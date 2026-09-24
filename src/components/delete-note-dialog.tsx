import { atom, useAtom, useAtomValue } from "jotai"
import { useDeleteNote } from "../hooks/note"
import { useNoteShare } from "../hooks/share"
import { notesAtom } from "../global-state"
import type { NoteId } from "../schema"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"

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
  const close = () => setRequest(null)

  if (request === null || note === undefined) return <Dialog open={false} />

  const text = note.displayName
  const label = text.length > LABEL_LENGTH ? `${text.slice(0, LABEL_LENGTH - 1)}…` : text

  const confirm = () => {
    deleteNote(request.noteId)
    close()
    request.onDeleted?.()
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <Dialog.Content title={`Delete “${label || "Untitled"}”?`}>
        <div className="flex flex-col gap-4">
          {/* What the delete takes, and where it goes, before the button that
              does it. The default focus stays on the window, not on Delete, so
              an Enter that was meant for the menu cannot land here. */}
          <p className="leading-5 text-text-secondary">
            {share === null ? (
              <>
                The note and everything only it holds will be deleted. You can restore it from{" "}
                <span className="text-text">Recently deleted</span> in Settings.
              </>
            ) : (
              <>
                This note was shared with you: deleting it deletes it from its owner’s notes too,
                along with everything only it holds.
              </>
            )}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={confirm}>
              Delete
            </Button>
            <Button onClick={close}>Cancel</Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
