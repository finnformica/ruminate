import { useRouter } from "@tanstack/react-router"
import { useAtom, useSetAtom } from "jotai"
import { useHotkeys } from "react-hotkeys-hook"
import { sidebarAtom } from "../global-state"
import { useCreateNewNote } from "../hooks/create-new-note"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS, formatCombo } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { IconButton } from "./ui/icon-button"
import { ArrowLeftIcon16, ArrowRightIcon16, SidebarCollapsedIcon16 } from "./icons"
import { newBoardDialogAtom } from "./new-board-dialog"
import { NewMenu } from "./new-menu"

export type PageHeaderProps = {
  title: React.ReactNode
  icon?: React.ReactNode
  className?: string
  actions?: React.ReactNode
  /** A pane after the first in a split view (docs/split-view.md): the
   * page's own keys and history buttons belong to the first pane's header,
   * so this one binds and draws neither. */
  secondary?: boolean
}

export function PageHeader({
  title,
  icon,
  className,
  actions,
  secondary = false,
}: PageHeaderProps) {
  const router = useRouter()
  const [sidebar, setSidebar] = useAtom(sidebarAtom)
  const createNewNote = useCreateNewNote()
  const openNewBoard = useSetAtom(newBoardDialogAtom)

  const hotkeyOptions = { ...GLOBAL_HOTKEY_OPTIONS, enabled: !secondary }

  // Toggle sidebar with Cmd/Ctrl + B
  useHotkeys(
    APP_SHORTCUTS.toggleSidebar,
    () => {
      setSidebar((prev) => (prev === "expanded" ? "collapsed" : "expanded"))
    },
    hotkeyOptions,
  )

  useHotkeys(APP_SHORTCUTS.newNote, createNewNote, hotkeyOptions)
  useHotkeys(APP_SHORTCUTS.newBoard, () => openNewBoard(true), hotkeyOptions)

  return (
    <div className={cx("@container/header", className)}>
      <header className="flex h-[var(--height-app-header)] items-center gap-2 px-2">
        {sidebar === "collapsed" && !secondary ? (
          <div className="hidden items-center sm:flex">
            <IconButton
              aria-label="Show sidebar"
              shortcut={["⌘", "B"]}
              tooltipAlign="start"
              size="small"
              onClick={() => setSidebar("expanded")}
            >
              <SidebarCollapsedIcon16 />
            </IconButton>
            <IconButton
              aria-label="Go back"
              shortcut={formatCombo(APP_SHORTCUTS.historyBack)}
              size="small"
              // TODO: Disable if you can't go back
              // https://stackoverflow.com/questions/3588315/how-to-check-if-the-user-can-go-back-in-browser-history-or-not
              onClick={() => router.history.back()}
              className="group"
            >
              <ArrowLeftIcon16 className="transition-transform group-active:-translate-x-0.5" />
            </IconButton>
            <IconButton
              aria-label="Go forward"
              shortcut={formatCombo(APP_SHORTCUTS.historyForward)}
              size="small"
              className="group"
              onClick={() => router.history.forward()}
            >
              <ArrowRightIcon16 className="transition-transform group-active:translate-x-0.5" />
            </IconButton>
            <NewMenu />
          </div>
        ) : null}
        {/* The rule between the nav buttons and the title, whether or not
            the title has an icon (a shared note carries its own, inline). */}
        {sidebar === "collapsed" && !secondary ? (
          <div role="separator" className="h-5 w-px bg-border hidden sm:block" />
        ) : null}
        <div className="flex w-0 grow items-center gap-3 px-2">
          {icon ? <div className="flex size-icon shrink-0 text-text-secondary">{icon}</div> : null}
          <div className="truncate">{title}</div>
        </div>
        <div className="flex items-center gap-2 justify-self-end">
          {actions ? <div className="flex items-center">{actions}</div> : null}
        </div>
      </header>
    </div>
  )
}
