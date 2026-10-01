import { useSetAtom } from "jotai"
import { useFeature } from "../data/features"
import { BoardIcon16 } from "./icons"
import { newBoardDialogAtom } from "./new-board-dialog"
import { IconButton } from "./ui/icon-button"

/** The header's **New board**, beside New note — where boards are on for
 * this account (docs/boards.md). */
export function NewBoardButton() {
  const enabled = useFeature("boards")
  const open = useSetAtom(newBoardDialogAtom)
  if (!enabled) return null
  return (
    <IconButton aria-label="New board" size="small" onClick={() => open(true)}>
      <BoardIcon16 />
    </IconButton>
  )
}
