import { useSetAtom } from "jotai"
import { BoardIcon16 } from "./icons"
import { newBoardDialogAtom } from "./new-board-dialog"
import { IconButton } from "./ui/icon-button"

/** The header's **New board**, beside New note (docs/boards.md). */
export function NewBoardButton() {
  const open = useSetAtom(newBoardDialogAtom)
  return (
    <IconButton aria-label="New board" size="small" onClick={() => open(true)}>
      <BoardIcon16 />
    </IconButton>
  )
}
