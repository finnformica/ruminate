// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emptyBlock } from "../../blocks/ops"
import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import type { BlockDoc } from "../../blocks/types"
import type { BlockRevealRequest } from "../../utils/note-outline"
import { richClipboardFormats } from "../../utils/rich-clipboard"
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
function Harness({
  initial,
  startEditing,
  zoomRootId,
}: {
  initial: string
  startEditing?: boolean
  zoomRootId?: string | null
}) {
  const [doc, setDoc] = useState<BlockDoc>(() => withStarter(parse(initial)))
  return (
    <>
      <BlockEditor
        doc={doc}
        onChange={setDoc}
        startEditing={startEditing}
        zoomRootId={zoomRootId}
      />
      <pre data-testid="serialized">{serialize(doc)}</pre>
    </>
  )
}

/** Like `Harness`, but mirrors BlockNoteEditor's trailing-blank rule so the
 * doc always keeps an empty block at the bottom (used to prove the editor
 * lands in a sane state after deleting everything). */
function BlankKeepingHarness({ initial }: { initial: string }) {
  const [doc, setDoc] = useState<BlockDoc>(() => withStarter(parse(initial)))
  const handleChange = (next: BlockDoc) => {
    const lastId = next.rootBlockIds[next.rootBlockIds.length - 1]
    const last = lastId ? next.blocks[lastId] : undefined
    if (last && last.content === "" && last.children.length === 0) {
      setDoc(next)
      return
    }
    const block = emptyBlock()
    setDoc({
      ...next,
      rootBlockIds: [...next.rootBlockIds, block.id],
      blocks: { ...next.blocks, [block.id]: block },
    })
  }
  return <BlockEditor doc={doc} onChange={handleChange} />
}

/** The editor's root (the focusable select-mode container). */
function editorRoot(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[tabindex="-1"]')!
}

/** Text of the currently highlighted block (the row with the select background). */
function highlightedText(container: HTMLElement): string | null {
  return container.querySelector(".bg-bg-secondary")?.textContent ?? null
}

/** Texts of every highlighted block, in document order. */
function highlightedAll(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".bg-bg-secondary")).map(
    (el) => el.textContent ?? "",
  )
}

/** Content lines of the serialized doc (id:: lines and blanks dropped),
 * keeping indentation so nesting is visible. */
function serializedLines(getByTestId: (id: string) => HTMLElement): string[] {
  return getByTestId("serialized")
    .textContent!.split("\n")
    .filter((l) => !l.includes("id::") && l.trim() !== "")
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
  function paste(target: HTMLElement, text: string, html = "") {
    fireEvent.paste(target, {
      clipboardData: { getData: (type: string) => (type === "text/html" ? html : text) },
    })
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

  it("converts a text/html clipboard flavor to markdown blocks", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    paste(
      editorRoot(container),
      "a b", // the flat plain flavor loses the nesting…
      "<ul><li><b>a</b><ul><li>b</li></ul></li></ul>", // …the html keeps it
    )
    expect(serializedLines(getByTestId)).toEqual(["A", "- **a**", "  - b", "B"])
  })

  it("rebuilds the exact block tree from a Ruminate html payload", () => {
    // Bare `[ ] ` todo markers + a quote child: the private payload restores
    // them verbatim, which no plain/html conversion could guarantee.
    const formats = richClipboardFormats("[ ] task\n  > child")
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    paste(editorRoot(container), formats.plain, formats.html)
    expect(serializedLines(getByTestId)).toEqual(["A", "[ ] task", "  > child", "B"])
  })

  it("Mod+Shift+V pastes the plain flavor as one block, ignoring html", () => {
    const { container, getByTestId } = render(<Harness initial={"A"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "v", metaKey: true, shiftKey: true })
    paste(root, "plain one\nplain two", "<ul><li>rich</li></ul>")
    expect(serializedLines(getByTestId)).toEqual(["A", "plain one plain two"])
  })

  it("edit-mode paste converts the html flavor and splits into blocks", () => {
    const { container, getByTestId } = render(<Harness initial={""} startEditing />)
    const textarea = container.querySelector("textarea")!
    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) =>
          type === "text/html" ? "<h2>Head</h2><ul><li>item</li></ul>" : "Head item",
      },
    })
    expect(serializedLines(getByTestId)).toEqual(["# Head", "- item"])
  })
})

