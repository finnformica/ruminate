// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

// `useCollapseState` persists a per-device collapsed set to localStorage
// (src/data/view-state.ts) — these tests only exercise value propagation, and
// no noteId is passed, so transient collapse state is all that's needed.
vi.mock("../../data/view-state", () => ({
  useCollapseState: () => ({ collapsed: new Set<string>(), toggleCollapse: () => {} }),
}))
vi.mock("../../global-state", async () => {
  const { atom } = await import("jotai")
  return {
    graphSnapshotAtom: atom({ nodes: new Map(), childLinks: new Map(), parentLinks: new Map() }),
    // Signed out: developer mode (`hooks/is-developer.ts`) stays off, and
    // image uploads have nowhere to go.
    githubUserAtom: atom(null),
    isDatabaseModeAtom: atom(false),
    // Enter's new-block marker preference (Settings → Editor), at its default.
    newBlockMarkerAtom: atom("- "),
  }
})

import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import { BlockNoteEditor } from "./block-note-editor"

afterEach(cleanup)

/** A controlled host, like the real note page: it owns the doc and echoes
 * editor changes back down as the `doc` prop. */
function Host({ initial, startEditing }: { initial: string; startEditing?: boolean }) {
  const [doc, setDoc] = useState(() => parse(initial))
  return (
    <>
      <BlockNoteEditor doc={doc} onChange={setDoc} startEditing={startEditing} />
      <button data-testid="external-update" onClick={() => setDoc(parse("- pulled from remote"))}>
        external
      </button>
      <pre data-testid="value">{serialize(doc)}</pre>
    </>
  )
}

describe("BlockNoteEditor doc propagation", () => {
  it("re-seeds from an external doc (a pull updating the open note) without a remount", () => {
    const { container, getByTestId } = render(<Host initial="- original local line" />)
    expect(container.textContent).toContain("original local line")

    // Simulate a pull updating the note's content from outside the editor.
    fireEvent.click(getByTestId("external-update"))

    expect(container.textContent).toContain("pulled from remote")
    expect(container.textContent).not.toContain("original local line")
  })

  it("does not re-seed from its own edits when the parent echoes them back (typing survives)", () => {
    // A brand-new note mounts with its starter block already in edit mode.
    const { container } = render(<Host initial="" startEditing />)
    const textarea = container.querySelector("textarea")
    expect(textarea).not.toBeNull()

    // Type — the change round-trips through the parent's value state.
    fireEvent.change(textarea!, { target: { value: "typing in progress" } })

    // The editor keeps its live edit session: same textarea, same content —
    // the echoed doc must not trigger a re-seed that would clobber it.
    const after = container.querySelector("textarea")
    expect(after).toBe(textarea)
    expect(after!.value).toBe("typing in progress")
  })
})

// The note page counts a fold as touching the note (the palette's Recent
// list), and never a selection: reading a note is not touching it.
describe("BlockNoteEditor onToggleCollapse", () => {
  const OUTLINE = "- parent\n  - child\n- sibling\n"

  it("is told of a fold or unfold, with the row's key", () => {
    const onToggleCollapse = vi.fn()
    const onChange = vi.fn()
    const { getByLabelText } = render(
      <BlockNoteEditor
        noteId="n"
        doc={parse(OUTLINE)}
        onChange={onChange}
        onToggleCollapse={onToggleCollapse}
      />,
    )
    fireEvent.click(getByLabelText("Collapse"))
    expect(onToggleCollapse).toHaveBeenCalledTimes(1)
    expect(typeof onToggleCollapse.mock.calls[0][0]).toBe("string")
    // A fold is the view's, not the note's: no change to the doc.
    expect(onChange).not.toHaveBeenCalled()
  })

  it("a zoom reaches the page through onZoomNavigate — which the page counts as a touch", () => {
    const onZoomNavigate = vi.fn()
    const { container, getByText } = render(
      <BlockNoteEditor
        noteId="n"
        doc={parse(OUTLINE)}
        onChange={() => {}}
        onZoomNavigate={onZoomNavigate}
      />,
    )
    fireEvent.click(getByText("parent"))
    const editor = container.querySelector<HTMLElement>("[data-block-editor]")!
    fireEvent.keyDown(editor, { key: "f" })
    expect(onZoomNavigate).toHaveBeenCalledTimes(1)
    expect(typeof onZoomNavigate.mock.calls[0][0]).toBe("string")
  })

  it("is not told of a selection — a click on a row, or the arrows through it", () => {
    const onToggleCollapse = vi.fn()
    const onChange = vi.fn()
    const { container, getByText } = render(
      <BlockNoteEditor
        noteId="n"
        doc={parse(OUTLINE)}
        onChange={onChange}
        onToggleCollapse={onToggleCollapse}
      />,
    )
    fireEvent.click(getByText("parent"))
    const editor = container.querySelector<HTMLElement>("[data-block-editor]")!
    fireEvent.keyDown(editor, { key: "ArrowDown" })
    fireEvent.keyDown(editor, { key: "ArrowDown" })
    fireEvent.keyDown(editor, { key: "ArrowUp" })
    expect(onToggleCollapse).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe("the last row of a doc without a trailing blank (the basket)", () => {
  /** The basket's shape: no trailing blank, and a removal is the delete. */
  function Basket({ initial }: { initial: string }) {
    const [doc, setDoc] = useState(() => parse(initial))
    return (
      <>
        <BlockNoteEditor doc={doc} onChange={setDoc} trailingBlank={false} rowRemoval="delete" />
        <pre data-testid="roots">{doc.rootBlockIds.length}</pre>
      </>
    )
  }
  const editorRoot = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[tabindex="-1"]')!

  it("can be removed: the basket empties", () => {
    const { container, getByTestId } = render(<Basket initial="- the last unassigned block" />)
    expect(getByTestId("roots").textContent).toBe("1")
    fireEvent.keyDown(editorRoot(container), { key: "Backspace" })
    expect(getByTestId("roots").textContent).toBe("0")
    expect(container.querySelector("[data-occurrence]")).toBeNull()
  })

  it("is kept in the outline, where the trailing blank is the block to type in", () => {
    const { container } = render(<Host initial="" />)
    expect(container.querySelectorAll("[data-occurrence]")).toHaveLength(1)
    fireEvent.keyDown(editorRoot(container), { key: "Backspace" })
    expect(container.querySelectorAll("[data-occurrence]")).toHaveLength(1)
  })
})
