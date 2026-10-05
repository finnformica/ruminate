// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import type { BlockDoc } from "../../blocks/types"
import { BlockEditor } from "./block-editor"

// The menu (Base UI) measures its popup with a ResizeObserver and scrolls the
// highlighted item into view; jsdom implements neither.
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup)

function Harness({ initial, readOnly }: { initial: string; readOnly?: boolean }) {
  const [doc, setDoc] = useState<BlockDoc>(() => parse(initial))
  return (
    <>
      <BlockEditor doc={doc} onChange={setDoc} readOnly={readOnly} />
      <pre data-testid="serialized">{serialize(doc)}</pre>
    </>
  )
}

const root = (container: HTMLElement) => container.querySelector<HTMLElement>('[tabindex="-1"]')!
const rows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-occurrence]"))
const bodyOf = (row: Element) => row.querySelector<HTMLElement>('[data-testid="block-body"]')!
const lines = (container: HTMLElement) =>
  screen
    .getByTestId("serialized")
    .textContent!.split("\n")
    .filter((l) => !l.includes("id::") && l.trim() !== "")
const highlighted = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".bg-bg-secondary")).map((el) => bodyOf(el).textContent)
const bar = () => document.querySelector<HTMLElement>("[data-selection-bar]")!
const barOpen = () => !bar().classList.contains("hidden")

/** Select rows `from`..`to`: click `from`, then Shift+Down to `to`. */
function selectRange(container: HTMLElement, from: number, to: number) {
  fireEvent.click(bodyOf(rows(container)[from]))
  for (let i = from; i < to; i++)
    fireEvent.keyDown(root(container), { key: "ArrowDown", shiftKey: true })
}

/** A DOM text selection (what a mouse sweep leaves) that covers the given
 * rows in full, anchored in the row the sweep began in. */
function sweep(container: HTMLElement, from: number, to: number) {
  const all = rows(container)
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const covered = all.slice(lo, hi + 1)
  const removeAllRanges = vi.fn()
  const selection = {
    isCollapsed: false,
    anchorNode: bodyOf(all[from]).firstChild,
    containsNode: (node: Node) => covered.some((row) => row.contains(node)),
    removeAllRanges,
  }
  const spy = vi.spyOn(window, "getSelection").mockReturnValue(selection as unknown as Selection)
  fireEvent.mouseUp(root(container))
  spy.mockRestore()
  return removeAllRanges
}

describe("a mouse sweep across rows", () => {
  it("selects the rows it covered, so Tab indents them all", () => {
    const { container } = render(<Harness initial={"A\nB\nC\nD\nE"} />)
    const dropped = sweep(container, 1, 3)
    expect(highlighted(container)).toEqual(["B", "C", "D"])
    // The text selection is spent: the rows are selected instead.
    expect(dropped).toHaveBeenCalled()
    fireEvent.keyDown(root(container), { key: "Tab" })
    expect(lines(container)).toEqual(["A", "  B", "  C", "  D", "E"])
  })

  it("keeps the anchor where the sweep began, so Shift+Arrow grows from the other end", () => {
    const { container } = render(<Harness initial={"A\nB\nC\nD\nE"} />)
    sweep(container, 3, 1) // dragged upwards, from D to B
    expect(highlighted(container)).toEqual(["B", "C", "D"])
    fireEvent.keyDown(root(container), { key: "ArrowUp", shiftKey: true })
    expect(highlighted(container)).toEqual(["A", "B", "C", "D"])
  })

  it("leaves a selection inside one row alone", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const dropped = sweep(container, 1, 1)
    expect(dropped).not.toHaveBeenCalled()
    expect(highlighted(container)).toEqual(["A"])
  })
})