/** A nested fixture for the selection ladder:
 *   A
 *   B
 *     C
 *       D
 *     E
 *   F
 */
const NESTED = "A\nB\n  C\n    D\n  E\nF"

/** Highlight the nth visible block by walking down from the first. */
function selectNth(root: HTMLElement, n: number) {
  for (let i = 0; i < n; i++) fireEvent.keyDown(root, { key: "ArrowDown" })
}

describe("selection ladder (Cmd+A escalation)", () => {
  it("walks the ladder from a leaf: parent subtree → ancestor subtree → whole page", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D — a leaf two levels deep
    expect(highlightedAll(container)).toEqual(["D"])
    // A leaf's own subtree is just itself, so the first press already grows to
    // the parent's subtree (the press always visibly does something).
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["C", "D"])
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["B", "C", "D", "E"])
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["A", "B", "C", "D", "E", "F"])
    // At the top there is nowhere further to grow.
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["A", "B", "C", "D", "E", "F"])
  })

  it("first selects the block's own visible subtree when it has children", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["B", "C", "D", "E"])
  })

  it("treats a collapsed block's hidden children as absent", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: " " }) // collapse B — C/D/E disappear
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    // B's visible subtree is just B, and B is a root → whole (visible) page.
    expect(highlightedAll(container)).toEqual(["A", "B", "F"])
  })

  it("escalates an arbitrary Shift+Arrow range to the deepest containing subtree", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true }) // D + E
    expect(highlightedAll(container)).toEqual(["D", "E"])
    // No block's subtree is exactly [D, E]; the deepest strict superset is B's.
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["B", "C", "D", "E"])
  })

  it("Cmd+Shift+A shrinks back one rung at a time", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["B", "C", "D", "E"])
    fireEvent.keyDown(root, { key: "a", metaKey: true, shiftKey: true })
    expect(highlightedAll(container)).toEqual(["C", "D"])
    fireEvent.keyDown(root, { key: "a", metaKey: true, shiftKey: true })
    expect(highlightedAll(container)).toEqual(["D"])
    // At the bottom of the ladder there is nothing left to pop.
    fireEvent.keyDown(root, { key: "a", metaKey: true, shiftKey: true })
    expect(highlightedAll(container)).toEqual(["D"])
  })

  it("any other selection change resets the ladder", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["C", "D"])
    // An arrow collapses the range and moves the highlight — a non-ladder change.
    fireEvent.keyDown(root, { key: "ArrowDown" })
    expect(highlightedAll(container)).toEqual(["D"])
    fireEvent.keyDown(root, { key: "a", metaKey: true, shiftKey: true })
    expect(highlightedAll(container)).toEqual(["D"])
  })

  it("Escape on a ladder selection follows the Escape ladder (head, then nothing)", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["C", "D"])
    fireEvent.keyDown(root, { key: "Escape" })
    expect(highlightedAll(container)).toEqual(["C"])
    fireEvent.keyDown(root, { key: "Escape" })
    expect(highlightedAll(container)).toEqual([])
  })

  it("is a no-op on a sole root leaf, without breaking single-select commands", () => {
    const { container } = render(<Harness initial={"A"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["A"])
    // Single-target commands still work on the unchanged selection.
    fireEvent.keyDown(root, { key: "Enter" })
    expect(container.querySelector("textarea")).not.toBeNull()
  })
})

describe("selection ladder from edit mode", () => {
  it("Cmd+A stays native until the text is fully selected, then starts the ladder", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D
    fireEvent.keyDown(root, { key: "Enter" }) // edit D (caret at end)
    const textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("D")
    // Not fully selected: the press is left to the native textarea select-all.
    fireEvent.keyDown(textarea, { key: "a", metaKey: true })
    expect(container.querySelector("textarea")).not.toBeNull()
    // Fully selected (as the native select-all would leave it): escalate.
    textarea.setSelectionRange(0, textarea.value.length)
    fireEvent.keyDown(textarea, { key: "a", metaKey: true })
    expect(container.querySelector("textarea")).toBeNull()
    expect(highlightedAll(container)).toEqual(["C", "D"])
    // The rung below the ladder start is the single block, back in select mode.
    fireEvent.keyDown(root, { key: "a", metaKey: true, shiftKey: true })
    expect(highlightedAll(container)).toEqual(["D"])
  })

  it("Cmd+A in an empty textarea escalates immediately", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "Enter", metaKey: true }) // new empty block after A, editing
    const textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("")
    fireEvent.keyDown(textarea, { key: "a", metaKey: true })
    expect(container.querySelector("textarea")).toBeNull()
    // The fresh block is a root leaf → straight to the whole page (7 blocks).
    expect(highlightedAll(container)).toHaveLength(7)
  })
})

