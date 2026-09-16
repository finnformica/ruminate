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
  it("ends when the keyboard goes away (focus to nothing), leaving the row highlighted", () => {
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
    expect(container.querySelector(".bg-bg-secondary")!.textContent).toContain("Beta")
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

  const labels = () =>
    Array.from(screen.getByTestId("mobile-edit-bar").querySelectorAll("button")).map((b) =>
      b.getAttribute("aria-label"),
    )

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
    expect(screen.queryByLabelText("Redo")).toBeNull()
    fireEvent.click(screen.getByLabelText("Indent"))
    expect(screen.getByLabelText("Undo").getAttribute("aria-disabled")).toBeNull()
    expect(screen.queryByLabelText("Redo")).toBeNull()
    fireEvent.click(screen.getByLabelText("Undo"))
    expect(lines(getByTestId)).toEqual(["Alpha", "Beta"])
    expect(labels()).toContain("Redo")
    fireEvent.click(screen.getByLabelText("Redo"))
    expect(lines(getByTestId)).toEqual(["Alpha", "  Beta"])
    expect(screen.queryByLabelText("Redo")).toBeNull()
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

  it("deletes the edited row, leaving edit mode", () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    fireEvent.click(screen.getByLabelText("Delete"))
    expect(lines(getByTestId)).toEqual(["Beta"])
    expect(container.querySelector("textarea")).toBeNull()
    expect(screen.queryByTestId("mobile-edit-bar")).toBeNull()
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

  it("Hide keyboard ends the edit and leaves the row highlighted", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    fireEvent.click(screen.getByLabelText("Hide keyboard"))
    expect(container.querySelector("textarea")).toBeNull()
    expect(screen.queryByTestId("mobile-edit-bar")).toBeNull()
    const highlighted = container.querySelector(".bg-bg-secondary")!
    expect(highlighted.textContent).toContain("Beta")
  })
})

describe("the block menu on a touch screen", () => {
  async function openMenuOn(container: HTMLElement, index: number): Promise<HTMLElement> {
    const row = rows(container)[index]
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    })
    return screen.getByTestId("block-context-menu")
  }

  it("carries the structure moves a finger has no keys for", async () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha\nBeta"} />)
    const menu = await openMenuOn(container, 1)
    for (const label of ["Indent", "Outdent", "Move up", "Move down"]) {
      expect(menu.textContent).toContain(label)
    }
    await act(async () => {
      fireEvent.click(screen.getByText("Indent"))
    })
    expect(lines(getByTestId)).toEqual(["Alpha", "  Beta"])
  })

  it("keeps them off a mouse's menu, where Tab does the job", async () => {
    coarse = false
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    const menu = await openMenuOn(container, 1)
    expect(menu.textContent).not.toContain("Indent")
    expect(menu.textContent).not.toContain("Move up")
  })
})
