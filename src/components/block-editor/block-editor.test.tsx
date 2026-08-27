// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { emptyBlock } from "../../blocks/ops"
import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import type { BlockDoc } from "../../blocks/types"
import { BlockEditor } from "./block-editor"

afterEach(cleanup)

/** Mirror BlockNoteEditor: an empty parse still gets one block to edit. */
function withStarter(doc: BlockDoc): BlockDoc {
  if (doc.rootBlockIds.length > 0) return doc
  const block = emptyBlock()
  return { ...doc, rootBlockIds: [block.id], blocks: { [block.id]: block } }
}

/** A controlled host, like the real note page: it owns the doc and re-renders
 * on change, while the editor keeps its own selection/focus state. */
function Harness({ initial, startEditing }: { initial: string; startEditing?: boolean }) {
  const [doc, setDoc] = useState<BlockDoc>(() => withStarter(parse(initial)))
  return (
    <>
      <BlockEditor doc={doc} onChange={setDoc} startEditing={startEditing} />
      <pre data-testid="serialized">{serialize(doc)}</pre>
    </>
  )
}

/** The editor's root (the focusable select-mode container). */
function editorRoot(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[tabindex="-1"]')!
}

/** Text of the currently highlighted block (the row with the select background). */
function highlightedText(container: HTMLElement): string | null {
  return container.querySelector(".bg-bg-secondary")?.textContent ?? null
}

describe("BlockEditor focus + keyboard", () => {
  it("starts a new note in edit mode with the textarea focused", () => {
    const { container } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")
    expect(textarea).not.toBeNull()
    expect(document.activeElement).toBe(textarea)
  })

  it("focuses the container on mount so a highlighted block responds to keys", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    expect(document.activeElement).toBe(editorRoot(container))
    // First block highlighted by default.
    expect(highlightedText(container)).toBe("A")
  })

  it("moves the highlight with arrow keys (never scrolling)", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" })
    expect(highlightedText(container)).toBe("B")
    fireEvent.keyDown(root, { key: "ArrowUp" })
    expect(highlightedText(container)).toBe("A")
  })

  it("Cmd+Enter in select mode inserts a new block below and edits it", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "Enter", metaKey: true })
    // A textarea (edit mode) appears for the fresh block…
    expect(container.querySelector("textarea")).not.toBeNull()
    // …and the doc gained a block after A.
    const lines = getByTestId("serialized").textContent!.split("\n").filter(Boolean).length
    expect(lines).toBeGreaterThan(2)
  })

  it("re-highlights a deleted block after undo", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight B
    expect(highlightedText(container)).toBe("B")
    fireEvent.keyDown(root, { key: "Backspace" }) // delete B
    expect(highlightedText(container)).not.toBe("B")
    fireEvent.keyDown(root, { key: "z", metaKey: true }) // undo
    expect(highlightedText(container)).toBe("B")
  })

  it("hands off from the title into the first block editing when mode is edit", () => {
    // focusFirstSignal truthy on mount fires the hand-off effect once; mode
    // "edit" should open the first block's textarea (title was being edited).
    const { container } = render(
      <BlockEditor
        doc={withStarter(parse("A\nB"))}
        onChange={() => {}}
        focusFirstSignal={1}
        focusFirstMode="edit"
      />,
    )
    expect(container.querySelector("textarea")).not.toBeNull()
  })

  it("hands off from the title into the first block highlighted when mode is select", () => {
    const { container } = render(
      <BlockEditor
        doc={withStarter(parse("A\nB"))}
        onChange={() => {}}
        focusFirstSignal={1}
        focusFirstMode="select"
      />,
    )
    expect(container.querySelector("textarea")).toBeNull()
    expect(highlightedText(container)).toBe("A")
  })

  it("extends a multi-block selection with Shift+Arrow", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true })
    const highlighted = Array.from(container.querySelectorAll(".bg-bg-secondary")).map(
      (el) => el.textContent,
    )
    expect(highlighted).toEqual(["A", "B"])
  })
})

