// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DropdownMenu } from "./ui/dropdown-menu"

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/trackers/n1" }),
}))

const { NoteActionsMenu } = await import("./note-actions-menu")

/**
 * The page's own groups in the note menu (the tracker's Range and Layout):
 * drawn first, above the note's entries, and a pick with `closeOnClick`
 * off leaves the menu open.
 */

afterEach(cleanup)

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Note actions" }))
  await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
}

describe("the note menu's page groups", () => {
  it("draws the page's groups above the note's entries and keeps the menu open on a pick", async () => {
    const onPick = vi.fn()
    render(
      <Provider store={createStore()}>
        <NoteActionsMenu
          noteId="n1"
          surface="tracker"
          groups={
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Range</DropdownMenu.GroupLabel>
              <DropdownMenu.Item closeOnClick={false} selected onClick={() => onPick("week")}>
                Week
              </DropdownMenu.Item>
              <DropdownMenu.Item closeOnClick={false} onClick={() => onPick("month")}>
                Month
              </DropdownMenu.Item>
            </DropdownMenu.Group>
          }
        />
      </Provider>,
    )
    await openMenu()
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent)
    expect(items.indexOf("Week")).toBe(0)
    expect(items.indexOf("Month")).toBeLessThan(items.indexOf("Copy markdown"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Month" }))
    expect(onPick).toHaveBeenCalledWith("month")
    expect(screen.getByRole("menu")).toBeTruthy()
  })

  it("draws no page groups when the page passes none", async () => {
    render(
      <Provider store={createStore()}>
        <NoteActionsMenu noteId="n1" surface="tracker" />
      </Provider>,
    )
    await openMenu()
    expect(screen.queryByRole("menuitem", { name: "Week" })).toBeNull()
  })
})
