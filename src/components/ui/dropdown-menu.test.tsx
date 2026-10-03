// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DropdownMenu } from "./dropdown-menu"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** A finger: `(pointer: coarse)` matches. */
function stubCoarsePointer() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

function Branching() {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger>Open</DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Submenu>
          <DropdownMenu.SubmenuTrigger>Type</DropdownMenu.SubmenuTrigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item closeOnClick={false}>Todo</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Submenu>
        <DropdownMenu.Submenu>
          <DropdownMenu.SubmenuTrigger>Sort</DropdownMenu.SubmenuTrigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item>Ascending</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Submenu>
        <DropdownMenu.Separator />
        <DropdownMenu.Item>Clear</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

const menus = () => screen.queryAllByRole("menu")

async function openMenu() {
  fireEvent.click(screen.getByText("Open"))
  await waitFor(() => expect(menus()).toHaveLength(1))
}

describe("DropdownMenu submenus", () => {
  it("a tap opens a branch and a second tap closes it, on a touch screen", async () => {
    stubCoarsePointer()
    render(<Branching />)
    await openMenu()
    const type = screen.getByRole("menuitem", { name: "Type" })
    fireEvent.click(type)
    await waitFor(() => expect(menus()).toHaveLength(2))
    fireEvent.click(type)
    await waitFor(() => expect(menus()).toHaveLength(1))
  })

  it("a press on the menu itself closes its open branch and leaves the menu standing", async () => {
    stubCoarsePointer()
    render(<Branching />)
    await openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Type" }))
    await waitFor(() => expect(menus()).toHaveLength(2))
    // The separator is the menu's own, not a row's.
    act(() => {
      fireEvent.pointerDown(screen.getByRole("separator"))
    })
    await waitFor(() => expect(menus()).toHaveLength(1))
    expect(screen.getByRole("menuitem", { name: "Type" })).toBeTruthy()
  })

  it("a press inside the branch is the branch's own, and never closes it", async () => {
    stubCoarsePointer()
    render(<Branching />)
    await openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Type" }))
    await waitFor(() => expect(menus()).toHaveLength(2))
    const todo = screen.getByRole("menuitem", { name: "Todo" })
    // Bubbles to the parent's popup through React's tree, not the DOM's.
    act(() => {
      fireEvent.pointerDown(todo)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(menus()).toHaveLength(2)
  })

  it("a branch sits flush beside its parent, its first row level with its trigger", async () => {
    stubCoarsePointer()
    render(<Branching />)
    await openMenu()
    fireEvent.click(screen.getByRole("menuitem", { name: "Type" }))
    await waitFor(() => expect(menus()).toHaveLength(2))
    const branch = menus()[1]
    // Never wider than the room beside the parent (the positioner's measure).
    expect(branch.style.maxWidth).toBe("var(--available-width)")
    // Base UI's own side for a submenu, which it flips when the room is short.
    expect(branch.getAttribute("data-side")).toMatch(/^inline-/)
  })
})