describe("Escape ladder + keyboard recovery", () => {
  it("Escape on a single selection deselects; arrows re-select", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    expect(highlightedText(container)).toBe("A")
    fireEvent.keyDown(root, { key: "Escape" })
    expect(highlightedText(container)).toBeNull()
    // ArrowDown from nothing selects the first visible block…
    fireEvent.keyDown(root, { key: "ArrowDown" })
    expect(highlightedText(container)).toBe("A")
    // …and ArrowUp from nothing selects the last.
    fireEvent.keyDown(root, { key: "Escape" })
    fireEvent.keyDown(root, { key: "ArrowUp" })
    expect(highlightedText(container)).toBe("C")
  })

  it("Escape on a multi-selection first collapses to one, then deselects", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true })
    expect(container.querySelectorAll(".bg-bg-secondary")).toHaveLength(2)
    fireEvent.keyDown(root, { key: "Escape" })
    expect(container.querySelectorAll(".bg-bg-secondary")).toHaveLength(1)
    fireEvent.keyDown(root, { key: "Escape" })
    expect(highlightedText(container)).toBeNull()
  })
})

describe("select-mode paste", () => {
  function paste(target: HTMLElement, text: string) {
    fireEvent.paste(target, { clipboardData: { getData: () => text } })
  }

  it("pastes parsed blocks after the selected block without entering edit mode", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    const root = editorRoot(container)
    paste(root, "# New heading\r\n- new bullet")
    const md = getByTestId("serialized").textContent!
    const lines = md.split("\n").filter((l) => !l.includes("id::") && l.trim() !== "")
    expect(lines).toEqual(["A", "# New heading", "- new bullet", "B"])
    // No textarea opened; the last inserted block is highlighted.
    expect(container.querySelector("textarea")).toBeNull()
    expect(highlightedText(container)).toBe("new bullet")
  })

  it("reminting keeps a pasted id:: from clobbering an existing block", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    const root = editorRoot(container)
    const existingId = getByTestId("serialized").textContent!.match(/id:: (\S+)/)![1]
    paste(root, `stolen\n  id:: ${existingId}`)
    const md = getByTestId("serialized").textContent!
    // The original block still exists under its id, and the paste got a new one.
    expect(md).toContain("A")
    expect(md).toContain("stolen")
    expect(md.match(new RegExp(`id:: ${existingId}`, "g"))).toHaveLength(1)
  })

  it("pastes multi-line GFM todos as todo blocks (round-trip)", () => {
    const { getByTestId, container } = render(<Harness initial={"A"} />)
    paste(editorRoot(container), "- [ ] one\n- [x] two")
    const md = getByTestId("serialized").textContent!
    expect(md).toContain("[ ] one")
    expect(md).toContain("[x] two")
    expect(md).not.toContain("- [ ]")
  })
})

describe("duplicate + move via keyboard", () => {
  it("Shift+Alt+ArrowDown duplicates the selected block below", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true, altKey: true })
    const md = getByTestId("serialized").textContent!
    const lines = md.split("\n").filter((l) => !l.includes("id::") && l.trim() !== "")
    expect(lines).toEqual(["A", "A", "B"])
    // The copy (below) is now the highlighted block.
    expect(highlightedText(container)).toBe("A")
  })

  it("Shift+Alt+Arrow duplicates a multi-selection as a group", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true }) // select A+B
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true, altKey: true })
    const md = getByTestId("serialized").textContent!
    const lines = md.split("\n").filter((l) => !l.includes("id::") && l.trim() !== "")
    expect(lines).toEqual(["A", "B", "A", "B", "C"])
    // The copies are selected as a range.
    const highlighted = Array.from(container.querySelectorAll(".bg-bg-secondary")).map(
      (el) => el.textContent,
    )
    expect(highlighted).toEqual(["A", "B"])
  })

  it("Alt+Arrow moves a multi-selection as a group", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true }) // select A+B
    fireEvent.keyDown(root, { key: "ArrowDown", altKey: true })
    const md = getByTestId("serialized").textContent!
    const lines = md.split("\n").filter((l) => !l.includes("id::") && l.trim() !== "")
    expect(lines).toEqual(["C", "A", "B"])
  })
})
