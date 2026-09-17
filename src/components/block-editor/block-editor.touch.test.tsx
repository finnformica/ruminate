// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse } from "../../blocks/parse"
import { BLOCK_TYPE_DEFS } from "../../blocks/registry"
import { serialize } from "../../blocks/serialize"
import type { BlockDoc } from "../../blocks/types"
import { BlockEditor } from "./block-editor"

// The context menu (Base UI) measures its popup with a ResizeObserver and
// scrolls the highlighted item into view; jsdom implements neither.
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/**
 * The touch-screen editor (docs/mobile.md). jsdom has no `matchMedia`, so
 * the pointer is stubbed: coarse here, fine where a test says so.
 */
let coarse = true
beforeEach(() => {
  coarse = true
  window.matchMedia = ((query: string) =>
    ({
      matches: query === "(pointer: coarse)" && coarse,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia
})
afterEach(() => {
  cleanup()
  delete (window as { matchMedia?: unknown }).matchMedia
})

function Harness({ initial }: { initial: string }) {
  const [doc, setDoc] = useState<BlockDoc>(() => parse(initial))
  return (
    <>
      <BlockEditor doc={doc} onChange={setDoc} />
      <pre data-testid="serialized">{serialize(doc)}</pre>
      <button type="button" data-testid="elsewhere">
        Elsewhere
      </button>
    </>
  )
}

const rows = (container: HTMLElement) =>
  container.querySelectorAll<HTMLElement>("[data-occurrence]")
const bodyOf = (row: Element) => row.querySelector<HTMLElement>('[data-testid="block-body"]')!
/** Content lines of the serialized doc (id:: lines and blanks dropped),
 * keeping indentation so nesting is visible. */
const lines = (getByTestId: (id: string) => HTMLElement) =>
  getByTestId("serialized")
    .textContent!.split("\n")
    .filter((l) => !l.includes("id::") && l.trim() !== "")

/** Answer the browser's caret-from-point hit test by hand: this node, this
 * offset, whatever the point. Returns the undo. */
function stubCaretAt(node: Node, offset: number): () => void {
  const doc = document as unknown as Record<string, unknown>
  doc.caretPositionFromPoint = () => ({ offsetNode: node, offset, getClientRect: () => null })
  return () => {
    delete doc.caretPositionFromPoint
  }
}

describe("a touch screen's tap", () => {
  it("edits the row in one tap, where a click would only select it", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    const textarea = container.querySelector("textarea")!
    expect(textarea).not.toBeNull()
    expect(textarea.value).toBe("Beta")
    expect(document.activeElement).toBe(textarea)
  })

  it("still needs a double-click with a mouse", () => {
    coarse = false
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    expect(container.querySelector("textarea")).toBeNull()
    fireEvent.doubleClick(bodyOf(rows(container)[1]))
    expect(container.querySelector("textarea")).not.toBeNull()
  })

  it("puts the caret where the finger landed when the text shows as stored", () => {
    const { container } = render(<Harness initial={"Alpha beta"} />)
    const body = bodyOf(rows(container)[0])
    // The browser's own hit test, answered by hand: offset 3 of the text.
    const restore = stubCaretAt(body.firstChild!, 3)
    try {
      fireEvent.click(body, { clientX: 30, clientY: 10 })
      const textarea = container.querySelector("textarea")!
      expect(textarea.selectionStart).toBe(3)
    } finally {
      restore()
    }
  })

  it("lands at the end when the body's text differs from the stored text (markdown)", () => {
    const { container } = render(<Harness initial={"**Alpha** beta"} />)
    const body = bodyOf(rows(container)[0])
    const restore = stubCaretAt(body.querySelector("strong")!.firstChild!, 1)
    try {
      fireEvent.click(body, { clientX: 30, clientY: 10 })
      const textarea = container.querySelector("textarea")!
      expect(textarea.selectionStart).toBe("**Alpha** beta".length)
    } finally {
      restore()
    }
  })

  it("takes the whole row: a tap in the row's padding edits it too", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    // The row wrapper itself — the marker gap, the vertical padding.
    fireEvent.click(rows(container)[0])
    expect(container.querySelector("textarea")!.value).toBe("Alpha")
  })

  it("leaves the chevron and the checkbox to their own jobs", () => {
    const { container } = render(<Harness initial={"- [ ] Parent\n  - Child"} />)
    const toggle = screen.getByLabelText("Collapse")
    fireEvent.click(toggle)
    expect(container.querySelector("textarea")).toBeNull()
    expect(rows(container).length).toBe(1)
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    fireEvent.click(checkbox)
    expect(container.querySelector("textarea")).toBeNull()
  })
})

describe("a touch screen's edit", () => {
  it("ends when the keyboard goes away (focus to nothing), with nothing left highlighted", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    const textarea = container.querySelector("textarea")!
    // iOS's Done key: the textarea blurs with nowhere for focus to go, the
    // window itself still focused (jsdom says otherwise unless told).
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true)
    act(() => {
      textarea.blur()
    })
    hasFocus.mockRestore()
    expect(container.querySelector("textarea")).toBeNull()
    // A touch screen's highlight has no keyboard to serve: nothing stays lit.
    expect(container.querySelector(".bg-bg-secondary")).toBeNull()
  })

  it("moves from row to row as taps land", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    expect(container.querySelector("textarea")!.value).toBe("Alpha")
    // The tap's mousedown blurs the first textarea before the click lands
    // on the second row.
    act(() => {
      container.querySelector("textarea")!.blur()
    })
    fireEvent.click(bodyOf(rows(container)[1]))
    const textareas = container.querySelectorAll("textarea")
    expect(textareas.length).toBe(1)
    expect(textareas[0].value).toBe("Beta")
    expect(document.activeElement).toBe(textareas[0])
  })

  it("asks the keyboard for sentence capitals, and for none in a code block", () => {
    const { container } = render(<Harness initial={"Alpha\n```\ncode\n```"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    expect(container.querySelector("textarea")!.getAttribute("autocapitalize")).toBe("sentences")
    act(() => {
      container.querySelector("textarea")!.blur()
    })
    fireEvent.click(rows(container)[1])
    const code = container.querySelector("textarea")!
    expect(code.value).toBe("code")
    expect(code.getAttribute("autocapitalize")).toBe("off")
    expect(code.getAttribute("autocorrect")).toBe("off")
  })
})

