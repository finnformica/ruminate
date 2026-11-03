import { useSetAtom } from "jotai"
import { useSyncExternalStore } from "react"
import { useCreateNewNote } from "../hooks/create-new-note"
import { APP_SHORTCUTS, formatCombo } from "../shortcuts/registry"
import { BoardIcon16, ComposeIcon16, PlusIcon16, TrackerIcon16 } from "./icons"
import { newBoardDialogAtom } from "./new-board-dialog"
import { newTrackerDialogAtom } from "./new-tracker-dialog"
import { DropdownMenu } from "./ui/dropdown-menu"
import { IconButton } from "./ui/icon-button"

/** Tailwind's `sm`: from here up the sidebar (or the page header's nav
 * icons) holds the menu; below it, a page's own header does. */
const WIDE_QUERY = "(min-width: 640px)"

function query(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null
  return window.matchMedia(WIDE_QUERY)
}

function subscribe(onChange: () => void): () => void {
  const list = query()
  if (!list) return () => {}
  list.addEventListener("change", onChange)
  return () => list.removeEventListener("change", onChange)
}

/** Whether a copy for `on` belongs on this screen. Where `matchMedia` is
 * missing (jsdom) every copy draws. */
function useShownOn(on: "wide" | "phone"): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      const list = query()
      return list ? list.matches === (on === "wide") : true
    },
    () => true,
  )
}

/**
 * The header's **New** menu: one button for everything that can be made,
 * in the sidebar's header and in the page header while the sidebar is
 * away (`on="wide"`), and on a phone in a page's own header, beside Sort
 * and Filter (`on="phone"`). **New note** opens a fresh note; **New board** asks for a name
 * (`new-board-dialog.tsx`, docs/boards.md); **New tracker** too
 * (`new-tracker-dialog.tsx`, docs/trackers.md). A row with a shortcut shows
 * it, bound in `page-header.tsx` from the registry.
 *
 * A copy off its screen is not drawn at all, not only hidden by a class: a
 * trigger under `display: none` is still in the page, and a menu opened
 * from it anchors to its empty box at the window's top left.
 */
export function NewMenu({ on }: { on: "wide" | "phone" }) {
  const createNewNote = useCreateNewNote()
  const openNewBoard = useSetAtom(newBoardDialogAtom)
  const openNewTracker = useSetAtom(newTrackerDialogAtom)
  const shown = useShownOn(on)
  if (!shown) return null
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
