import { useSetAtom } from "jotai"
import { useCreateNewNote } from "../hooks/create-new-note"
import { APP_SHORTCUTS, formatCombo } from "../shortcuts/registry"
import { BoardIcon16, ComposeIcon16, PlusIcon16, TrackerIcon16 } from "./icons"
import { newBoardDialogAtom } from "./new-board-dialog"
import { newTrackerDialogAtom } from "./new-tracker-dialog"
import { DropdownMenu } from "./ui/dropdown-menu"
import { IconButton } from "./ui/icon-button"

/**
 * The header's **New** menu: one button for everything that can be made,
 * in the sidebar's header and in the page header while the sidebar is
 * away. **New note** opens a fresh note; **New board** asks for a name
 * (`new-board-dialog.tsx`, docs/boards.md); **New tracker** too
 * (`new-tracker-dialog.tsx`, docs/trackers.md). A row with a shortcut shows
 * it, bound in `page-header.tsx` from the registry.
 */
export function NewMenu() {
  const createNewNote = useCreateNewNote()
  const openNewBoard = useSetAtom(newBoardDialogAtom)
  const openNewTracker = useSetAtom(newTrackerDialogAtom)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton aria-label="New" size="small">
            <PlusIcon16 />
          </IconButton>
        }
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item
          icon={<ComposeIcon16 />}
          shortcut={formatCombo(APP_SHORTCUTS.newNote)}
          onClick={createNewNote}
        >
          New note
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={<BoardIcon16 />}
          shortcut={formatCombo(APP_SHORTCUTS.newBoard)}
          onClick={() => openNewBoard(true)}
        >
          New board
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={<TrackerIcon16 />} onClick={() => openNewTracker(true)}>
          New tracker
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
