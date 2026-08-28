import { HeadContent, Link, Outlet, createRootRoute } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import { createPortal } from "react-dom"
import { accentAtom } from "../global-state"
import { useThemeColor } from "../hooks/theme-color"

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  head: () => ({
    meta: [{ title: "Ruminate" }],
  }),
})

function NotFoundComponent() {
  return (
    <div className="p-4">
      Page not found.{" "}
      <Link to="/" search={{ query: undefined }} className="link">
        Go home
      </Link>
    </div>
  )
}

/** Reflect the persisted accent color onto <html> as `data-accent`. The
 * default (cyan) removes the attribute so the base tokens apply untouched.
 * (index.html applies the attribute pre-render to avoid a flash.) */
function useAccentColor() {
  const accent = useAtomValue(accentAtom)

  React.useLayoutEffect(() => {
    if (accent === "cyan") {
      document.documentElement.removeAttribute("data-accent")
    } else {
      document.documentElement.setAttribute("data-accent", accent)
    }
  }, [accent])
}

function RootComponent() {
  useThemeColor()
  useAccentColor()

  return (
    <>
      {createPortal(<HeadContent />, document.querySelector("head")!)}
      <Outlet />
    </>
  )
}
