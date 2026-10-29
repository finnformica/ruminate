// @vitest-environment jsdom
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CORPUS_ROOT_ID } from "../data/graph"
import { NoteFavicon } from "./note-favicon"
import { RootLink } from "./root-link"

/**
 * **A page's icon leads back to Root, on a phone too** (`RootLink`). A tap
 * is a touch, then the pointer and mouse events a browser makes of it, then
 * the click: the link must go on that one tap, as on a mouse click.
 */

afterEach(cleanup)

async function renderAt(path: string) {
  const rootRoute = createRootRoute()
  const viewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/notes/$",
    component: () => (
      <RootLink>
        <NoteFavicon note={{ id: "note", type: "note" }} />
      </RootLink>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([viewRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(<RouterProvider router={router} />)
  await screen.findByTestId("root-link")
  return router
}

/** One finger tap, in the order iOS Safari and Android Chrome send it. */
function tap(element: Element) {
  const point = { clientX: 8, clientY: 8 }
  fireEvent.touchStart(element, { touches: [point], changedTouches: [point] })
  fireEvent.pointerDown(element, { pointerType: "touch", ...point })
  fireEvent.touchEnd(element, { touches: [], changedTouches: [point] })
  fireEvent.pointerUp(element, { pointerType: "touch", ...point })
  fireEvent.mouseDown(element, point)
  fireEvent.mouseUp(element, point)
  fireEvent.click(element, point)
}

describe("RootLink", () => {
  it("goes to Notes on one tap of the icon", async () => {
    const router = await renderAt("/notes/note")
    await act(async () => {
      tap(screen.getByTestId("favicon-default"))
    })
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe(`/notes/${CORPUS_ROOT_ID}`)
    })
  })

  it("has a hit area for a finger, around the 16px icon", async () => {
    await renderAt("/notes/note")
    const link = screen.getByRole("link", { name: "Notes" })
    expect(link.className).toContain("coarse:before:-inset-3")
    expect(link.className).toContain("touch-manipulation")
  })
})
