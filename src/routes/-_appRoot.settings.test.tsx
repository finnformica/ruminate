// @vitest-environment jsdom
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CORPUS_ROOT_ID } from "../data/graph"
import { Route as SettingsRoute } from "./_appRoot.settings"

/** The Settings header's icon leads back to Root, as a note's or a board's
 * does (`RootLink`). */

afterEach(cleanup)

async function renderSettings() {
  const rootRoute = createRootRoute()
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: SettingsRoute.options.component,
  })
  const notesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/notes/$",
    component: () => <div>Notes</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, notesRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByRole("link", { name: "Notes" })
  return router
}

describe("the Settings header's icon", () => {
  it("links to the notes page, at the same route the sidebar's Notes item uses", async () => {
    await renderSettings()
    const link = screen.getByRole("link", { name: "Notes" })
    expect(link.getAttribute("href")).toBe(`/notes/${CORPUS_ROOT_ID}`)
  })

  it("navigates there on click", async () => {
    const router = await renderSettings()
    fireEvent.click(screen.getByRole("link", { name: "Notes" }))
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe(`/notes/${CORPUS_ROOT_ID}`)
    })
  })
})