describe("actions on ladder selections", () => {
  it("Tab indents the subtree root once (not each child), and resets the ladder", () => {
    const { container, getByTestId } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    fireEvent.keyDown(root, { key: "a", metaKey: true }) // B's subtree
    fireEvent.keyDown(root, { key: "Tab" })
    expect(serializedLines(getByTestId)).toEqual(["A", "  B", "    C", "      D", "    E", "F"])
    // The structural edit reset the ladder: shrink does nothing.
    fireEvent.keyDown(root, { key: "a", metaKey: true, shiftKey: true })
    expect(highlightedAll(container)).toEqual(["B", "C", "D", "E"])
  })

  it("Shift+Alt+ArrowDown duplicates a ladder selection as one group", () => {
    const { container, getByTestId } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    fireEvent.keyDown(root, { key: "a", metaKey: true }) // B's subtree
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true, altKey: true })
    expect(serializedLines(getByTestId)).toEqual([
      "A",
      "B",
      "  C",
      "    D",
      "  E",
      "B",
      "  C",
      "    D",
      "  E",
      "F",
    ])
  })

  it("Cmd+A to the whole page then Delete leaves a sane single-block state", () => {
    const { container } = render(<BlankKeepingHarness initial={NESTED} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "a", metaKey: true }) // A is a root leaf → page
    expect(highlightedAll(container)).toEqual(["A", "B", "C", "D", "E", "F"])
    fireEvent.keyDown(root, { key: "Backspace" })
    // Everything was removed; the trailing-blank rule leaves one empty block…
    expect(container.querySelectorAll("[data-block-id]")).toHaveLength(1)
    // …and the keyboard recovers: ArrowDown re-selects it, Enter edits it.
    fireEvent.keyDown(root, { key: "ArrowDown" })
    expect(container.querySelectorAll(".bg-bg-secondary")).toHaveLength(1)
    fireEvent.keyDown(root, { key: "Enter" })
    expect(container.querySelector("textarea")).not.toBeNull()
  })

  it("Enter on a ladder selection edits the head and clears the ladder", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["C", "D"])
    fireEvent.keyDown(root, { key: "Enter" })
    const textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("C")
    fireEvent.keyDown(textarea, { key: "Escape" })
    expect(highlightedAll(container)).toEqual(["C"])
    // The single-target command cleared the ladder: shrink does nothing.
    fireEvent.keyDown(root, { key: "a", metaKey: true, shiftKey: true })
    expect(highlightedAll(container)).toEqual(["C"])
  })
})

/** The NESTED shape with fixed ids, so tests can zoom via prop:
 *   A · B(→C(→D)·E) · F
 */
const ZOOMABLE = [
  "A",
  "  id:: blk_a",
  "B",
  "  id:: blk_b",
  "  C",
  "    id:: blk_c",
  "    D",
  "      id:: blk_d",
  "  E",
  "    id:: blk_e",
  "F",
  "  id:: blk_f",
].join("\n")

