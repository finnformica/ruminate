import { useCreateNewNote } from "../hooks/create-new-note"
import { IconButton } from "./ui/icon-button"
import { ComposeIcon16 } from "./icons"

export function NewNoteButton() {
  const createNewNote = useCreateNewNote()

  return (
    <IconButton
      aria-label="New note"
      shortcut={["⌘", "⇧", "O"]}
      size="small"
      onClick={createNewNote}
    >
      <ComposeIcon16 />
    </IconButton>
  )
}
