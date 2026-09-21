import { useAtom, useAtomValue } from "jotai"
import { useHotkeys } from "react-hotkeys-hook"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels"
import { useMedia } from "react-use"
import { isHelpPanelOpenAtom, sidebarAtom } from "../global-state"
import { useApplyUpdateShortcut, useRegisterAppUpdate } from "../hooks/app-update"
import { usePresence } from "../hooks/presence"
import { APP_SHORTCUTS, GLOBAL_HOTKEY_OPTIONS } from "../shortcuts/registry"
import { cx } from "../utils/cx"
import { HelpDrawer, HelpSidebar } from "./help-panel"
import { NavBar } from "./nav-bar"
import { Sidebar } from "./sidebar"
import { SignInBanner } from "./sign-in-banner"
import { WhatsNewPopover } from "./whats-new-popover"

type AppLayoutProps = {
  className?: string
  children?: React.ReactNode
}

export function AppLayout({ className, children }: AppLayoutProps) {
  const sidebar = useAtomValue(sidebarAtom)
  const [isHelpPanelOpen, setHelpPanel] = useAtom(isHelpPanelOpenAtom)
  const isWideViewport = useMedia("(min-width: 1024px)")
  // The service worker registers here, once, for every surface that shows
  // "an update is waiting" (sidebar item, phone nav-bar badge) — and the
  // keyboard's way of taking it (⌘⇧U).
  useRegisterAppUpdate()
  useApplyUpdateShortcut()
  const showHelpSidebar = isHelpPanelOpen && isWideViewport
  // The help panel is always in the layout on a wide screen, collapsed to
  // nothing when closed, and opens and closes by expanding and collapsing —
  // which is what lets its share of the width transition (index.css, "Panel
  // motion"), so its edge travels with its contents instead of jumping to
  // where they are going. The separator is kept until the contents have
  // gone (src/hooks/presence.ts).
  const helpPanel = usePanelRef()
  const helpPresent = usePresence(showHelpSidebar)
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "app-layout",
    panelIds: isWideViewport ? ["content", "help"] : ["content"],
    storage: window.localStorage,
  })
  // The layout the group mounts with is the closed one when the panel is
  // closed, and otherwise the remembered one — so that it is right from
  // its first paint, with no correcting afterwards; only a toggle is an
  // imperative resize. The width is only ever remembered open, for the
  // panel to open back to.
  const helpWidth = defaultLayout?.help || 30
  const mountLayout = useMemo(
    () => (isWideViewport && !isHelpPanelOpen ? { content: 100, help: 0 } : defaultLayout),
    [isWideViewport, isHelpPanelOpen, defaultLayout],
  )
  const rememberLayout = useCallback(
    (layout: Record<string, number>) => {
      if (layout.help !== 0) onLayoutChanged(layout)
    },
    [onLayoutChanged],
  )
  useEffect(() => {
    const panel = helpPanel.current
    if (!panel) return
    if (showHelpSidebar) panel.resize(`${helpWidth}%`)
    else panel.collapse()
  }, [showHelpSidebar, isWideViewport, helpWidth, helpPanel])
  // Nor must that first layout play as motion: the transition is switched on
  // a frame later.
  const [panelMotion, setPanelMotion] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPanelMotion(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  // Never while the reader is dragging the separator, or the panel would
  // trail the pointer.
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!dragging) return
    const done = () => setDragging(false)
    window.addEventListener("pointerup", done)
    window.addEventListener("pointercancel", done)
    return () => {
      window.removeEventListener("pointerup", done)
      window.removeEventListener("pointercancel", done)
    }
  }, [dragging])

  // Toggle help panel with Cmd/Ctrl + / (plain ? also toggles it — see
  // src/shortcuts/global-shortcuts.tsx)
  useHotkeys(
    APP_SHORTCUTS.helpPanel,
    () => {
      setHelpPanel((prev) => !prev)
    },
    GLOBAL_HOTKEY_OPTIONS,
  )

  return (
    <div className={cx("flex grow flex-col overflow-hidden print:overflow-visible", className)}>
      <div className="flex grow overflow-hidden">
        {sidebar === "expanded" ? (
          <div className="hidden w-56 shrink-0 sm:grid print:hidden">
            <Sidebar />
          </div>
        ) : null}
        <Group
          orientation="horizontal"
          className="grow overflow-hidden"
          data-panel-motion={panelMotion && !dragging}
          defaultLayout={mountLayout}
          onLayoutChanged={rememberLayout}
        >
          <Panel id="content" className="grid grid-rows-[1fr_auto] overflow-hidden">
            {/* The page, and hung off it the what's-new card
                (src/components/whats-new-popover.tsx). It sits in this row
                rather than over the window so that it clears the bottom
                chrome — the phone's nav bar and the sign-in banner inside it,
                and the banner below this panel on a wide screen — without
                having to know the height of any of them. */}
            <div className="relative grid overflow-hidden">
              {children}
              <WhatsNewPopover />
            </div>
            <div className="sm:hidden print:hidden">
              <NavBar />
            </div>
          </Panel>
          {isWideViewport ? (
            <>
              <Separator
                className={cx(
                  "relative w-px bg-border-secondary outline-none print:hidden",
                  !helpPresent && "hidden",
                )}
                onPointerDown={() => setDragging(true)}
              >
                <div className="absolute inset-y-0 -left-1.5 -right-1.5 z-raised" />
              </Separator>
              <Panel
                id="help"
                className="print:hidden"
                panelRef={helpPanel}
                collapsible
                defaultSize="30%"
                minSize="25%"
                maxSize="40%"
                // Dragged shut — below its minimum it collapses — the panel
                // is closed, as the keyboard would have closed it. Only under
                // the pointer: the layout also reports the collapsed size on
                // its way open, which must not close it again.
                onResize={(size) => {
                  if (dragging && size.asPercentage === 0 && isHelpPanelOpen) setHelpPanel(false)
                }}
              >
                <HelpSidebar open={showHelpSidebar} />
              </Panel>
            </>
          ) : null}
        </Group>
        {!isWideViewport ? <HelpDrawer /> : null}
      </div>
      <SignInBanner className="hidden sm:flex border-t border-border-secondary" />
    </div>
  )
}