describe("the edit bar", () => {
  it("shows while a row is edited on a touch screen, and never with a mouse", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    expect(screen.queryByTestId("mobile-edit-bar")).toBeNull()
    fireEvent.click(bodyOf(rows(container)[1]))
    expect(screen.getByTestId("mobile-edit-bar")).not.toBeNull()
    cleanup()
    coarse = false
    const fine = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.doubleClick(bodyOf(rows(fine.container)[1]))
    expect(fine.container.querySelector("textarea")).not.toBeNull()
    expect(screen.queryByTestId("mobile-edit-bar")).toBeNull()
  })

  /** The row's buttons, as a reader meets them: Redo sits in the row closed
   * (width 0, aria-hidden) until there is something to redo. */
  const labels = () =>
    Array.from(screen.getByTestId("mobile-edit-bar").querySelectorAll("button"))
      .filter((b) => !b.closest("[aria-hidden='true']"))
      .map((b) => b.getAttribute("aria-label"))

  it("carries the main row: Aa, Turn into, the structure moves, Undo, Delete, the keyboard", () => {
    const { container } = render(<Harness initial={"Alpha"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    // No Redo (nothing to redo); Image is there but greyed (images off here).
    expect(labels()).toEqual([
      "Formatting",
      "Turn into",
      "Outdent",
      "Indent",
      "Undo",
      "Image",
      "Delete",
      "Hide keyboard",
    ])
    expect(screen.getByLabelText("Image").getAttribute("aria-disabled")).toBe("true")
    // Everything fits: no fade over the last button.
    expect(screen.getByTestId("mobile-edit-bar").querySelector("[data-overflows]")).toBeNull()
  })

  it("greys a move that would do nothing, and Undo with nothing to undo", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    // The first root: nothing above to nest under, nothing to lift out of.
    expect(screen.getByLabelText("Indent").getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByLabelText("Outdent").getAttribute("aria-disabled")).toBe("true")
    expect(screen.getByLabelText("Undo").getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(screen.getByLabelText("Indent"))
    expect(container.querySelector("textarea")!.value).toBe("Alpha")
    // The second root can nest under the first, but not lift out.
    act(() => {
      container.querySelector("textarea")!.blur()
    })
    fireEvent.click(bodyOf(rows(container)[1]))
    expect(screen.getByLabelText("Indent").getAttribute("aria-disabled")).toBeNull()
    expect(screen.getByLabelText("Outdent").getAttribute("aria-disabled")).toBe("true")
  })

  it("indents and outdents the edited row, keeping the edit and the caret", () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    const textarea = container.querySelector("textarea")!
    textarea.setSelectionRange(2, 2)
    fireEvent.click(screen.getByLabelText("Indent"))
    expect(lines(getByTestId)).toEqual(["Alpha", "  Beta"])
    const moved = container.querySelector("textarea")!
    expect(moved.value).toBe("Beta")
    expect(document.activeElement).toBe(moved)
    expect(moved.selectionStart).toBe(2)
    // Nested now: Outdent is live, Indent (no sibling above) is not.
    expect(screen.getByLabelText("Outdent").getAttribute("aria-disabled")).toBeNull()
    expect(screen.getByLabelText("Indent").getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(screen.getByLabelText("Outdent"))
    expect(lines(getByTestId)).toEqual(["Alpha", "Beta"])
    expect(container.querySelector("textarea")!.value).toBe("Beta")
  })

  it("shows Redo beside Undo only while there is something to redo", () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    expect(labels()).not.toContain("Redo")
    fireEvent.click(screen.getByLabelText("Indent"))
    expect(screen.getByLabelText("Undo").getAttribute("aria-disabled")).toBeNull()
    expect(labels()).not.toContain("Redo")
    fireEvent.click(screen.getByLabelText("Undo"))
    expect(lines(getByTestId)).toEqual(["Alpha", "Beta"])
    expect(labels()).toContain("Redo")
    fireEvent.click(screen.getByLabelText("Redo"))
    expect(lines(getByTestId)).toEqual(["Alpha", "  Beta"])
    expect(labels()).not.toContain("Redo")
  })

  it("Aa swaps the row for the formatting, which wraps the selection and unwraps it again", () => {
    const { container } = render(<Harness initial={"Alpha beta"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    fireEvent.click(screen.getByLabelText("Formatting"))
    expect(labels()).toEqual([
      "Back",
      "Bold",
      "Italic",
      "Strikethrough",
      "Code",
      "Link",
      "Maths",
      "Hide keyboard",
    ])
    container.querySelector("textarea")!.setSelectionRange(0, 5)
    fireEvent.click(screen.getByLabelText("Bold"))
    let textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("**Alpha** beta")
    expect(document.activeElement).toBe(textarea)
    expect(textarea.selectionStart).toBe(7)
    textarea.setSelectionRange(2, 7)
    fireEvent.click(screen.getByLabelText("Bold"))
    textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("Alpha beta")
    textarea.setSelectionRange(6, 10)
    fireEvent.click(screen.getByLabelText("Strikethrough"))
    expect(container.querySelector("textarea")!.value).toBe("Alpha ~~beta~~")
    textarea = container.querySelector("textarea")!
    textarea.setSelectionRange(0, 5)
    fireEvent.click(screen.getByLabelText("Maths"))
    expect(container.querySelector("textarea")!.value).toBe("$$Alpha$$ ~~beta~~")
    // Still the formatting row, still editing.
    expect(labels()[0]).toBe("Back")
    fireEvent.click(screen.getByLabelText("Back"))
    expect(labels()[0]).toBe("Formatting")
  })

  it("Link makes the selection a link and puts the caret where the address goes", () => {
    const { container } = render(<Harness initial={"Alpha beta"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    fireEvent.click(screen.getByLabelText("Formatting"))
    container.querySelector("textarea")!.setSelectionRange(0, 5)
    fireEvent.click(screen.getByLabelText("Link"))
    const textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("[Alpha]() beta")
    expect(textarea.selectionStart).toBe(8)
  })

  it("Turn into swaps the row for the types as glyphs, the highlight on the current one", () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    fireEvent.click(screen.getByLabelText("Turn into"))
    // The registry's types, in its order, as the block menu offers them.
    const types = BLOCK_TYPE_DEFS.filter((def) => def.turnInto)
    expect(labels()).toEqual(["Back", ...types.map((def) => def.label), "Hide keyboard"])
    expect(screen.getByLabelText("Bullet list").textContent).toBe("-")
    expect(screen.getByLabelText("To-do").textContent).toBe("[ ]")
    expect(screen.getByLabelText("Text").getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByTestId("edit-bar-thumb").style.transform).toBe("translateX(0px)")
    fireEvent.click(screen.getByLabelText("To-do"))
    expect(lines(getByTestId)).toEqual(["[ ] Alpha"])
    // Back on the main row, still editing.
    expect(labels()[0]).toBe("Formatting")
    expect(container.querySelector("textarea")!.value).toBe("Alpha")
    // Open again: the highlight has slid to the to-do, a button's width a type.
    fireEvent.click(screen.getByLabelText("Turn into"))
    expect(screen.getByLabelText("To-do").getAttribute("aria-pressed")).toBe("true")
    const at = types.findIndex((def) => def.id === "todo")
    expect(screen.getByTestId("edit-bar-thumb").style.transform).toBe(`translateX(${at * 38}px)`)
    fireEvent.click(screen.getByLabelText("Back"))
    expect(labels()[0]).toBe("Formatting")
  })

  it("pins itself above the visual viewport's bottom and pads the page by what it covers", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    const bar = screen.getByTestId("mobile-edit-bar")
    // jsdom has no visualViewport: the layout viewport's bottom stands in.
    expect(bar.style.transform).toBe(
      `translateY(calc(${window.innerHeight}px - 100% - 8px - var(--edit-bar-lift)))`,
    )
    expect(bar.getAttribute("data-keyboard")).toBe("down")
    // jsdom lays nothing out: the bar is 0px tall, so the page pads by the lift alone.
    expect(document.documentElement.style.getPropertyValue("--edit-bar-inset")).toBe("8px")
    fireEvent.click(screen.getByLabelText("Hide keyboard"))
    expect(document.documentElement.style.getPropertyValue("--edit-bar-inset")).toBe("")
  })

  it("never takes focus from the textarea: its taps cancel their pointer down", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    const button = screen.getByLabelText("Indent")
    expect(fireEvent.pointerDown(button)).toBe(false)
    expect(fireEvent.mouseDown(button)).toBe(false)
  })

  it("Hide keyboard ends the edit, and leaves nothing highlighted", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    fireEvent.click(screen.getByLabelText("Hide keyboard"))
    expect(container.querySelector("textarea")).toBeNull()
    expect(screen.queryByTestId("mobile-edit-bar")).toBeNull()
    expect(container.querySelector(".bg-bg-secondary")).toBeNull()
  })

  it("Delete keeps editing, on the row that takes the deleted one's place", () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha\nBeta\nGamma"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    fireEvent.click(screen.getByLabelText("Delete"))
    expect(lines(getByTestId)).toEqual(["Alpha", "Gamma"])
    // The keyboard, and the bar, stay up for the next delete.
    const textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("Gamma")
    expect(document.activeElement).toBe(textarea)
    expect(screen.getByTestId("mobile-edit-bar")).not.toBeNull()
  })

  it("Undo of a delete keeps editing, on the row that came back", () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha\nBeta\nGamma"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    fireEvent.click(screen.getByLabelText("Delete"))
    fireEvent.click(screen.getByLabelText("Undo"))
    expect(lines(getByTestId)).toEqual(["Alpha", "Beta", "Gamma"])
    expect(container.querySelector("textarea")!.value).toBe("Beta")
    expect(screen.getByTestId("mobile-edit-bar")).not.toBeNull()
    fireEvent.click(screen.getByLabelText("Redo"))
    expect(lines(getByTestId)).toEqual(["Alpha", "Gamma"])
    expect(container.querySelector("textarea")).not.toBeNull()
  })

  it("Backspace heard as a deletion (a keyboard that names no key) merges an empty block up", () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    // Return makes an empty block beneath, editing.
    fireEvent.keyDown(container.querySelector("textarea")!, { key: "Enter" })
    expect(container.querySelector("textarea")!.value).toBe("")
    // A bullet, by the default new-block type.
    expect(lines(getByTestId)).toEqual(["Alpha", "- "])
    const backspace = () => {
      const event = new InputEvent("beforeinput", {
        inputType: "deleteContentBackward",
        cancelable: true,
        bubbles: true,
      })
      act(() => {
        container.querySelector("textarea")!.dispatchEvent(event)
      })
      return event.defaultPrevented
    }
    // As the key does: first the marker goes, then the block merges up.
    expect(backspace()).toBe(true)
    expect(rows(container).length).toBe(2)
    expect(container.querySelector("textarea")!.value).toBe("")
    expect(backspace()).toBe(true)
    expect(rows(container).length).toBe(1)
    expect(container.querySelector("textarea")!.value).toBe("Alpha")
    // Mid-text, the textarea's own deletion is left alone.
    container.querySelector("textarea")!.setSelectionRange(3, 3)
    expect(backspace()).toBe(false)
  })
})

