// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/views/n1" }),
}))

const { NoteActionsMenu } = await import("./note-actions-menu")

/**
 * The note menu's Width item (H, page width): Fixed and Full set the width
 * of the pane the menu is in, and — in a split, where there is more than
 * one pane — **Use for all panes** sets the app setting and clears every
 * pane's own override.
 */

afterEach(cleanup)

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Note actions" }))
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
}

describe("the note menu's Width item", () => {
  it("shows Fixed and Full, and sets the pane's width on a click", async () => {
    const onWidth = vi.fn()
    render(
      <Provider store={createStore()}>
        <NoteActionsMenu noteId="n1" editor={{ showWidth: true, width: "full", onWidth }} />
      </Provider>,
    )
    await openMenu()
    expect(screen.getByRole("menuitem", { name: "Fixed" })).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: "Full" })).toBeTruthy()
    fireEvent.click(screen.getByRole("menuitem", { name: "Fixed" }))
    expect(onWidth).toHaveBeenCalledWith("fixed")
  })

  it("offers no 'Use for all panes' with one pane", async () => {
    render(
      <Provider store={createStore()}>
        <NoteActionsMenu
          noteId="n1"
          editor={{ showWidth: true, width: "fixed", onWidth: vi.fn() }}
        />
      </Provider>,
    )
    await openMenu()
    expect(screen.queryByRole("menuitem", { name: "Use for all panes" })).toBeNull()
  })

  it("offers 'Use for all panes' in a split, setting the app width", async () => {
    const onUseForAllPanes = vi.fn()
    render(
      <Provider store={createStore()}>
        <NoteActionsMenu
          noteId="n1"
          editor={{ showWidth: true, width: "full", onWidth: vi.fn(), onUseForAllPanes }}
        />
      </Provider>,
    )
    await openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Use for all panes" }))
    expect(onUseForAllPanes).toHaveBeenCalledWith("full")
  })
})