describe("zoom (focus mode)", () => {
  const crumb = (container: HTMLElement) =>
    container.querySelector('[data-testid="zoom-breadcrumb"]')

  it("renders only the zoomed subtree, with the block promoted to a title", () => {
    const { container } = render(<Harness initial={ZOOMABLE} zoomRootId="blk_b" />)
    const bodies = Array.from(container.querySelectorAll('[data-testid="block-body"]'))
    expect(bodies.map((el) => el.textContent)).toEqual(["B", "C", "D", "E"])
    // The title is visually promoted to the top of the heading scale.
    expect(bodies[0].closest(".text-2xl")).not.toBeNull()
    // The breadcrumb shows the full path, never dropping levels.
    expect(crumb(container)?.textContent).toContain("Note")
    expect(crumb(container)?.textContent).toContain("B")
    // Zoom-in lands on the first child, not the title.
    expect(highlightedText(container)).toBe("C")
  })

  it("F zooms into the selected block; Shift+F zooms back out to it", () => {
    const { container, queryByText } = render(<Harness initial={ZOOMABLE} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: "f" })
    expect(queryByText("A")).toBeNull()
    expect(crumb(container)).not.toBeNull()
    expect(highlightedText(container)).toBe("C") // first child selected
    fireEvent.keyDown(root, { key: "F", shiftKey: true })
    // Fully out (B was root-level): whole page again, selection lands on the
    // block we zoomed out FROM.
    expect(queryByText("A")).not.toBeNull()
    expect(crumb(container)).toBeNull()
    expect(highlightedText(container)).toBe("B")
  })

  it("Shift+F from a nested zoom surfaces one level, selecting the old root", () => {
    const { container, queryByText } = render(<Harness initial={ZOOMABLE} zoomRootId="blk_c" />)
    const root = editorRoot(container)
    expect(queryByText("E")).toBeNull() // C's view: title C + child D
    fireEvent.keyDown(root, { key: "F", shiftKey: true })
    // Now zoomed into B: E is visible again, and the selection is on C.
    expect(queryByText("E")).not.toBeNull()
    expect(queryByText("A")).toBeNull()
    expect(highlightedText(container)).toBe("C")
  })

  it("Mod+Enter on the zoomed title creates its FIRST child", () => {
    const { container, getByTestId } = render(<Harness initial={ZOOMABLE} zoomRootId="blk_b" />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowUp" }) // C → title B
    expect(highlightedText(container)).toBe("B")
    fireEvent.keyDown(root, { key: "Enter", metaKey: true })
    const textarea = container.querySelector("textarea")!
    expect(textarea).not.toBeNull()
    fireEvent.change(textarea, { target: { value: "hello" } })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "  hello", "  C", "    D", "  E", "F"])
  })

  it("swallows arrow-up at the top of the zoomed view (no note-title exit)", () => {
    const onExitTop = vi.fn()
    const { container } = render(
      <BlockEditor
        doc={withStarter(parse(ZOOMABLE))}
        onChange={() => {}}
        zoomRootId="blk_b"
        onExitTop={onExitTop}
      />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowUp" }) // C → title B
    fireEvent.keyDown(root, { key: "ArrowUp" }) // swallowed
    expect(highlightedText(container)).toBe("B")
    expect(onExitTop).not.toHaveBeenCalled()
  })

  it("clamps the Cmd+A ladder at the zoomed subtree", () => {
    const { container } = render(<Harness initial={ZOOMABLE} zoomRootId="blk_b" />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // C → D
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["C", "D"])
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    // The "page" rung is the zoomed view (title + subtree), nothing beyond.
    expect(highlightedAll(container)).toEqual(["B", "C", "D", "E"])
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["B", "C", "D", "E"])
    // Delete on the page rung spares the title (its children are removed).
    fireEvent.keyDown(root, { key: "Backspace" })
    expect(highlightedText(container)).toBe("B")
  })

  it("keeps the title when the last child is deleted, and refuses to delete it", () => {
    const { container, getByTestId } = render(<Harness initial={ZOOMABLE} zoomRootId="blk_c" />)
    const root = editorRoot(container)
    expect(highlightedText(container)).toBe("D")
    fireEvent.keyDown(root, { key: "Backspace" })
    // The title alone remains, selected.
    expect(highlightedText(container)).toBe("C")
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "  C", "  E", "F"])
    // Deleting the title itself is refused.
    fireEvent.keyDown(root, { key: "Backspace" })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "  C", "  E", "F"])
  })

  it("exits gracefully when the zoom root vanishes via undo", () => {
    const { container, queryByText } = render(<Harness initial={"A\nB"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true, altKey: true }) // duplicate A
    expect(highlightedText(container)).toBe("A") // the copy
    fireEvent.keyDown(root, { key: "f" }) // zoom into the copy
    expect(crumb(container)).not.toBeNull()
    expect(queryByText("B")).toBeNull()
    fireEvent.keyDown(root, { key: "z", metaKey: true }) // undo removes the copy
    // The zoomed block no longer exists → back to the whole, un-zoomed note.
    expect(crumb(container)).toBeNull()
    expect(queryByText("B")).not.toBeNull()
  })

  it("breadcrumb crumbs navigate: an ancestor crumb re-zooms, the note crumb exits", () => {
    const { container, getByText, queryByText } = render(
      <Harness initial={ZOOMABLE} zoomRootId="blk_d" />,
    )
    // Deep zoom: Note › B › C › D.
    const nav = crumb(container)!
    expect(nav.textContent!.replace(/\s+/g, "")).toContain("Note›B›C›D")
    fireEvent.click(getByText("B", { selector: "nav button" }))
    // Zoomed out to B: E visible, selection landed on the block we came from.
    expect(queryByText("E")).not.toBeNull()
    expect(queryByText("A")).toBeNull()
    expect(highlightedText(container)).toBe("D")
    fireEvent.click(getByText("Note", { selector: "nav button" }))
    expect(crumb(container)).toBeNull()
    expect(queryByText("A")).not.toBeNull()
  })
})

