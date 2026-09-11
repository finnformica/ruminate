import { useNavigate, useRouter } from "@tanstack/react-router"
import { useAtomValue, useSetAtom } from "jotai"
import { forwardRef, useState } from "react"
import { Drawer } from "vaul"
import { appUpdateAtom } from "../hooks/app-update"
import { cx } from "../utils/cx"
import { generateNoteId } from "../utils/note-id"
import { isCommandMenuOpenAtom } from "./command-menu"
import { IconButton, IconButtonProps } from "./icon-button"
import { ArrowLeftIcon16, ArrowRightIcon16, MenuIcon16, ComposeIcon16, SearchIcon16 } from "./icons"
import { NavItems } from "./nav-items"
import { SignInBanner } from "./sign-in-banner"
import { useAttentionTone } from "./sync-status"

export function NavBar() {
  const router = useRouter()
  const navigate = useNavigate()
  const setIsCommandMenuOpen = useSetAtom(isCommandMenuOpenAtom)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  // The drawer holds the sync status and the "Update Ruminate" item, so while
  // it is closed nothing on a phone says the app needs attention. The menu
  // button wears a dot instead: red for a failed sync or a dead sign-in,
  // amber for a sign-in about to expire, accent for a waiting update. Sync
  // trouble outranks an update, since it is what the reader must act on.
  const attention = useAttentionTone()
  const { needRefresh } = useAtomValue(appUpdateAtom)
  const badge = attention ?? (needRefresh ? "update" : null)
  const badgeLabel =
    badge === "danger"
      ? "needs attention"
      : badge === "pending"
        ? "sign in soon"
        : badge === "update"
          ? "update available"
          : null

  return (
    <div className="border-t border-border-secondary">
      <SignInBanner />
      <div className="flex h-(--height-nav-bar) items-stretch  p-2 [&>button]:h-full">
        <Drawer.Root
          open={isDrawerOpen}
          onOpenChange={setIsDrawerOpen}
          shouldScaleBackground={false}
        >
          <Drawer.Trigger asChild>
            <NavButton
              aria-label={
                badgeLabel ? `Open navigation menu (${badgeLabel})` : "Open navigation menu"
              }
            >
              <span className="relative flex">
                <MenuIcon16 />
                {badge ? (
                  <span
                    data-testid="nav-badge"
                    data-tone={badge}
                    aria-hidden
                    className={cx(
                      "absolute -right-1.5 -top-1.5 size-2.5 rounded-full ring-2 ring-bg",
                      badge === "danger" && "bg-text-danger",
                      badge === "pending" && "bg-text-pending",
                      badge === "update" && "bg-border-focus",
                    )}
                  />
                ) : null}
              </span>
            </NavButton>
          </Drawer.Trigger>
          <Drawer.Portal>
            <Drawer.Overlay className="fixed inset-0 bg-linear-to-t from-[#000000] to-[#00000000]" />
            <Drawer.Content className="fixed bottom-0 left-0 right-0 flex h-[80%] flex-col bg-bg-overlay rounded-t-xl outline-none">
              <div className="grid flex-1 scroll-py-2 grid-rows-[auto_1fr] overflow-y-auto p-3 pb-[max(env(safe-area-inset-bottom),12px)]">
                <Drawer.Title className="sr-only">Navigation</Drawer.Title>
                <NavItems size="large" onNavigate={() => setIsDrawerOpen(false)} />
              </div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
        <NavButton aria-label="Go back" onClick={() => router.history.back()}>
          <ArrowLeftIcon16 />
        </NavButton>
        <NavButton aria-label="Go forward" onClick={() => router.history.forward()}>
          <ArrowRightIcon16 />
        </NavButton>
        <NavButton aria-label="Open command menu" onClick={() => setIsCommandMenuOpen(true)}>
          <SearchIcon16 />
        </NavButton>
        <NavButton
          aria-label="New note"
          shortcut={["⌘", "⇧", "O"]}
          onClick={() =>
            navigate({
              to: "/notes/$",
              params: { _splat: generateNoteId() },
              search: {
                query: undefined,
              },
            })
          }
        >
          <ComposeIcon16 />
        </NavButton>
      </div>
    </div>
  )
}

const NavButton = forwardRef<HTMLButtonElement, IconButtonProps>(({ className, ...props }, ref) => {
  return (
    <IconButton
      ref={ref}
      size="small"
      disableTooltip
      className={cx("w-full!", className)}
      {...props}
    />
  )
})

NavButton.displayName = "NavButton"
