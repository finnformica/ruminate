// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

// The panel needs only the open/closed atom; the markdown renderer (used by
// the formatting examples) is far too heavy for jsdom.
vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  return { isHelpPanelOpenAtom: atom(true) }
})

vi.mock("./markdown", () => ({
  Markdown: ({ children }: { children: string }) => <span>{children}</span>,
}))

import { GROUP_ORDER } from "../shortcuts/registry"
import { HelpSidebar } from "./help-panel"

afterEach(cleanup)

const filterInput = () => screen.getByPlaceholderText("Filter shortcuts…") as HTMLInputElement

describe("shortcut reference (? / help panel)", () => {
  it("renders every group from the registry", () => {
    render(<HelpSidebar />)
    for (const title of GROUP_ORDER) {
      expect(screen.getByText(title), `group "${title}" not rendered`).toBeTruthy()
    }
  })

  it("renders entries from all three registry sources", () => {
    render(<HelpSidebar />)
    // App-level hotkey (consumed by useHotkeys call sites)
    expect(screen.getByText("Toggle the command menu")).toBeTruthy()
    // Generated from the live KEYMAP
    expect(screen.getByText("Edit the highlighted block")).toBeTruthy()
    expect(screen.getByText("Zoom into the block")).toBeTruthy()
    // Imperative editor bindings
    expect(
      screen.getByText("Grow the selection one structural rung (block → subtree → parent → page)"),
    ).toBeTruthy()
    // Navigation vocabulary
    expect(screen.getByText("Go to today's daily note (press g, then d)")).toBeTruthy()
  })

  it("the filter narrows the list", () => {
    render(<HelpSidebar />)
    fireEvent.change(filterInput(), { target: { value: "sidebar" } })
    expect(screen.getByText("Toggle the sidebar")).toBeTruthy()
    expect(screen.queryByText("Edit the highlighted block")).toBeNull()
    expect(screen.queryByText("History")).toBeNull()
  })

  it("shows an empty state when nothing matches", () => {
    render(<HelpSidebar />)
    fireEvent.change(filterInput(), { target: { value: "xyzzy-no-such-shortcut" } })
    expect(screen.getByText("No shortcuts match your filter")).toBeTruthy()
  })

  it("keeps the markdown formatting reference below the shortcuts", () => {
    render(<HelpSidebar />)
    expect(screen.getByText("Formatting")).toBeTruthy()
  })
})