describe("reveal requests (outline palette)", () => {
  // jsdom's window.scrollTo only logs "Not implemented" — stub it so the
  // cancel path's scroll restore stays quiet.
  window.scrollTo = vi.fn()

  type Reveal = BlockRevealRequest

  /** Render with a fixed doc and return a helper that re-renders with a new
   * reveal message — mirroring how the palette writes nonced requests. */
  function renderWithReveal(initial: string) {
    const doc = withStarter(parse(initial))
    const view = render(<BlockEditor doc={doc} onChange={() => {}} />)
    const sendReveal = (request: Reveal) =>
      view.rerender(<BlockEditor doc={doc} onChange={() => {}} revealRequest={request} />)
    return { ...view, sendReveal }
  }

  it("preview highlights the requested block", () => {
    const { container, sendReveal } = renderWithReveal(ZOOMABLE)
    expect(highlightedText(container)).toBe("A")
    sendReveal({ type: "preview", id: "blk_c", nonce: 1 })
    expect(highlightedText(container)).toBe("C")
  })

  it("re-fires for the same block when the nonce changes (the old ?heading= bug)", () => {
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    try {
      const { container, sendReveal } = renderWithReveal(ZOOMABLE)
      scrollSpy.mockClear()
      sendReveal({ type: "commit", id: "blk_c", nonce: 1 })
      expect(highlightedText(container)).toBe("C")
      const callsAfterFirst = scrollSpy.mock.calls.length
      expect(callsAfterFirst).toBeGreaterThan(0)
      // A re-render with the SAME nonce is not a new request…
      sendReveal({ type: "commit", id: "blk_c", nonce: 1 })
      expect(scrollSpy.mock.calls.length).toBe(callsAfterFirst)
      // …but a new nonce for the same block scrolls it into view again.
      sendReveal({ type: "preview", id: "blk_c", nonce: 2 })
      expect(scrollSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst)
      expect(highlightedText(container)).toBe("C")
    } finally {
      // @ts-expect-error restore jsdom's (absent) implementation
      delete Element.prototype.scrollIntoView
    }
  })

  it("cancel restores the selection captured at the first preview", () => {
    const { container, sendReveal } = renderWithReveal(ZOOMABLE)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight B
    expect(highlightedText(container)).toBe("B")
    sendReveal({ type: "preview", id: "blk_d", nonce: 1 })
    expect(highlightedText(container)).toBe("D")
    sendReveal({ type: "preview", id: "blk_f", nonce: 2 })
    expect(highlightedText(container)).toBe("F")
    sendReveal({ type: "cancel", nonce: 3 })
    // Back to what the FIRST preview captured, not the last previewed block.
    expect(highlightedText(container)).toBe("B")
  })

  it("commit keeps the selection on the target block", async () => {
    const { container, sendReveal } = renderWithReveal(ZOOMABLE)
    sendReveal({ type: "preview", id: "blk_e", nonce: 1 })
    sendReveal({ type: "commit", id: "blk_e", nonce: 2 })
    expect(highlightedText(container)).toBe("E")
    // A cancel after a commit has no snapshot left to restore — it's a no-op.
    sendReveal({ type: "cancel", nonce: 3 })
    expect(highlightedText(container)).toBe("E")
    // After the dialog's focus juggling settles, the container is the keyboard
    // target again so arrows work from the landing block.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.activeElement).toBe(editorRoot(container))
  })

  it("ignores a preview for a block that doesn't exist", () => {
    const { container, sendReveal } = renderWithReveal(ZOOMABLE)
    sendReveal({ type: "preview", id: "blk_nope", nonce: 1 })
    expect(highlightedText(container)).toBe("A")
    // No snapshot was captured, so a cancel is a no-op too.
    sendReveal({ type: "cancel", nonce: 2 })
    expect(highlightedText(container)).toBe("A")
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
