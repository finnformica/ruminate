import { createFileRoute, Outlet } from "@tanstack/react-router"
import React from "react"
import { Toaster } from "sonner"
import { AppLayout } from "../components/app-layout"
import { CommandMenu } from "../components/command-menu"
import { DevBar } from "../components/dev-bar"
import { useDatabaseMode } from "../data/use-database-mode"
import { GlobalShortcuts } from "../shortcuts/global-shortcuts"

export const Route = createFileRoute("/_appRoot")({
  component: RouteComponent,
  head: () => ({
    links: [
      {
        rel: "icon",
        href: import.meta.env.DEV ? "/favicon-dev.svg" : "/favicon.svg",
      },
    ],
  }),
})

function RouteComponent() {
  const rootRef = React.useRef<HTMLDivElement>(null)

  // The database storage runtime (src/data/database-mode.ts): opens the local
  // SQL store, pulls from D1, and re-pulls when the app becomes visible or
  // the browser comes back online. Inert while signed out (sample notes).
  useDatabaseMode()

  // Apply overflow classes to parent elements
  React.useEffect(() => {
    if (!rootRef.current) return

    // Get all parent elements
    const parents: HTMLElement[] = []
    let parent = rootRef.current.parentElement
    while (parent) {
      parents.push(parent)
      parent = parent.parentElement
    }

    // Apply classes to all parent elements
    parents.forEach((element) => {
      element.classList.add("overflow-hidden", "overscroll-none", "print:overflow-visible")
    })

    // Clean up when component unmounts
    return () => {
      parents.forEach((element) => {
        element.classList.remove("overflow-hidden", "overscroll-none", "print:overflow-visible")
      })
    }
  }, [rootRef])

  return (
    <div
      ref={rootRef}
      className="app-frame flex w-screen flex-col bg-bg pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] print:w-full"
      data-vaul-drawer-wrapper=""
    >
      <AppLayout>
        <Outlet />
      </AppLayout>
      <CommandMenu />
      <GlobalShortcuts />
      <DevBar />
      {/* Toasts (sonner) — see "Notices" in docs/design-principles.md. Bottom
       * corner, above the phone nav bar (sonner's phone breakpoint is 600px,
       * a shade under the `sm` one that shows the bar), following the
       * system theme like the rest of the app. */}
      <Toaster
        theme="system"
        position="bottom-right"
        duration={6000}
        closeButton
        offset={16}
        mobileOffset={{
          bottom: "calc(var(--height-nav-bar) + env(safe-area-inset-bottom) + 16px)",
          left: 16,
          right: 16,
        }}
        style={{ fontFamily: "inherit" }}
      />
    </div>
  )
}