describe("Shift+click", () => {
  it("extends the selection from the highlighted row to the clicked one", () => {
    const { container } = render(<Harness initial={"A\nB\nC\nD"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    fireEvent.click(bodyOf(rows(container)[3]), { shiftKey: true })
    expect(highlighted(container)).toEqual(["B", "C", "D"])
    // A plain click collapses it again.
    fireEvent.click(bodyOf(rows(container)[2]))
    expect(highlighted(container)).toEqual(["C"])
  })
})

describe("indenting a selection", () => {
  it("moves the selection as one, or not at all", () => {
    const { container } = render(<Harness initial={"A\nB\nC\nD"} />)
    // A leads the page: nothing above to nest under, so the run stays put
    // (it used to leave A behind and nest B and C under it).
    selectRange(container, 0, 2)
    fireEvent.keyDown(root(container), { key: "Tab" })
    expect(lines(container)).toEqual(["A", "B", "C", "D"])
    // A run that can nest, nests together — and once nested, its first row
    // leads its new parent, so a second Tab is again a no-op.
    selectRange(container, 1, 2)
    fireEvent.keyDown(root(container), { key: "Tab" })
    expect(lines(container)).toEqual(["A", "  B", "  C", "D"])
    fireEvent.keyDown(root(container), { key: "Tab" })
    expect(lines(container)).toEqual(["A", "  B", "  C", "D"])
    fireEvent.keyDown(root(container), { key: "Tab", shiftKey: true })
    expect(lines(container)).toEqual(["A", "B", "C", "D"])
  })
})

describe("the selection bar", () => {
  it("rises with a multi-row selection, counts its rows, and sinks when it collapses", () => {
    const { container } = render(<Harness initial={"A\nB\nC\nD"} />)
    expect(barOpen()).toBe(false)
    selectRange(container, 1, 3)
    expect(barOpen()).toBe(true)
    expect(screen.getByTestId("selection-count").textContent).toBe("3 selected")
    fireEvent.keyDown(root(container), { key: "ArrowUp", shiftKey: true })
    expect(screen.getByTestId("selection-count").textContent).toBe("2 selected")
    fireEvent.keyDown(root(container), { key: "Escape" })
    expect(barOpen()).toBe(false)
    // While it leaves it still says what it said.
    expect(screen.getByTestId("selection-count").textContent).toBe("2 selected")
  })

  it("clears back to one row", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    selectRange(container, 0, 2)
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }))
    expect(highlighted(container)).toEqual(["C"])
    expect(barOpen()).toBe(false)
  })

  it("runs the menu's actions on the whole selection", async () => {
    const { container } = render(<Harness initial={"A\nB\nC\nD"} />)
    selectRange(container, 1, 2)
    const open = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Actions" }))
      })
      return screen.getByRole("menu")
    }
    const pick = async (label: string) => {
      await act(async () => {
        fireEvent.click(screen.getByText(label))
      })
    }
    const item = (label: string) => screen.getByText(label).closest("[role='menuitem']")!
    await open()
    await pick("Indent")
    expect(lines(container)).toEqual(["A", "  B", "  C", "D"])
    // Nested first under A, B cannot nest further: the item greys.
    await open()
    expect(item("Indent").getAttribute("aria-disabled")).toBe("true")
    await pick("Outdent")
    expect(lines(container)).toEqual(["A", "B", "C", "D"])
    await open()
    expect(item("Outdent").getAttribute("aria-disabled")).toBe("true")
    await pick("Move down")
    expect(lines(container)).toEqual(["A", "D", "B", "C"])
    expect(highlighted(container)).toEqual(["B", "C"])
    await open()
    await pick("Duplicate")
    expect(lines(container)).toEqual(["A", "D", "B", "C", "B", "C"])
    // The copies are the selection now.
    await open()
    await pick("Turn into")
    await pick("To-do")
    expect(lines(container)).toEqual(["A", "D", "B", "C", "[ ] B", "[ ] C"])
    // Move up is greyed where the run has no room; here it has.
    await open()
    expect(item("Move up").getAttribute("aria-disabled")).not.toBe("true")
    // No graph behind this editor: removing the rows is the delete, so the
    // item says so (in a note it reads Unlink, beside the block's Delete).
    await pick("Delete")
    expect(lines(container)).toEqual(["A", "D", "B", "C"])
    expect(barOpen()).toBe(false)
  })

  it("is not offered while browsing", () => {
    render(<Harness initial={"A\nB\nC"} readOnly />)
    expect(document.querySelector("[data-selection-bar]")).toBeNull()
  })
})