describe("the block menu on a touch screen", () => {
  it("is a sheet, opened by a press-and-hold on the row, carrying the structure moves", async () => {
    vi.useFakeTimers()
    try {
      const { container, getByTestId } = render(<Harness initial={"Alpha\nBeta"} />)
      const row = rows(container)[1]
      fireEvent.pointerDown(row, { pointerType: "touch", clientX: 20, clientY: 20 })
      // A finger that stays put for 450ms.
      act(() => {
        vi.advanceTimersByTime(500)
      })
      const sheet = screen.getByTestId("block-menu-sheet")
      expect(sheet.textContent).toContain("Beta")
      for (const label of ["Indent", "Outdent", "Move up", "Move down", "Turn into", "Delete"]) {
        expect(sheet.textContent).toContain(label)
      }
      // The row the sheet is for is marked, quietly.
      expect(container.querySelector(".bg-bg-secondary")!.textContent).toContain("Beta")
      fireEvent.click(screen.getByText("Indent"))
      expect(lines(getByTestId)).toEqual(["Alpha", "  Beta"])
      // Closed on the pick, and nothing left lit.
      act(() => {
        vi.runAllTimers()
      })
      expect(container.querySelector(".bg-bg-secondary")).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not open on a finger that moves (a scroll) or lifts early", () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<Harness initial={"Alpha\nBeta"} />)
      const row = rows(container)[1]
      fireEvent.pointerDown(row, { pointerType: "touch", clientX: 20, clientY: 20 })
      fireEvent.pointerMove(row, { pointerType: "touch", clientX: 20, clientY: 60 })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(screen.queryByTestId("block-menu-sheet")).toBeNull()
      fireEvent.pointerDown(row, { pointerType: "touch", clientX: 20, clientY: 20 })
      fireEvent.pointerUp(row, { pointerType: "touch" })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(screen.queryByTestId("block-menu-sheet")).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("opens the sheet on a contextmenu too (Android's long press), never the popup", async () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha\nBeta"} />)
    await act(async () => {
      fireEvent.contextMenu(rows(container)[1], { clientX: 10, clientY: 10 })
    })
    expect(screen.queryByTestId("block-context-menu")).toBeNull()
    const sheet = screen.getByTestId("block-menu-sheet")
    expect(sheet.textContent).toContain("Outdent")
    await act(async () => {
      fireEvent.click(screen.getByText("Indent"))
    })
    expect(lines(getByTestId)).toEqual(["Alpha", "  Beta"])
  })

  it("keeps the popup, without the moves, for a mouse", async () => {
    coarse = false
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    await act(async () => {
      fireEvent.contextMenu(rows(container)[1], { clientX: 10, clientY: 10 })
    })
    const menu = screen.getByTestId("block-context-menu")
    expect(menu.textContent).not.toContain("Indent")
    expect(menu.textContent).not.toContain("Move up")
    expect(screen.queryByTestId("block-menu-sheet")).toBeNull()
  })
})
