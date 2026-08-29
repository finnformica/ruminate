import { createFileRoute, Outlet } from "@tanstack/react-router"
import React from "react"
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
      className="flex h-screen w-screen flex-col bg-bg pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] print:h-auto print:w-full [@supports(height:100svh)]:h-[100svh]"
      data-vaul-drawer-wrapper=""
    >
      <AppLayout>
        <Outlet />
      </AppLayout>
      <CommandMenu />
      <GlobalShortcuts />
      <DevBar />
    </div>
  )
}
