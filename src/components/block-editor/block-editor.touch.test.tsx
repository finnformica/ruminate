// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse } from "../../blocks/parse"
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

  it("carries Notion's actions and no undo", () => {
    const { container } = render(<Harness initial={"Alpha"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    const bar = screen.getByTestId("mobile-edit-bar")
    const labels = Array.from(bar.querySelectorAll("button")).map((b) =>
      b.getAttribute("aria-label"),
    )
    expect(labels).toEqual([
      "Turn into",
      "Bold",
      "Italic",
      "Code",
      "Outdent",
      "Indent",
      "Move up",
      "Move down",
      "Duplicate",
      "Delete",
      "Done",
    ])
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
    fireEvent.click(screen.getByLabelText("Outdent"))
    expect(lines(getByTestId)).toEqual(["Alpha", "Beta"])
    expect(container.querySelector("textarea")!.value).toBe("Beta")
  })

  it("moves the edited row up and down", () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha\nBeta\nGamma"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    fireEvent.click(screen.getByLabelText("Move up"))
    expect(lines(getByTestId)).toEqual(["Beta", "Alpha", "Gamma"])
    expect(container.querySelector("textarea")!.value).toBe("Beta")
    fireEvent.click(screen.getByLabelText("Move down"))
    fireEvent.click(screen.getByLabelText("Move down"))
    expect(lines(getByTestId)).toEqual(["Alpha", "Gamma", "Beta"])
  })

  it("wraps the selection in bold, italic or code markdown, and unwraps it again", () => {
    const { container } = render(<Harness initial={"Alpha beta"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
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
    fireEvent.click(screen.getByLabelText("Italic"))
    expect(container.querySelector("textarea")!.value).toBe("Alpha _beta_")
    // Nothing selected: the pair goes in and the caret sits between.
    textarea = container.querySelector("textarea")!
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    fireEvent.click(screen.getByLabelText("Code"))
    textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("Alpha _beta_``")
    expect(textarea.selectionStart).toBe(textarea.value.length - 1)
  })

  it("turns the row into another type from a second row, marking the current one", () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    fireEvent.click(screen.getByLabelText("Turn into"))
    const bar = screen.getByTestId("mobile-edit-bar")
    expect(bar.querySelector('[aria-label="Text"]')!.getAttribute("aria-pressed")).toBe("true")
    expect(bar.querySelector('[aria-label="To-do"]')!.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(screen.getByLabelText("To-do"))
    expect(lines(getByTestId)).toEqual(["[ ] Alpha"])
    // Back on the main row, still editing.
    expect(screen.getByLabelText("Bold")).not.toBeNull()
    expect(container.querySelector("textarea")!.value).toBe("Alpha")
    fireEvent.click(screen.getByLabelText("Turn into"))
    fireEvent.click(screen.getByLabelText("Back"))
    expect(screen.getByLabelText("Bold")).not.toBeNull()
  })

  it("duplicates the edited row (editing the copy) and deletes it", () => {
    const { container, getByTestId } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[0]))
    fireEvent.click(screen.getByLabelText("Duplicate"))
    expect(lines(getByTestId)).toEqual(["Alpha", "Alpha", "Beta"])
    expect(container.querySelector("textarea")!.value).toBe("Alpha")
    fireEvent.click(screen.getByLabelText("Delete"))
    expect(lines(getByTestId)).toEqual(["Alpha", "Beta"])
    // A delete leaves edit mode: the next row is highlighted.
    expect(container.querySelector("textarea")).toBeNull()
    expect(screen.queryByTestId("mobile-edit-bar")).toBeNull()
  })

  it("never takes focus from the textarea: its taps cancel their pointer down", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    const button = screen.getByLabelText("Indent")
    expect(fireEvent.pointerDown(button)).toBe(false)
    expect(fireEvent.mouseDown(button)).toBe(false)
  })

  it("Done ends the edit and leaves the row highlighted", () => {
    const { container } = render(<Harness initial={"Alpha\nBeta"} />)
    fireEvent.click(bodyOf(rows(container)[1]))
    fireEvent.click(screen.getByLabelText("Done"))
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
