// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { toast, Toaster } from "sonner"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { emptyBlock } from "../../blocks/ops"
import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import type { BlockDoc, ChangeHint } from "../../blocks/types"
import { richClipboardFormats } from "../../utils/rich-clipboard"
import { ImageUploadError, type UploadedImage } from "../../data/images"
import type { LinkPreview } from "../../blocks/link"
import { LinkPreviewError } from "../../data/link-previews"
import { BlockEditor, type BlockDebugOptions } from "./block-editor"
import { getDefaultStore } from "jotai"
import { viewRootIdsAtom, viewsAtom } from "../../data/views"

// The context menu (Base UI) measures its popup with a ResizeObserver and
// scrolls the highlighted item into view; jsdom implements neither.
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  // A view made from a menu lands in the default store; the next test
  // starts with none.
  getDefaultStore().set(viewsAtom, new Map())
})

/** The rows' block ids, in document order. */
const idsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-block-row]")).map((row) =>
    row.getAttribute("data-block-row")!,
  )

/** Mirror BlockNoteEditor: an empty parse still gets one block to edit. */
function withStarter(doc: BlockDoc): BlockDoc {
  if (doc.rootBlockIds.length > 0) return doc
  const block = emptyBlock()
  return { ...doc, rootBlockIds: [block.id], blocks: { [block.id]: block } }
}

/** A controlled host, like the real note page: it owns the doc and re-renders
 * on change, while the editor keeps its own selection/focus state. */
function Harness({
  initial = "",
  initialDoc,
  startEditing,
  focusRootId,
  refocusSignal,
  newRootSignal,
  resolveBlocks,
  debug,
  parentCountOf,
  onDeleteEverywhere,
  onImageUpload,
  onLinkPreview,
  onHint,
  knownBlock,
  noteId,
}: {
  initial?: string
  /** A doc built by hand — for shapes markdown cannot express (a shared block). */
  initialDoc?: BlockDoc
  startEditing?: boolean
  focusRootId?: string | null
  refocusSignal?: number
  newRootSignal?: number
  resolveBlocks?: (ids: string[]) => Record<string, string | null>
  debug?: BlockDebugOptions
  parentCountOf?: (id: string) => number
  onDeleteEverywhere?: (ids: string[]) => void
  onImageUpload?: (file: File) => Promise<UploadedImage>
  onLinkPreview?: (url: string) => Promise<LinkPreview>
  /** Sees every change's hint (undefined when there is none). */
  onHint?: (hint: ChangeHint | undefined) => void
  knownBlock?: (id: string) => boolean
  /** The note behind the doc (what Pin and Copy link need). */
  noteId?: string
}) {
  const [doc, setDoc] = useState<BlockDoc>(() => initialDoc ?? withStarter(parse(initial)))
  return (
    <>
      <BlockEditor
        doc={doc}
        onChange={(next, hint) => {
          onHint?.(hint)
          setDoc(next)
        }}
        knownBlock={knownBlock}
        noteId={noteId}
        startEditing={startEditing}
        focusRootId={focusRootId}
        refocusSignal={refocusSignal}
        newRootSignal={newRootSignal}
        resolveBlocks={resolveBlocks}
        debug={debug}
        parentCountOf={parentCountOf}
        onDeleteEverywhere={onDeleteEverywhere}
        onImageUpload={onImageUpload}
        onLinkPreview={onLinkPreview}
      />
      <pre data-testid="serialized">{serialize(doc)}</pre>
      {/* Markdown carries no layout, so image props are shown as themselves. */}
      <pre data-testid="image-props">
        {JSON.stringify(
          Object.values(doc.blocks)
            .filter((block) => block.type === "image")
            .map((block) => block.props ?? null),
        )}
      </pre>
      <pre data-testid="link-props">
        {JSON.stringify(
          Object.values(doc.blocks)
            .filter((block) => block.type === "link")
            .map((block) => block.props ?? null),
        )}
      </pre>
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
    if (last && last.type === "text" && last.text === "" && last.children.length === 0) {
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

/** The body text of a highlighted line, marker chrome (a heading's `#`, an
 * ordered number) excluded. */
function lineBody(line: Element): string {
  return line.querySelector('[data-testid="block-body"]')?.textContent ?? line.textContent ?? ""
}

/** Text of the currently highlighted block (the row with the select background). */
function highlightedText(container: HTMLElement): string | null {
  const line = container.querySelector(".bg-bg-secondary")
  return line ? lineBody(line) : null
}

/** Texts of every highlighted block, in document order. */
function highlightedAll(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".bg-bg-secondary")).map(lineBody)
}

/** Content lines of the serialized doc (id:: lines and blanks dropped),
 * keeping indentation so nesting is visible. */
function serializedLines(getByTestId: (id: string) => HTMLElement): string[] {
  return getByTestId("serialized")
    .textContent!.split("\n")
    .filter((l) => !l.includes("id::") && l.trim() !== "")
}

describe("BlockEditor text wrapping", () => {
  /** A one-block doc with exactly this text (markdown cannot express these). */
  const docWith = (text: string): BlockDoc => ({
    props: null,
    rootBlockIds: ["a"],
    blocks: { a: { id: "a", type: "text", text, children: [] } },
  })
  const bodyOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-testid="block-body"]')!

  it("shows a block's text as stored: leading markers and tabs stay visible", () => {
    for (const text of ["- not a bullet", "# not a heading", "> not a quote", "1. not a list"]) {
      const { container, unmount } = render(<Harness initialDoc={docWith(text)} />)
      const body = bodyOf(container)
      expect(body.textContent).toBe(text)
      expect(body.querySelector("ul, ol, li, h1, blockquote")).toBeNull()
      unmount()
    }
    const { container } = render(<Harness initialDoc={docWith("\tTabbed prose that must wrap")} />)
    expect(bodyOf(container).textContent).toBe("\tTabbed prose that must wrap")
    expect(bodyOf(container).className).toContain("whitespace-pre-wrap")
  })

  it("a fence inside a text block stays a visible fence, wrapping as text", () => {
    const text = "```\nconst reallyLongVariableName = someFunctionCall(anotherArgument)"
    const { container } = render(<Harness initialDoc={docWith(text)} />)
    const body = bodyOf(container)
    expect(body.querySelector("pre")).toBeNull()
    expect(body.textContent).toBe(text)
  })

  it("still applies inline formatting", () => {
    const { container } = render(
      <Harness initialDoc={docWith("**bold** and `code` and [a link](https://example.com)")} />,
    )
    const body = bodyOf(container)
    expect(body.querySelector("strong")!.textContent).toBe("bold")
    expect(body.querySelector("code")!.textContent).toBe("code")
    expect(body.querySelector("a")!.getAttribute("href")).toBe("https://example.com")
  })

  it("lets a long unbroken word (a URL) break instead of overflowing the row", () => {
    const { container } = render(
      <Harness initial={"https://example.com/a/very/long/path/that/never/breaks"} />,
    )
    const body = container.querySelector('[data-testid="block-body"]')!
    expect(body.className).toContain("[overflow-wrap:anywhere]")
    // The edit textarea wraps the same way, so switching modes never reflows.
    fireEvent.doubleClick(body)
    expect(container.querySelector("textarea")!.className).toContain("[overflow-wrap:anywhere]")
  })
})

describe("BlockEditor focus + keyboard", () => {
  it("starts a new note in edit mode with the textarea focused", () => {
    const { container } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")
    expect(textarea).not.toBeNull()
    expect(document.activeElement).toBe(textarea)
  })

  it("a new root block (Enter on the title) edits an empty first block rather than adding one", () => {
    const { container, getByTestId, rerender } = render(<Harness initial="" newRootSignal={0} />)
    expect(container.querySelectorAll("[data-block-row]").length).toBe(1)
    rerender(<Harness initial="" newRootSignal={1} />)
    const textarea = container.querySelector("textarea")
    expect(textarea).not.toBeNull()
    expect(document.activeElement).toBe(textarea)
    // Still one block: the starter was reused, none stacked above it — and
    // it is the type Enter makes (the "New block markdown" setting, a bullet
    // by default), as a block made at the end of another would be.
    expect(container.querySelectorAll("[data-block-row]").length).toBe(1)
    expect(serializedLines(getByTestId)).toEqual(["- "])
  })

  it("a new root block above content goes in first and is edited", () => {
    const { container, getByTestId, rerender } = render(<Harness initial="- a" newRootSignal={0} />)
    rerender(<Harness initial="- a" newRootSignal={1} />)
    const textarea = container.querySelector("textarea")
    expect(document.activeElement).toBe(textarea)
    expect(textarea?.value).toBe("")
    const rows = container.querySelectorAll("[data-block-row]")
    expect(rows.length).toBe(2)
    // The fresh block is first, of the default new-block type; the existing
    // bullet follows it.
    expect(rows[0].contains(textarea)).toBe(true)
    expect(serializedLines(getByTestId)).toEqual(["- ", "- a"])
  })

  it("keeps editing when the window loses focus (a tab switch), ends it on a real blur", () => {
    const { container } = render(
      <>
        <Harness initial="A" startEditing />
        <input data-testid="outside" />
      </>,
    )
    const textarea = container.querySelector("textarea")!
    expect(document.activeElement).toBe(textarea)

    // The window going away: the textarea blurs with nowhere in the page
    // taking focus and the document no longer focused. The edit stays open,
    // so the browser can hand focus back to the same textarea on return.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false)
    fireEvent.blur(textarea)
    expect(container.querySelector("textarea")).toBe(textarea)
    hasFocus.mockReturnValue(true)
    fireEvent.focus(textarea)
    expect(container.querySelector("textarea")).toBe(textarea)

    // Focus moving to another control in the page is the user leaving the
    // block: editing ends.
    act(() => container.querySelector<HTMLInputElement>('[data-testid="outside"]')!.focus())
    expect(container.querySelector("textarea")).toBeNull()
    hasFocus.mockRestore()
  })

  it("a blur with focus still in the document (a click on blank page) ends editing", () => {
    const { container } = render(<Harness initial="A" startEditing />)
    const textarea = container.querySelector("textarea")!
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true)
    fireEvent.blur(textarea)
    expect(container.querySelector("textarea")).toBeNull()
    hasFocus.mockRestore()
  })

  it("an empty block shows nothing in view mode (no placeholder text)", () => {
    const { container } = render(<Harness initial="" />)
    expect(container.querySelector('[data-testid="block-body"]')?.textContent).toBe("")
    expect(container.textContent).not.toContain("Empty")
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

  it("deleting a block selects the one below (above only when it was last)", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight B
    fireEvent.keyDown(root, { key: "Backspace" }) // delete B
    // C slid into B's place and takes the highlight.
    expect(highlightedText(container)).toBe("C")
    fireEvent.keyDown(root, { key: "Backspace" }) // delete C — now the last block
    expect(highlightedText(container)).toBe("A")
  })

  it("deleting a multi-selection selects the block below the removed range", () => {
    const { container } = render(<Harness initial={"A\nB\nC\nD"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight B
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true }) // extend to C
    expect(highlightedAll(container)).toEqual(["B", "C"])
    fireEvent.keyDown(root, { key: "Backspace" })
    expect(highlightedText(container)).toBe("D")
    // A bottom-anchored range falls back to the block above it.
    fireEvent.keyDown(root, { key: "ArrowUp", shiftKey: true }) // extend D up to A
    expect(highlightedAll(container)).toEqual(["A", "D"])
    fireEvent.keyDown(root, { key: "Backspace" })
    expect(container.querySelectorAll("[data-block-id]")).toHaveLength(0)
  })

  it("deleting a bottom-anchored multi-selection selects the block above it", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight B
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true }) // extend to C
    fireEvent.keyDown(root, { key: "Backspace" })
    expect(highlightedText(container)).toBe("A")
  })

  it("undo after creating a block with Enter lands back on the originating block", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight B
    fireEvent.keyDown(root, { key: "Enter" }) // edit B (caret at end)
    const textarea = container.querySelector("textarea")!
    fireEvent.keyDown(textarea, { key: "Enter" }) // create a block below B
    expect(container.querySelector("textarea")!.value).toBe("")
    fireEvent.keyDown(container.querySelector("textarea")!, { key: "z", metaKey: true }) // undo
    // Not the first block in the note — the block Enter was pressed on; and
    // still editing it, since the undo was made mid-edit.
    expect(container.querySelector("textarea")!.value).toBe("B")
    // Redo brings the created block back and lands editing it.
    fireEvent.keyDown(container.querySelector("textarea")!, {
      key: "z",
      metaKey: true,
      shiftKey: true,
    })
    expect(container.querySelector("textarea")!.value).toBe("")
    // Out of the edit, the highlight is on the block that came back.
    fireEvent.keyDown(container.querySelector("textarea")!, { key: "Escape" })
    expect(highlightedAll(container)).toHaveLength(1)
    expect(highlightedText(container)).not.toBe("B")
  })

  it("undo after Cmd+Enter-inserting a block lands back on the originating block", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight B
    fireEvent.keyDown(root, { key: "Enter", metaKey: true }) // insert below B, editing
    const textarea = container.querySelector("textarea")!
    fireEvent.keyDown(textarea, { key: "z", metaKey: true }) // undo the insert
    // Mid-edit, so the undo keeps you editing: now B itself.
    expect(container.querySelector("textarea")!.value).toBe("B")
    fireEvent.keyDown(container.querySelector("textarea")!, { key: "Escape" })
    expect(highlightedText(container)).toBe("B")
  })

  it("hands off from the title into the first block editing when mode is edit", () => {
    // A signal is an edge: a bump after mount fires the hand-off once; mode
    // "edit" should open the first block's textarea (title was being edited).
    const doc = withStarter(parse("A\nB"))
    const { container, rerender } = render(
      <BlockEditor doc={doc} onChange={() => {}} focusFirstSignal={0} focusFirstMode="edit" />,
    )
    expect(container.querySelector("textarea")).toBeNull()
    rerender(
      <BlockEditor doc={doc} onChange={() => {}} focusFirstSignal={1} focusFirstMode="edit" />,
    )
    expect(container.querySelector("textarea")).not.toBeNull()
  })

  it("mounting under an already-bumped signal is not a hand-off", () => {
    // The palette swaps its lists as the query changes; a fresh editor under
    // a counter bumped for an earlier one must not take the keyboard.
    const { container } = render(
      <BlockEditor
        doc={withStarter(parse("A\nB"))}
        onChange={() => {}}
        focusFirstSignal={3}
        focusFirstMode="edit"
      />,
    )
    expect(container.querySelector("textarea")).toBeNull()
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
    const highlighted = Array.from(container.querySelectorAll(".bg-bg-secondary")).map((el) =>
      lineBody(el),
    )
    expect(highlighted).toEqual(["A", "B"])
  })
})

describe("Escape ladder + keyboard recovery", () => {
  it("refocusSignal restores the last selected block and container focus", () => {
    const { container, rerender } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight B
    fireEvent.keyDown(root, { key: "Escape" }) // deselect
    root.blur()
    expect(highlightedText(container)).toBeNull()
    rerender(<Harness initial={"A\nB\nC"} refocusSignal={1} />)
    expect(highlightedText(container)).toBe("B")
    expect(document.activeElement).toBe(root)
  })

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

  /** Texts of the blocks actually rendered (collapsed children are unmounted).
   * Scoped to block bodies so the harness's serialized <pre> doesn't match. */
  const renderedBlocks = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('[data-testid="block-body"]'))
      // Rows folding away linger for their animation; they are not rows.
      .filter((el) => !el.closest("[data-folding]"))
      .map((el) => el.textContent ?? "")

  it("pastes parsed blocks INTO the selected block, without entering edit mode", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    const root = editorRoot(container)
    paste(root, "# New heading\r\n- new bullet")
    const md = getByTestId("serialized").textContent!
    const lines = md.split("\n").filter((l) => !l.includes("id::") && l.trim() !== "")
    // Indented under A, not beside it: pasting onto a selected block links the
    // content downstream from it — "paste here", not "paste next to".
    expect(lines).toEqual(["A", "  # New heading", "  - new bullet", "B"])
    // Nothing landed between A's subtree and B — B is still a root.
    expect(lines.indexOf("B")).toBe(lines.length - 1)
    // No textarea opened; the last inserted block is highlighted.
    expect(container.querySelector("textarea")).toBeNull()
    expect(highlightedText(container)).toBe("new bullet")
    // Neither pasted root has children, so nothing was folded away.
    expect(renderedBlocks(container)).toContain("new bullet")
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
    expect(serializedLines(getByTestId)).toEqual(["A", "  - **a**", "    - b", "B"])
  })

  it("rebuilds the exact block tree from a Ruminate html payload", () => {
    // Bare `[ ] ` todo markers + a quote child: the private payload restores
    // them verbatim, which no plain/html conversion could guarantee.
    const formats = richClipboardFormats("[ ] task\n  > child")
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    paste(editorRoot(container), formats.plain, formats.html)
    // The whole tree arrived under A. The serialized doc is the source of
    // truth here: the pasted root has a child, so it lands folded and the
    // quote is not on screen.
    expect(serializedLines(getByTestId)).toEqual(["A", "  [ ] task", "    > child", "B"])
    expect(renderedBlocks(container)).toContain("task")
    expect(renderedBlocks(container)).not.toContain("child")
  })

  it("Mod+Shift+V pastes the plain flavor as one child block, ignoring html", () => {
    const { container, getByTestId } = render(<Harness initial={"A"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "v", metaKey: true, shiftKey: true })
    paste(root, "plain one\nplain two", "<ul><li>rich</li></ul>")
    expect(serializedLines(getByTestId)).toEqual(["A", "  plain one plain two"])
  })

  it("expands the target so the paste is visible, even when it was folded", () => {
    const { container, getByTestId } = render(<Harness initial={"A\n  old\nB"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowLeft" }) // fold A — `old` leaves the DOM
    expect(renderedBlocks(container)).not.toContain("old")
    paste(root, "fresh")
    // The content landed inside A, so A is unfolded rather than swallowing it.
    expect(serializedLines(getByTestId)).toEqual(["A", "  fresh", "  old", "B"])
    expect(renderedBlocks(container)).toContain("fresh")
    expect(renderedBlocks(container)).toContain("old")
  })

  it("folds each pasted root that has children, so a subtree arrives as one line", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    paste(editorRoot(container), "parent\n  kid\n    grandkid\nleaf")
    // Both roots landed whole, children and all…
    expect(serializedLines(getByTestId)).toEqual([
      "A",
      "  parent",
      "    kid",
      "      grandkid",
      "  leaf",
      "B",
    ])
    // …but only the roots are on screen: `parent` came in folded, and `leaf`
    // has no children to fold.
    expect(renderedBlocks(container)).toContain("parent")
    expect(renderedBlocks(container)).toContain("leaf")
    expect(renderedBlocks(container)).not.toContain("kid")
    expect(renderedBlocks(container)).not.toContain("grandkid")
    // The fold is real state, not a transient: unfolding shows the subtree.
    fireEvent.keyDown(editorRoot(container), { key: "ArrowUp" }) // select `parent`
    fireEvent.keyDown(editorRoot(container), { key: "ArrowRight" })
    expect(renderedBlocks(container)).toContain("kid")
  })

  it("pasted content with its own marker defines the block type (no doubled #)", () => {
    // Cut → paste round trip of "# Header + bullets" into an empty heading
    // block must not become "# # Header" (a literal # left in the text).
    const { container, getByTestId } = render(<Harness initial={"# "} startEditing />)
    const textarea = container.querySelector("textarea")!
    fireEvent.paste(textarea, {
      clipboardData: { getData: (type: string) => (type === "text/plain" ? "# Header\n- a" : "") },
    })
    expect(serializedLines(getByTestId)).toEqual(["# Header", "- a"])
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

describe("paste as link (Ruminate payload with ids)", () => {
  function paste(target: HTMLElement, text: string, html = "") {
    fireEvent.paste(target, {
      clipboardData: { getData: (type: string) => (type === "text/html" ? html : text) },
    })
  }

  /** Every id declared in the serialized doc, in document order. */
  function docIds(getByTestId: (id: string) => HTMLElement): string[] {
    return [...getByTestId("serialized").textContent!.matchAll(/id:: (\S+)/g)].map((m) => m[1])
  }

  it("links unknown ids using their LIVE content from the resolver, ids preserved", () => {
    const formats = richClipboardFormats("- clipboard stale\n  id:: blk_xlink00000")
    const resolver = vi.fn(() => ({
      blk_xlink00000:
        "- live from store\n  id:: blk_xlink00000\n  - live child\n    id:: blk_xchild0000\n",
    }))
    const { container, getByTestId } = render(<Harness initial={"A\nB"} resolveBlocks={resolver} />)
    paste(editorRoot(container), formats.plain, formats.html)

    // The node arrives as itself (original ids) with the store's current
    // content — never the clipboard bytes — linked under A, the selection.
    // Asserted against the serialized doc, since the linked root has a child
    // and so lands folded.
    expect(serializedLines(getByTestId)).toEqual([
      "A",
      "  - live from store",
      "    - live child",
      "B",
    ])
    expect(docIds(getByTestId)).toContain("blk_xlink00000")
    expect(docIds(getByTestId)).toContain("blk_xchild0000")
    expect(getByTestId("serialized").textContent).not.toContain("clipboard stale")
    expect(resolver).toHaveBeenCalledWith(["blk_xlink00000"])
  })

  it("falls back to the clipboard content, ids intact, when the node exists nowhere", () => {
    // The cut side of cut+paste: the source save already deleted the node.
    const formats = richClipboardFormats("- carried along\n  id:: blk_xgone00000")
    const resolver = vi.fn(() => ({ blk_xgone00000: null }))
    const { container, getByTestId } = render(<Harness initial={"A\nB"} resolveBlocks={resolver} />)
    paste(editorRoot(container), formats.plain, formats.html)

    expect(serializedLines(getByTestId)).toEqual(["A", "  - carried along", "B"])
    expect(docIds(getByTestId)).toContain("blk_xgone00000")
  })

  it("links a block into a second place in the same note: one node, two rows, one text", () => {
    const { container, getByTestId } = render(<Harness initial={"A\n  B\nC"} />)
    const idB = getByTestId("serialized").textContent!.match(/B\n\s*id:: (\S+)/)![1]
    const formats = richClipboardFormats(`B\n  id:: ${idB}`)
    const root = editorRoot(container)
    // Select C (a different parent than B's) and paste.
    fireEvent.keyDown(root, { key: "ArrowDown" })
    fireEvent.keyDown(root, { key: "ArrowDown" })
    paste(root, formats.plain, formats.html)

    // The same node now hangs under C too — its id appears in both places,
    // and nothing was reminted.
    expect(serializedLines(getByTestId)).toEqual(["A", "  B", "C", "  B"])
    expect(docIds(getByTestId).filter((id) => id === idB)).toHaveLength(2)

    // Both rows are the one block: editing the pasted row changes the text
    // everywhere it shows.
    fireEvent.keyDown(root, { key: "Enter" }) // edit the pasted row (selected)
    const textarea = container.querySelector("textarea")!
    fireEvent.change(textarea, { target: { value: "B edited" } })
    expect(serializedLines(getByTestId)).toEqual(["A", "  B edited", "C", "  B edited"])
  })

  it("refuses to put a block inside itself, and says so", async () => {
    const { container, getByTestId } = render(
      <>
        <Harness initial={"A\nB"} />
        <Toaster />
      </>,
    )
    const before = getByTestId("serialized").textContent!
    const idA = before.match(/A\n\s*id:: (\S+)/)![1]
    const root = editorRoot(container) // A is selected on mount
    const formats = richClipboardFormats(`A\n  id:: ${idA}`)
    await act(async () => {
      paste(root, formats.plain, formats.html)
    })
    expect(getByTestId("serialized").textContent).toBe(before)
    expect(await screen.findByText("A block can't be put inside itself")).not.toBeNull()
    toast.dismiss()
  })

  it("skips a block already a direct child of the paste target (twin), keeping its siblings", async () => {
    // The target IS the insertion parent now, so the twin scope is its own
    // children: B already hangs off A.
    const { container, getByTestId } = render(
      <>
        <Harness initial={"A\n  B"} />
        <Toaster />
      </>,
    )
    const before = getByTestId("serialized").textContent!
    const idB = before.match(/B\n\s*id:: (\S+)/)![1]
    const root = editorRoot(container) // A is selected on mount

    // B alone: the whole paste is a no-op — it's already there — and a toast
    // says so, since a paste that does nothing would look broken.
    const twinOnly = richClipboardFormats(`B\n  id:: ${idB}`)
    await act(async () => {
      paste(root, twinOnly.plain, twinOnly.html)
    })
    expect(getByTestId("serialized").textContent).toBe(before)
    // sonner mounts a toast on a deferred tick.
    expect(await screen.findByText("That block is already here")).not.toBeNull()
    toast.dismiss()

    // B + an unknown sibling: B is skipped, the sibling still lands under A.
    const mixed = richClipboardFormats(`B\n  id:: ${idB}\nZ new\n  id:: blk_znew000000`)
    paste(root, mixed.plain, mixed.html)
    expect(serializedLines(getByTestId)).toEqual(["A", "  Z new", "  B"])
    expect(docIds(getByTestId)).toContain("blk_znew000000")
    expect(docIds(getByTestId).filter((id) => id === idB)).toHaveLength(1)
  })

  it("links a block beneath its own ancestry: the loop shows where it closes", () => {
    const CycleHarness = () => {
      const [doc, setDoc] = useState<BlockDoc>(() => withStarter(parse("P\n  T")))
      const idP = doc.rootBlockIds[0]
      const resolver = (ids: string[]) =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            // The live view of the pasted node contains P — linking it under
            // T closes a loop through P.
            `- X live\n  id:: ${id}\n  - P again\n    id:: ${idP}\n`,
          ]),
        )
      return (
        <>
          <BlockEditor doc={doc} onChange={setDoc} resolveBlocks={resolver} />
          <pre data-testid="serialized">{serialize(doc)}</pre>
        </>
      )
    }
    const { container, getByTestId } = render(<CycleHarness />)
    const idP = docIds(getByTestId)[0]
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // select T (a child of P)
    const formats = richClipboardFormats("- X\n  id:: blk_xcycle0000")
    paste(root, formats.plain, formats.html)

    // X is linked under T with its live content — P included, which closes
    // the loop: the serialization shows P once more beneath X and stops.
    expect(serializedLines(getByTestId)).toEqual(["P", "  T", "    - X live", "      P"])
    const ids = docIds(getByTestId)
    expect(ids).toContain("blk_xcycle0000")
    expect(ids.filter((id) => id === idP)).toHaveLength(2)
  })

  it("renders a loop's closing row once, with an inert chevron and nothing beneath it", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a"],
      blocks: {
        a: { id: "a", type: "ul", text: "A", children: ["b"] },
        b: { id: "b", type: "ul", text: "B", children: ["a"] },
      },
    }
    const { container, getByTestId } = render(<Harness initialDoc={doc} />)
    expect(serializedLines(getByTestId)).toEqual(["- A", "  - B", "    - A"])
    const rows = container.querySelectorAll("[data-occurrence]")
    expect([...rows].map((r) => r.getAttribute("data-occurrence"))).toEqual(["a", "a/b", "a/b/a"])
    // The closing row keeps a chevron — the block has children, above it —
    // pinned, inert and explained, never a working fold toggle.
    expect(rows[2].querySelector('[aria-label="Collapse"], [aria-label="Expand"]')).toBeNull()
    const loop = rows[2].querySelector<HTMLButtonElement>('[aria-label="Loop detected"]')!
    expect(loop).not.toBeNull()
    expect(loop.getAttribute("aria-disabled")).toBe("true")
    expect(loop.className).toContain("cursor-not-allowed")
    expect(loop.className).toContain("block-toggle-pinned")
    fireEvent.click(loop)
    expect(serializedLines(getByTestId)).toEqual(["- A", "  - B", "    - A"])
    // Ordinary parents are unchanged: a real toggle, no explanation.
    expect(rows[0].querySelector('[aria-label="Collapse"]')).not.toBeNull()
    expect(container.querySelectorAll('[aria-label="Loop detected"]')).toHaveLength(1)
  })

  it("keeps the same ids through a cut + paste (a true move)", () => {
    const docAny = document as unknown as { execCommand?: (command: string) => boolean }
    const captured: Record<string, string> = {}
    docAny.execCommand = vi.fn(() => {
      const event = new Event("copy", { bubbles: true, cancelable: true })
      Object.assign(event, {
        clipboardData: {
          setData: (type: string, value: string) => {
            captured[type] = value
          },
        },
      })
      document.dispatchEvent(event)
      return true
    })
    try {
      const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
      const idA = getByTestId("serialized").textContent!.match(/A\n\s*id:: (\S+)/)![1]
      const root = editorRoot(container)

      fireEvent.keyDown(root, { key: "x", metaKey: true }) // cut A
      expect(serializedLines(getByTestId)).toEqual(["B"])
      // The visible flavor stays clean markdown; ids ride only in the payload.
      expect(captured["text/plain"]).toBe("A")
      expect(captured["text/html"]).toContain("x-ruminate-blocks")

      // Paste onto B: no resolver (the node is gone everywhere) — the
      // clipboard content returns under the ORIGINAL id, as B's child.
      paste(root, captured["text/plain"], captured["text/html"])
      expect(serializedLines(getByTestId)).toEqual(["B", "  A"])
      expect(docIds(getByTestId)).toContain(idA)
    } finally {
      delete docAny.execCommand
    }
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

/** The NESTED shape with fixed ids, so tests can focus via prop:
 *   A · B(→C(→D)·E) · F
 */
const FOCUS_TREE = [
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

/** The same shape with B and C as HEADINGS — the one family a focus draws as
 * the view's title rather than as its first row (`titlesFocus`). */
const FOCUS_TREE_H = [
  "A",
  "  id:: blk_a",
  "# B",
  "  id:: blk_b",
  "  # C",
  "    id:: blk_c",
  "    D",
  "      id:: blk_d",
  "  E",
  "    id:: blk_e",
  "F",
  "  id:: blk_f",
].join("\n")

describe("focus mode", () => {
  const crumb = (container: HTMLElement) =>
    container.querySelector('[data-testid="focus-breadcrumb"]')
  /** The focus title: the focused block drawn as the note title is (an h1 with
   * the hanging #), above the rows. */
  const focusTitle = (container: HTMLElement) => container.querySelector("h1")
  /** The title's focusable heading (select mode), or its field while editing. */
  const focusTitleButton = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('h1 [role="button"]')!
  const focusTitleInput = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>("h1 input")

  /** The occurrence keys on screen, in order. */
  const occurrences = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("[data-occurrence]")).map(
      (el) => (el as HTMLElement).dataset.occurrence,
    )

  it("renders only the focused subtree, with a focused HEADING as the view's title", () => {
    const { container } = render(<Harness initial={FOCUS_TREE_H} focusRootId="blk_b" />)
    // The rows are the focused heading's children; the heading itself is not a row…
    const bodies = Array.from(container.querySelectorAll('[data-testid="block-body"]'))
    expect(bodies.map((el) => el.textContent)).toEqual(["C", "D", "E"])
    // …but the title above them: the same heading the note's own title is —
    // 3xl, the hanging # — with the block's text.
    const title = focusTitle(container)!
    expect(title.className).toContain("text-3xl")
    expect(title.className).toContain("note-header")
    expect(title.textContent).toBe("#B")
    expect(focusTitleButton(container).textContent).toBe("B")
    // The breadcrumb is the navigation stack: a direct (deep-link) focus knows
    // only the note and the block itself.
    expect(crumb(container)?.textContent).toContain("Note")
    expect(crumb(container)?.textContent).toContain("B")
    // Focus-in lands on the first child, not the title.
    expect(highlightedText(container)).toBe("C")
  })

  it("leads with the block itself when it is not a heading, and draws no title", () => {
    const { container } = render(<Harness initial={FOCUS_TREE} focusRootId="blk_b" />)
    // B is a paragraph — content, not a name — so the view leads with its own
    // row and the outline beneath reads exactly as it does outside focus.
    const bodies = Array.from(container.querySelectorAll('[data-testid="block-body"]'))
    expect(bodies.map((el) => el.textContent)).toEqual(["B", "C", "D", "E"])
    expect(occurrences(container)).toEqual([
      "blk_b",
      "blk_b/blk_c",
      "blk_b/blk_c/blk_d",
      "blk_b/blk_e",
    ])
    // No title at all — the breadcrumb alone says where we are.
    expect(focusTitle(container)).toBeNull()
    expect(crumb(container)?.textContent).toContain("B")
    // The highlight lands on the block that was focused into.
    expect(highlightedText(container)).toBe("B")
  })

  it("↑ from the first row selects the title; ↓ and Enter come back down", () => {
    const { container, getByTestId } = render(
      <Harness initial={FOCUS_TREE_H} focusRootId="blk_b" />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowUp" }) // C → the title
    // The title takes the highlight (the same selected treatment as a row)
    // and the keyboard; no row stays highlighted beneath it.
    expect(highlightedText(container)).toBe("B")
    expect(document.activeElement).toBe(focusTitleButton(container))
    // ↓ highlights the first row again.
    fireEvent.keyDown(focusTitleButton(container), { key: "ArrowDown" })
    expect(highlightedText(container)).toBe("C")
    // Enter on the highlighted title edits it: the block's text, in a field.
    fireEvent.keyDown(root, { key: "ArrowUp" })
    fireEvent.keyDown(focusTitleButton(container), { key: "Enter" })
    const input = focusTitleInput(container)!
    expect(input.value).toBe("B")
    // Enter commits the rename — a text edit of the block — and carries on
    // into a new FIRST child, as Enter on the note title does (of the type
    // Enter makes: a bullet, by default).
    fireEvent.change(input, { target: { value: "Bee" } })
    fireEvent.keyDown(input, { key: "Enter" })
    const textarea = container.querySelector("textarea")!
    expect(textarea).not.toBeNull()
    fireEvent.change(textarea, { target: { value: "hello" } })
    expect(serializedLines(getByTestId)).toEqual([
      "A",
      "# Bee",
      "  - hello",
      "  # C",
      "    D",
      "  E",
      "F",
    ])
    expect(focusTitle(container)!.textContent).toBe("#Bee")
  })

  it("renaming the title is one undo step", () => {
    const { container, getByTestId } = render(
      <Harness initial={FOCUS_TREE_H} focusRootId="blk_b" />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowUp" })
    fireEvent.keyDown(focusTitleButton(container), { key: "Enter" })
    const input = focusTitleInput(container)!
    fireEvent.change(input, { target: { value: "Bee" } })
    fireEvent.keyDown(input, { key: "Escape" }) // Escape reverts the field…
    expect(focusTitleButton(container).textContent).toBe("B")
    fireEvent.keyDown(focusTitleButton(container), { key: "Enter" })
    fireEvent.change(focusTitleInput(container)!, { target: { value: "Bee" } })
    fireEvent.blur(focusTitleInput(container)!) // …blur commits it.
    expect(serializedLines(getByTestId)).toEqual(["A", "# Bee", "  # C", "    D", "  E", "F"])
    // Undo (from the rows) takes the rename back.
    fireEvent.keyDown(focusTitleButton(container), { key: "ArrowDown" })
    fireEvent.keyDown(root, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "# B", "  # C", "    D", "  E", "F"])
  })

  it("the breadcrumb follows the path taken; Shift+F pops back along it", () => {
    const { container, queryByText } = render(<Harness initial={FOCUS_TREE} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: "f" }) // focus B — B leads the view, selected
    fireEvent.keyDown(root, { key: "ArrowDown" }) // B → C
    fireEvent.keyDown(root, { key: "f" }) // focus C
    expect(queryByText("E")).toBeNull()
    // Crumbs are the hops taken: Note › B, with C current.
    expect(crumb(container)?.textContent).toBe("Note›B›C")
    // Pop follows the path back up: first to B…
    fireEvent.keyDown(root, { key: "F", shiftKey: true })
    expect(queryByText("E")).not.toBeNull()
    expect(queryByText("A")).toBeNull()
    expect(highlightedText(container)).toBe("C")
    expect(crumb(container)?.textContent).toBe("Note›B")
    // …then out entirely.
    fireEvent.keyDown(root, { key: "F", shiftKey: true })
    expect(queryByText("A")).not.toBeNull()
    expect(crumb(container)).toBeNull()
  })

  it("F focuses the selected block; Shift+F focuses back out to it", () => {
    const { container, queryByText } = render(<Harness initial={FOCUS_TREE} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: "f" })
    expect(queryByText("A")).toBeNull()
    expect(crumb(container)).not.toBeNull()
    expect(highlightedText(container)).toBe("B") // the focused block leads the view
    fireEvent.keyDown(root, { key: "F", shiftKey: true })
    // Fully out (B was root-level): whole page again, selection lands on the
    // block we stepped back FROM.
    expect(queryByText("A")).not.toBeNull()
    expect(crumb(container)).toBeNull()
    expect(highlightedText(container)).toBe("B")
  })

  it("Shift+F from a deep-linked focus exits fully (the path back is unknown)", () => {
    const { container, queryByText } = render(<Harness initial={FOCUS_TREE} focusRootId="blk_c" />)
    const root = editorRoot(container)
    expect(queryByText("E")).toBeNull() // C's view: title C + child D
    fireEvent.keyDown(root, { key: "F", shiftKey: true })
    // No stack below the deep link — pop leaves focus entirely.
    expect(queryByText("A")).not.toBeNull()
    expect(crumb(container)).toBeNull()
    expect(highlightedText(container)).toBe("C")
  })

  it("a focused heading reads as the title — only its text, at the title's scale", () => {
    // The focused heading is the page: its `#` belongs to its row in the
    // outline, not to the title (no row here draws it).
    const heading = ["# Section", "  id:: blk_h", "  - child", "    id:: blk_hc"].join("\n")
    const { container, queryAllByTestId, getAllByTestId } = render(
      <Harness initial={heading} focusRootId="blk_h" />,
    )
    expect(queryAllByTestId("heading-hash")).toHaveLength(0)
    expect(getAllByTestId("block-body").map((el) => el.textContent)).toEqual(["child"])
    const title = container.querySelector("h1")!
    expect(title.textContent).toBe("#Section")
    expect(title.className).toContain("text-3xl")
    expect(title.className).not.toContain("text-text-secondary")
  })

  it("every other type keeps its own row and marker, with no title above it", () => {
    // A quote, a to-do, a code block: content, not a name. Each leads its own
    // view as the first row, drawn exactly as it is anywhere else.
    const quote = ["> Wise words", "  id:: blk_q", "  - child", "    id:: blk_qc"].join("\n")
    const focusQuote = render(<Harness initial={quote} focusRootId="blk_q" />)
    expect(focusQuote.container.querySelector("h1")).toBeNull()
    expect(focusQuote.getAllByTestId("block-body").map((el) => el.textContent)).toEqual([
      "Wise words",
      "child",
    ])
    focusQuote.unmount()

    const code = ["```", "let x = 1", "let y = 2", "```", "  id:: blk_code", "  - child"].join("\n")
    const focusCode = render(<Harness initial={code} focusRootId="blk_code" />)
    expect(focusCode.container.querySelector("h1")).toBeNull()
    // The code block is still a code block — its text is not flattened into a
    // one-line title it could not be edited in.
    expect(focusCode.container.textContent).toContain("let y = 2")
  })

  it("a heading whose text is more than one line has a read-only title", () => {
    // The title is one plain line, as the note's is: a heading carrying a line
    // break shows as the title but is edited in its own row, outside focus.
    const parsed = parse(["# Head", "  id:: blk_h", "  - child", "    id:: blk_hc"].join("\n"))
    const doc = {
      ...parsed,
      blocks: {
        ...parsed.blocks,
        blk_h: { ...parsed.blocks.blk_h, text: "Head\nand more" },
      },
    }
    const { container } = render(<BlockEditor doc={doc} onChange={() => {}} focusRootId="blk_h" />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowUp" })
    expect(document.activeElement).toBe(focusTitleButton(container))
    fireEvent.keyDown(focusTitleButton(container), { key: "Enter" })
    expect(focusTitleInput(container)).toBeNull()
    expect(focusTitleButton(container).className).toContain("cursor-default")
  })

  it("Mod+Enter on the highlighted focus title creates its FIRST child", () => {
    const { container, getByTestId } = render(
      <Harness initial={FOCUS_TREE_H} focusRootId="blk_b" />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowUp" }) // C → title B
    expect(highlightedText(container)).toBe("B")
    fireEvent.keyDown(focusTitleButton(container), { key: "Enter", metaKey: true })
    const textarea = container.querySelector("textarea")!
    expect(textarea).not.toBeNull()
    fireEvent.change(textarea, { target: { value: "hello" } })
    expect(serializedLines(getByTestId)).toEqual([
      "A",
      "# B",
      "  - hello",
      "  # C",
      "    D",
      "  E",
      "F",
    ])
  })

  it("↑ at the top of the focused view goes to the focus title, never the note title", () => {
    const onExitTop = vi.fn()
    const { container } = render(
      <BlockEditor
        doc={withStarter(parse(FOCUS_TREE_H))}
        onChange={() => {}}
        focusRootId="blk_b"
        onExitTop={onExitTop}
      />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowUp" }) // C → the focus title
    expect(highlightedText(container)).toBe("B")
    expect(onExitTop).not.toHaveBeenCalled()
  })

  it("↑ on the leading row of an untitled focus keeps the highlight where it is", () => {
    // Nothing above the rows to hand the keyboard to — the page's own title is
    // hidden while focused, and there is no focus title — so the top row keeps
    // it rather than the highlight falling away.
    const { container } = render(
      <BlockEditor doc={withStarter(parse(FOCUS_TREE))} onChange={() => {}} focusRootId="blk_b" />,
    )
    const root = editorRoot(container)
    expect(highlightedText(container)).toBe("B")
    fireEvent.keyDown(root, { key: "ArrowUp" })
    expect(highlightedText(container)).toBe("B")
  })

  it("clamps the Cmd+A ladder at the focused subtree", () => {
    const { container } = render(<Harness initial={FOCUS_TREE_H} focusRootId="blk_b" />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // C → D
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["C", "D"])
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    // The "page" rung is the focused subtree — the rows — nothing beyond.
    expect(highlightedAll(container)).toEqual(["C", "D", "E"])
    fireEvent.keyDown(root, { key: "a", metaKey: true })
    expect(highlightedAll(container)).toEqual(["C", "D", "E"])
    // Delete on the page rung empties the view; the title takes the keyboard.
    fireEvent.keyDown(root, { key: "Backspace" })
    expect(highlightedText(container)).toBe("B")
  })

  it("keeps the title when the last child is deleted, and refuses to delete it", () => {
    const { container, getByTestId } = render(
      <Harness initial={FOCUS_TREE_H} focusRootId="blk_c" />,
    )
    const root = editorRoot(container)
    expect(highlightedText(container)).toBe("D")
    fireEvent.keyDown(root, { key: "Backspace" })
    // The title alone remains, selected.
    expect(highlightedText(container)).toBe("C")
    expect(serializedLines(getByTestId)).toEqual(["A", "# B", "  # C", "  E", "F"])
    // Deleting the title itself is refused.
    fireEvent.keyDown(root, { key: "Backspace" })
    expect(serializedLines(getByTestId)).toEqual(["A", "# B", "  # C", "  E", "F"])
  })

  it("refuses to delete the row an untitled focus leads with", async () => {
    // Removing it would take the view with it: leaves focus to delete it,
    // and say so rather than doing nothing.
    const { container, getByTestId } = render(
      <>
        <Harness initial={FOCUS_TREE} focusRootId="blk_c" />
        <Toaster />
      </>,
    )
    const root = editorRoot(container)
    expect(highlightedText(container)).toBe("C")
    await act(async () => {
      fireEvent.keyDown(root, { key: "Backspace" })
    })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "  C", "    D", "  E", "F"])
    expect(
      await screen.findByText("Leave focus to remove the block you're focused on"),
    ).not.toBeNull()
    toast.dismiss()
    // Its children go as they would anywhere.
    fireEvent.keyDown(root, { key: "ArrowDown" }) // C → D
    fireEvent.keyDown(root, { key: "Backspace" })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "  C", "  E", "F"])
    expect(highlightedText(container)).toBe("C")
  })

  it("exits gracefully when the focus root vanishes via undo", () => {
    const { container, queryByText } = render(<Harness initial={"A\nB"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true, altKey: true }) // duplicate A
    expect(highlightedText(container)).toBe("A") // the copy
    fireEvent.keyDown(root, { key: "f" }) // focus on the copy
    expect(crumb(container)).not.toBeNull()
    expect(queryByText("B")).toBeNull()
    fireEvent.keyDown(root, { key: "z", metaKey: true }) // undo removes the copy
    // The focused block no longer exists → back to the whole, unfocused note.
    expect(crumb(container)).toBeNull()
    expect(queryByText("B")).not.toBeNull()
  })

  it("breadcrumb crumbs navigate: an earlier hop re-focuses there, the note crumb exits", () => {
    const { container, getByText, queryByText } = render(<Harness initial={FOCUS_TREE} />)
    const root = editorRoot(container)
    // Walk the path by keyboard: B → C → D, so the stack is Note › B › C › D.
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: "f" }) // focus B — B leads the view
    fireEvent.keyDown(root, { key: "ArrowDown" }) // B → C
    fireEvent.keyDown(root, { key: "f" }) // focus C
    fireEvent.keyDown(root, { key: "ArrowDown" }) // C → D
    fireEvent.keyDown(root, { key: "f" }) // focus D
    expect(crumb(container)!.textContent!.replace(/\s+/g, "")).toBe("Note›B›C›D")
    fireEvent.click(getByText("B", { selector: "nav button" }))
    // Truncated back to the B hop: E visible, selection on the block we came
    // from, and the later hops are gone from the trail.
    expect(queryByText("E")).not.toBeNull()
    expect(queryByText("A")).toBeNull()
    expect(highlightedText(container)).toBe("D")
    expect(crumb(container)!.textContent!.replace(/\s+/g, "")).toBe("Note›B")
    fireEvent.click(getByText("Note", { selector: "nav button" }))
    expect(crumb(container)).toBeNull()
    expect(queryByText("A")).not.toBeNull()
  })
})

describe("heading hash marker", () => {
  // A font-size utility of the element's OWN (text-base, text-2xl, …) —
  // text-text-tertiary must not match: the hash inherits its size entirely.
  const OWN_SIZE = /(^|\s)text-(xs|sm|base|lg|xl|2xl|3xl)(\s|$)/

  const NESTED = ["# Top", "  id:: blk_h", "  # Nested", "    id:: blk_n"].join("\n")

  it("inherits the heading's scale from the slot instead of sizing itself", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const slots = Array.from(container.querySelectorAll('[data-testid="heading-hash"]'))
    expect(slots).toHaveLength(2)
    // The slot carries the depth scale + weight; the glyph inherits it.
    expect(slots[0].className).toContain("text-2xl") // depth 0
    expect(slots[1].className).toContain("text-xl") // depth 1
    for (const slot of slots) {
      expect(slot.className).toContain("font-bold")
      // Right-aligned in the shared 15px slot so a wide hash overflows left
      // toward the gutter instead of pushing the text column.
      expect(slot.className).toContain("justify-end")
      expect(slot.className).toContain("w-[15px]")
      const glyph = slot.querySelector("span:not([data-testid])")!
      expect(glyph.textContent).toBe("#")
      expect(glyph.className).toContain("text-text-tertiary")
      expect(glyph.className).not.toMatch(OWN_SIZE)
    }
  })

  it("is a static glyph, never a focus button, in every view", () => {
    // The hash reads as typography (like the note title's), not a control —
    // focus stays on F / Cmd+. and the edit bar. (A parent heading's slot
    // also hosts the collapse chevron; that is not a focus.)
    for (const readOnly of [false, true]) {
      const { container, unmount } = render(
        <BlockEditor doc={parse(NESTED)} onChange={() => {}} readOnly={readOnly} />,
      )
      const slot = container.querySelector('[data-testid="heading-hash"]')!
      expect(slot.querySelector('button[aria-label="Focus on block"]')).toBeNull()
      expect(slot.textContent).toBe("#")
      unmount()
    }
  })
})

describe("collapse toggle", () => {
  // One parent per marker family plus a leaf: the toggle SWAPS for the key
  // (dot, `#`, number, `>`), sits in a paragraph's empty slot, and sits
  // BESIDE a todo's checkbox (a control never swaps out); the guide line
  // hangs from the slot either way.
  const OUTLINE = [
    "- Bullet parent",
    "  id:: blk_bp",
    "  - child",
    "    id:: blk_bc",
    "# Heading parent",
    "  id:: blk_hp",
    "  - child",
    "    id:: blk_hc",
    "[ ] Todo parent",
    "  id:: blk_tp",
    "  - child",
    "    id:: blk_tc",
    "Paragraph parent",
    "  id:: blk_pp",
    "  - child",
    "    id:: blk_pc",
    "- Leaf",
    "  id:: blk_leaf",
  ].join("\n")

  const rowOf = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[data-block-row="${id}"]`)!
  const lineOf = (container: HTMLElement, id: string) =>
    rowOf(container, id).querySelector<HTMLElement>("[data-block-line]")!
  const toggleOf = (container: HTMLElement, id: string) =>
    lineOf(container, id).querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse"], button[aria-label="Expand"]',
    )
  /** The guide line hanging from a row's key: drawn by its children's rows
   * (the view is flat), keyed by the parent's occurrence. */
  const guideOf = (container: HTMLElement, id: string) => {
    const key = rowOf(container, id).dataset.occurrence
    return container.querySelector<HTMLElement>(`[data-guide="${key}"]`)
  }

  it("only parents carry a toggle; there is no separate gutter", () => {
    const { container } = render(<Harness initial={OUTLINE} />)
    for (const id of ["blk_bp", "blk_hp", "blk_tp", "blk_pp"]) {
      expect(toggleOf(container, id), id).not.toBeNull()
    }
    expect(toggleOf(container, "blk_leaf")).toBeNull()
    // Exactly one toggle per parent — the old always-rendered gutter button
    // (opacity-0 on leaves) is gone, so labels are unambiguous.
    expect(container.querySelectorAll('button[aria-label="Collapse"]')).toHaveLength(4)
  })

  it("a bullet parent's toggle shares the marker slot with the dot, which becomes the key", () => {
    const { container } = render(<Harness initial={OUTLINE} />)
    const toggle = toggleOf(container, "blk_bp")!
    const slot = toggle.parentElement!
    expect(slot.className).toContain("w-[15px]")
    expect(slot.className).toContain("relative")
    // The dot is the fading key; it is no longer a focus button.
    expect(slot.querySelector(".block-key")).not.toBeNull()
    expect(slot.querySelector('button[aria-label="Focus on block"]')).toBeNull()
    // Same for the heading's hash.
    const hashSlot = toggleOf(container, "blk_hp")!.parentElement!
    expect(hashSlot.getAttribute("data-testid")).toBe("heading-hash")
    expect(hashSlot.querySelector(".block-key")?.textContent).toBe("#")
  })

  it("a leaf's bullet is a static glyph too: no marker focuses on click", () => {
    // The dot used to be a focus button on leaves. A finger reaching for the
    // text kept landing on it, so the markers are all chrome now — focus
    // stays on F / Cmd+., the block menu and the edit bar.
    const { container } = render(<Harness initial={OUTLINE} />)
    const line = lineOf(container, "blk_leaf")
    expect(line.querySelector("button")).toBeNull()
    expect(line.querySelector(".block-glyph-fill")).not.toBeNull()
    expect(line.querySelector(".block-key")).toBeNull()
    expect(container.querySelector('button[aria-label="Focus on block"]')).toBeNull()
  })

  it("a todo parent keeps its checkbox in the slot and takes the chevron beside it", () => {
    const { container } = render(<Harness initial={OUTLINE} />)
    const line = lineOf(container, "blk_tp")
    const checkbox = line.querySelector('input[type="checkbox"]')!
    expect(checkbox).not.toBeNull()
    const slot = checkbox.parentElement!
    expect(slot.className).toContain("w-[15px]")
    // The checkbox slot never swaps (no key slot) and holds no button, but it
    // hints at the chevron beside it.
    expect(slot.className).not.toContain("block-toggle-slot")
    expect(slot.className).toContain("block-toggle-hint")
    expect(slot.querySelector("button")).toBeNull()
    // The chevron hugs the surface's edge from outside, with no hover surface,
    // and follows the slot in the DOM so the hint can reach it.
    const toggle = toggleOf(container, "blk_tp")!
    expect(toggle.parentElement!.className).toContain("-left-[15px]")
    expect(slot.nextElementSibling).toBe(toggle.parentElement)
    expect(toggle.className).toContain("enabled:hover:bg-transparent")
    // It folds on click and pins while collapsed.
    fireEvent.click(toggle)
    expect(container.querySelector('[data-block-row="blk_tc"]')).toBeNull()
    expect(toggleOf(container, "blk_tp")!.className).toContain("block-toggle-pinned")
  })

  it("a paragraph parent's slot is empty but keeps the column and hosts the chevron", () => {
    const { container } = render(<Harness initial={OUTLINE} />)
    const slot = toggleOf(container, "blk_pp")!.parentElement!
    expect(slot.getAttribute("data-testid")).toBe("paragraph-slot")
    expect(slot.className).toContain("w-[15px]")
    expect(slot.querySelector(".block-key")).toBeNull()
    // A quote keys on `>`; a leaf paragraph keeps the empty slot, no toggle.
    const { container: c2 } = render(
      <Harness initial={"A paragraph\n  id:: blk_p\n> A quote\n  id:: blk_q\n"} />,
    )
    expect(lineOf(c2, "blk_p").querySelector('[data-testid="paragraph-slot"]')?.textContent).toBe(
      "",
    )
    expect(lineOf(c2, "blk_q").querySelector('[data-testid="quote-glyph"]')?.textContent).toBe(">")
    expect(toggleOf(c2, "blk_p")).toBeNull()
  })

  it("clicking the toggle collapses and expands, pinning the chevron while collapsed", () => {
    const { container } = render(<Harness initial={OUTLINE} />)
    fireEvent.click(toggleOf(container, "blk_bp")!)
    expect(container.querySelector('[data-block-row="blk_bc"]')).toBeNull()
    const pinned = toggleOf(container, "blk_bp")!
    expect(pinned.getAttribute("aria-label")).toBe("Expand")
    expect(pinned.className).toContain("block-toggle-pinned")
    // The dot yields to the chevron for the duration.
    expect(pinned.parentElement!.querySelector(".block-key")!.className).toContain(
      "block-key-hidden",
    )
    fireEvent.click(pinned)
    expect(container.querySelector('[data-block-row="blk_bc"]')).not.toBeNull()
    expect(toggleOf(container, "blk_bp")!.className).not.toContain("block-toggle-pinned")
  })

  it("a fold keeps the hidden rows for the animation, inert, then lets them go", () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<Harness initial={OUTLINE} />)
      fireEvent.click(toggleOf(container, "blk_bp")!)
      // Gone as a row at once…
      expect(container.querySelector('[data-block-row="blk_bc"]')).toBeNull()
      // …but still on screen, as a ghost of its subtree's box: a clone out of
      // the flow, inert and hidden from assistive tech, its rows without
      // row identity or a subtree of their own.
      const boxes = container.querySelectorAll("[data-folding]")
      expect(boxes.length).toBe(1)
      const box = boxes[0]
      expect(box.getAttribute("aria-hidden")).toBe("true")
      expect(box.hasAttribute("inert")).toBe(true)
      expect(box.className).toContain("block-subtree-ghost")
      expect(box.getAttribute("data-subtree")).toBe("blk_bp")
      expect(box.querySelectorAll('[data-testid="block-body"]').length).toBeGreaterThan(0)
      expect(
        box.querySelectorAll("[data-occurrence], [data-block-row], [data-subtree]").length,
      ).toBe(0)
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(container.querySelectorAll("[data-folding]").length).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("unfolding again mid-fold drops the ghost at once, and the returning rows are live", () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<Harness initial={OUTLINE} />)
      fireEvent.click(toggleOf(container, "blk_bp")!)
      expect(container.querySelectorAll("[data-folding]").length).toBe(1)
      fireEvent.click(toggleOf(container, "blk_bp")!)
      expect(container.querySelectorAll("[data-folding]").length).toBe(0)
      const back = container.querySelector('[data-block-row="blk_bc"]')!
      expect(back).not.toBeNull()
      expect(back.closest('[data-subtree="blk_bp"]')).not.toBeNull()
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(container.querySelectorAll("[data-folding]").length).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("hangs the guide line from the key of every block type", () => {
    const { container } = render(<Harness initial={OUTLINE} />)
    // Under the 15px slot's centre — every block type has a key there — and
    // the children start one indent in.
    for (const id of ["blk_bp", "blk_hp", "blk_tp", "blk_pp"]) {
      const guide = guideOf(container, id)
      expect(guide, id).not.toBeNull()
      expect(guide!.style.left, id).toBe("11px")
      const child = guide!.closest<HTMLElement>("[data-block-row]")!
      expect(child.style.paddingLeft).toBe("24px")
    }
    expect(guideOf(container, "blk_leaf")).toBeNull()
  })

  it("a shared block is two rows, folded independently", () => {
    // Markdown cannot say "the same block twice" (a duplicate id:: is
    // re-minted on import); the graph can, so build the doc by hand.
    const shared: BlockDoc = {
      props: null,
      rootBlockIds: ["blk_p", "blk_q"],
      blocks: {
        blk_p: { id: "blk_p", type: "ul", text: "p", children: ["blk_s"] },
        blk_q: { id: "blk_q", type: "ul", text: "q", children: ["blk_s"] },
        blk_s: { id: "blk_s", type: "ul", text: "shared", children: ["blk_t"] },
        blk_t: { id: "blk_t", type: "ul", text: "t", children: [] },
      },
    }
    const { container } = render(<Harness initialDoc={shared} />)
    const rows = container.querySelectorAll('[data-block-row="blk_s"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].getAttribute("data-occurrence")).toBe("blk_p/blk_s")
    expect(rows[1].getAttribute("data-occurrence")).toBe("blk_q/blk_s")
    expect(container.querySelectorAll('[data-block-row="blk_t"]')).toHaveLength(2)
    // Fold the second occurrence only.
    fireEvent.click(rows[1].querySelector<HTMLButtonElement>('button[aria-label="Collapse"]')!)
    expect(container.querySelectorAll('[data-block-row="blk_t"]')).toHaveLength(1)
    expect(container.querySelector('[data-occurrence="blk_p/blk_s/blk_t"]')).not.toBeNull()
  })
})

describe("code blocks", () => {
  const CODE = [
    "```ts",
    "const a = 1",
    "  b()",
    "```",
    "  id:: blk_code",
    "- after",
    "  id:: blk_after",
  ].join("\n")

  it("renders verbatim in a mono panel around the line, with its language, no marker slot", () => {
    const { container } = render(<Harness initial={CODE} />)
    const body = container.querySelector<HTMLElement>('[data-block-id="blk_code"]')!
    expect(body.textContent).toBe("const a = 1\n  b()")
    expect(body.className).toContain("font-mono")
    expect(body.className).toContain("whitespace-pre-wrap")
    const row = container.querySelector('[data-block-row="blk_code"]')!
    // The panel WRAPS the line: the surface, border and padding are its, so
    // the body (and the textarea, below) stay chrome-free and the row's
    // height maths holds.
    const panel = row.querySelector<HTMLElement>('[data-testid="code-panel"]')!
    expect(panel).not.toBeNull()
    expect(panel.contains(body)).toBe(true)
    expect(panel.className).toContain("border")
    expect(body.className).not.toContain("border")
    expect(panel.querySelector('[data-testid="code-language"]')?.textContent).toBe("ts")
    // No marker slot: the panel starts where the row does, as a picture does.
    expect(row.querySelector('[data-testid="paragraph-slot"]')).toBeNull()
    expect(row.querySelector('[data-testid="code-slot"]')).toBeNull()
    expect(row.querySelector(".block-key")).toBeNull()
  })

  it("highlights the view for its language once the grammar has loaded", async () => {
    const { container } = render(<Harness initial={CODE} />)
    const body = container.querySelector<HTMLElement>('[data-block-id="blk_code"]')!
    await waitFor(() => expect(body.querySelector(".token.keyword")?.textContent).toBe("const"))
    // Tokens colour the text; they never change it.
    expect(body.textContent).toBe("const a = 1\n  b()")
    expect(body.closest('[data-testid="code-panel"]')?.className).toContain("prism")
  })

  it("stays plain for a language it has no grammar for", async () => {
    const plain = ["```klingon", "nuqneH", "```", "  id:: blk_code"].join("\n")
    const { container } = render(<Harness initial={plain} />)
    const body = container.querySelector<HTMLElement>('[data-block-id="blk_code"]')!
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(body.querySelector(".token")).toBeNull()
    expect(body.textContent).toBe("nuqneH")
  })

  it("gets the slot back for its chevron when it has rows under it", () => {
    const parent = ["```ts", "x", "```", "  id:: blk_code", "  - child", "    id:: blk_child"]
    const { container } = render(<Harness initial={parent.join("\n")} />)
    const row = container.querySelector('[data-block-row="blk_code"]')!
    expect(row.querySelector(".block-toggle")).not.toBeNull()
    expect(container.querySelector('[data-block-row="blk_child"]')).not.toBeNull()
  })

  it("Enter while editing stays in the block; Shift+Enter leaves with a block below", () => {
    const { container, getByTestId } = render(<Harness initial={CODE} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "Enter" }) // edit blk_code
    const textarea = container.querySelector("textarea")!
    expect(textarea.className).toContain("font-mono")
    // The textarea sits in the panel, chrome-free: the panel's padding and
    // border are the same around the view and the edit, so the swap never
    // moves a character or changes the block's height.
    expect(textarea.closest('[data-testid="code-panel"]')).not.toBeNull()
    expect(textarea.className).toContain("p-0")
    expect(textarea.className).toContain("border-none")
    // Enter is left to the textarea (a newline), so the doc is untouched.
    const enter = fireEvent.keyDown(textarea, { key: "Enter" })
    expect(enter).toBe(true)
    expect(serializedLines(getByTestId)).toEqual([
      "```ts",
      "const a = 1",
      "  b()",
      "```",
      "- after",
    ])
    expect(container.querySelectorAll("[data-block-row]")).toHaveLength(2)
    // Shift+Enter: a fresh (plain) block below, now being edited.
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })
    expect(container.querySelectorAll("[data-block-row]")).toHaveLength(3)
    expect(container.querySelector("textarea")?.className).not.toContain("font-mono")
  })

  it("typing a backtick and a space turns a block into a code block, keeping the keyboard", () => {
    const { container, getByTestId } = render(<Harness initial={"- a"} startEditing />)
    const textarea = container.querySelector("textarea")!
    fireEvent.change(textarea, { target: { value: "` a" } })
    expect(serializedLines(getByTestId)).toEqual(["```", "a", "```"])
    // The panel wraps the line, so this is a fresh textarea: it must have
    // taken the focus, with the caret where the marker left it.
    const after = container.querySelector<HTMLTextAreaElement>("textarea")!
    expect(after.className).toContain("font-mono")
    expect(document.activeElement).toBe(after)
    expect(after.selectionStart).toBe(after.value.length)
    // And back out again, the same way.
    fireEvent.change(after, { target: { value: "" } })
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "- " } })
    expect(serializedLines(getByTestId)).toEqual(["- "])
    const back = container.querySelector<HTMLTextAreaElement>("textarea")!
    expect(back.className).not.toContain("font-mono")
    expect(document.activeElement).toBe(back)
  })

  it("keeps code that begins with a marker as code, but a lone marker turns it back", () => {
    const { container, getByTestId } = render(<Harness initial={CODE} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "Enter" }) // edit blk_code
    const textarea = container.querySelector("textarea")!
    // A Python comment, a YAML list: code, not a heading or a bullet.
    fireEvent.change(textarea, { target: { value: "# a comment\nprint(1)" } })
    expect(serializedLines(getByTestId).slice(0, 2)).toEqual(["```ts", "# a comment"])
    fireEvent.change(textarea, { target: { value: "- item: 1" } })
    expect(serializedLines(getByTestId).slice(0, 2)).toEqual(["```ts", "- item: 1"])
    // Cleared, then `- ` on its own: a bullet again.
    fireEvent.change(textarea, { target: { value: "" } })
    fireEvent.change(textarea, { target: { value: "- " } })
    expect(serializedLines(getByTestId)).toEqual(["- ", "- after"])
  })

  it("` in select mode toggles a code block", () => {
    const { container, getByTestId } = render(<Harness initial={"- a\n  id:: blk_a"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "`" })
    expect(serializedLines(getByTestId)).toEqual(["```", "a", "```"])
    fireEvent.keyDown(root, { key: "`" })
    expect(serializedLines(getByTestId)).toEqual(["a"])
  })

  it("the language label is a field: click, type, Enter", () => {
    const { container, getByTestId } = render(<Harness initial={CODE} />)
    fireEvent.click(container.querySelector('[data-testid="code-language"]')!)
    const input = container.querySelector<HTMLInputElement>('[data-testid="code-language-input"]')!
    expect(input.value).toBe("ts")
    fireEvent.change(input, { target: { value: "py" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(serializedLines(getByTestId)[0]).toBe("```py")
    expect(container.querySelector('[data-testid="code-language"]')?.textContent).toBe("py")
    // Escape puts the old one back; clearing it drops the language.
    fireEvent.click(container.querySelector('[data-testid="code-language"]')!)
    fireEvent.change(container.querySelector('[data-testid="code-language-input"]')!, {
      target: { value: "rb" },
    })
    fireEvent.keyDown(container.querySelector('[data-testid="code-language-input"]')!, {
      key: "Escape",
    })
    expect(serializedLines(getByTestId)[0]).toBe("```py")
    fireEvent.click(container.querySelector('[data-testid="code-language"]')!)
    fireEvent.change(container.querySelector('[data-testid="code-language-input"]')!, {
      target: { value: "" },
    })
    fireEvent.blur(container.querySelector('[data-testid="code-language-input"]')!)
    expect(serializedLines(getByTestId)[0]).toBe("```")
  })

  it("typing ``` then Enter turns a block into a code block", () => {
    const { container, getByTestId } = render(<Harness initial={"- a"} startEditing />)
    const textarea = container.querySelector("textarea")!
    fireEvent.change(textarea, { target: { value: "```py" } })
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(serializedLines(getByTestId)).toEqual(["```py", "```"])
    expect(container.querySelector('[data-testid="code-language"]')?.textContent).toBe("py")
  })
})

describe("splitting a shared block", () => {
  it("refuses Enter mid-text on a block held in several places, but allows it at the end", async () => {
    const { container, getByTestId } = render(
      <>
        <Harness initial={"AB\nC"} parentCountOf={() => 2} startEditing />
        <Toaster />
      </>,
    )
    const textarea = container.querySelector("textarea")!
    // Caret between A and B: the split would cut the block's text everywhere.
    textarea.setSelectionRange(1, 1)
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter" })
    })
    expect(serializedLines(getByTestId)).toEqual(["AB", "C"])
    expect(
      await screen.findByText("This block is in 2 places, so it can't be split"),
    ).not.toBeNull()
    toast.dismiss()

    // Caret at the end: nothing comes off the text, so a block is added below.
    textarea.setSelectionRange(2, 2)
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(serializedLines(getByTestId)).toEqual(["AB", "- ", "C"])
  })
})

describe("rows of a shared block (selection by occurrence)", () => {
  /** `blk_s` hangs under both `blk_p` and `blk_q`: one block, two rows. */
  const shared = (): BlockDoc => ({
    props: null,
    rootBlockIds: ["blk_p", "blk_q"],
    blocks: {
      blk_p: { id: "blk_p", type: "ul", text: "p", children: ["blk_s"] },
      blk_q: { id: "blk_q", type: "ul", text: "q", children: ["blk_s", "blk_r"] },
      blk_s: { id: "blk_s", type: "ul", text: "shared", children: ["blk_t"] },
      blk_t: { id: "blk_t", type: "ul", text: "t", children: [] },
      blk_r: { id: "blk_r", type: "ul", text: "r", children: [] },
    },
  })
  const rowByKey = (container: HTMLElement, key: string) =>
    container.querySelector<HTMLElement>(`[data-occurrence="${key}"]`)!
  const bodyOf = (row: HTMLElement) => row.querySelector<HTMLElement>('[data-testid="block-body"]')!

  it("selects one row, not every row of the block", () => {
    const { container } = render(<Harness initialDoc={shared()} />)
    fireEvent.click(bodyOf(rowByKey(container, "blk_q/blk_s")))
    const lit = container.querySelectorAll(".bg-bg-secondary")
    expect(lit).toHaveLength(1)
    expect(lit[0].closest("[data-occurrence]")!.getAttribute("data-occurrence")).toBe("blk_q/blk_s")
    // Arrow-down walks the rows in view order: the shared block's child under q.
    fireEvent.keyDown(editorRoot(container), { key: "ArrowDown" })
    expect(
      container
        .querySelector(".bg-bg-secondary")!
        .closest("[data-occurrence]")!
        .getAttribute("data-occurrence"),
    ).toBe("blk_q/blk_s/blk_t")
  })

  it("edits one row: the other row of the same block stays a view", () => {
    const { container } = render(<Harness initialDoc={shared()} />)
    fireEvent.doubleClick(bodyOf(rowByKey(container, "blk_q/blk_s")))
    expect(container.querySelectorAll("textarea")).toHaveLength(1)
    expect(rowByKey(container, "blk_q/blk_s").querySelector("textarea")).not.toBeNull()
    expect(rowByKey(container, "blk_p/blk_s").querySelector("textarea")).toBeNull()
    // Typing changes the block: both rows show the new text.
    const textarea = container.querySelector("textarea")!
    fireEvent.change(textarea, { target: { value: "shared!" } })
    expect(bodyOf(rowByKey(container, "blk_p/blk_s")).textContent).toBe("shared!")
  })

  it("deletes the row under q and keeps the block under p", () => {
    const { container, getByTestId } = render(<Harness initialDoc={shared()} />)
    fireEvent.click(bodyOf(rowByKey(container, "blk_q/blk_s")))
    fireEvent.keyDown(editorRoot(container), { key: "Backspace" })
    expect(serializedLines(getByTestId)).toEqual(["- p", "  - shared", "    - t", "- q", "  - r"])
    // The selection lands on the row that slid into the deleted one's place.
    expect(highlightedText(container)).toBe("r")
  })

  it("indents the row under q beside its own siblings; p's row is untouched", () => {
    const { container, getByTestId } = render(<Harness initialDoc={shared()} />)
    // Move r above s under q so s has a previous sibling to nest under.
    fireEvent.click(bodyOf(rowByKey(container, "blk_q/blk_r")))
    fireEvent.keyDown(editorRoot(container), { key: "ArrowUp", altKey: true })
    fireEvent.click(bodyOf(rowByKey(container, "blk_q/blk_s")))
    fireEvent.keyDown(editorRoot(container), { key: "Tab" })
    expect(serializedLines(getByTestId)).toEqual([
      "- p",
      "  - shared",
      "    - t",
      "- q",
      "  - r",
      "    - shared",
      "      - t",
    ])
    // The highlight followed the row to its new place.
    expect(
      container
        .querySelector(".bg-bg-secondary")!
        .closest("[data-occurrence]")!
        .getAttribute("data-occurrence"),
    ).toBe("blk_q/blk_r/blk_s")
  })
})

describe("undo and what it discards", () => {
  it("undoing a duplicate hands the save the copies to discard, not to strand", () => {
    const hints: (ChangeHint | undefined)[] = []
    const { container, getByTestId } = render(
      <Harness initial={"A\nB"} onHint={(h) => hints.push(h)} />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true, altKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "A", "B"])
    const ids = getByTestId("serialized").textContent!.match(/id:: (\S+)/g)!
    const copy = ids[1].replace("id:: ", "")
    fireEvent.keyDown(root, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B"])
    // The duplicate's copy was new to the graph, so the undo names it and
    // nothing else.
    expect(hints).toEqual([undefined, { discard: [copy] }])
  })

  it("a block the graph already knew (linked in, not made) is never discarded by undo", () => {
    const hints: (ChangeHint | undefined)[] = []
    const { container, getByTestId } = render(
      <Harness initial={"A\nB"} onHint={(h) => hints.push(h)} knownBlock={() => true} />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true, altKey: true })
    fireEvent.keyDown(root, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B"])
    expect(hints).toEqual([undefined, undefined])
  })

  it("undoing the removal of a block the graph knew names nothing to discard", () => {
    const hints: (ChangeHint | undefined)[] = []
    const { container, getByTestId } = render(
      <Harness initial={"A\nB"} onHint={(h) => hints.push(h)} />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "Backspace" })
    expect(serializedLines(getByTestId)).toEqual(["B"])
    fireEvent.keyDown(root, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B"])
    expect(hints).toEqual([undefined, undefined])
  })

  it("⌘Z reaches the editor last focused from anywhere on the page that is not editable", () => {
    const { container, getByTestId } = render(
      <>
        <Harness initial={"A\nB"} />
        <button type="button">elsewhere</button>
        <input aria-label="field" />
      </>,
    )
    const root = editorRoot(container)
    fireEvent.focus(root)
    fireEvent.keyDown(root, { key: "Backspace" })
    expect(serializedLines(getByTestId)).toEqual(["B"])
    // A key in a field is the field's own.
    const field = screen.getByLabelText("field")
    field.focus()
    fireEvent.keyDown(field, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["B"])
    // From a plain button, or nothing focused at all, it reaches the editor.
    const button = screen.getByText("elsewhere")
    button.focus()
    fireEvent.keyDown(button, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B"])
    fireEvent.keyDown(button, { key: "z", metaKey: true, shiftKey: true })
    expect(serializedLines(getByTestId)).toEqual(["B"])
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
    const highlighted = Array.from(container.querySelectorAll(".bg-bg-secondary")).map((el) =>
      lineBody(el),
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

describe("wasd tree navigation (select mode)", () => {
  // NESTED: A, B (> C (> D), E), F

  /** Texts of the blocks actually rendered (collapsed children are unmounted).
   * Scoped to block bodies so the harness's serialized <pre> doesn't match. */
  const renderedBlocks = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('[data-testid="block-body"]'))
      // Rows folding away linger for their animation; they are not rows.
      .filter((el) => !el.closest("[data-folding]"))
      .map((el) => el.textContent ?? "")
  it("w/s traverse siblings, skipping descendants, no-oping only at the tree's ends", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: "s" })
    expect(highlightedText(container)).toBe("F") // skipped C/D/E
    fireEvent.keyDown(root, { key: "s" }) // end of the document: no-op
    expect(highlightedText(container)).toBe("F")
    fireEvent.keyDown(root, { key: "w" })
    expect(highlightedText(container)).toBe("B")
    fireEvent.keyDown(root, { key: "w" })
    expect(highlightedText(container)).toBe("A")
    fireEvent.keyDown(root, { key: "w" }) // start of the document: no-op
    expect(highlightedText(container)).toBe("A")
  })

  it("w/s break out of a level at its ends and continue the traversal", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D — sole child of C, two levels deep
    // s at the last sibling: up the ancestor chain to the next block out.
    fireEvent.keyDown(root, { key: "s" })
    expect(highlightedText(container)).toBe("E") // C's next sibling
    fireEvent.keyDown(root, { key: "s" })
    expect(highlightedText(container)).toBe("F") // B's next sibling, one more out
    // w at the first sibling: out to the parent.
    selectNth(root, 0) // still F; walk back down to D
    fireEvent.keyDown(root, { key: "ArrowUp" }) // E
    fireEvent.keyDown(root, { key: "ArrowUp" }) // D
    expect(highlightedText(container)).toBe("D")
    fireEvent.keyDown(root, { key: "w" })
    expect(highlightedText(container)).toBe("C") // first sibling → parent
    fireEvent.keyDown(root, { key: "w" })
    expect(highlightedText(container)).toBe("B") // C is B's first child → parent
  })

  it("a walks up to the parent and no-ops at the root", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D — two levels deep
    fireEvent.keyDown(root, { key: "a" })
    expect(highlightedText(container)).toBe("C")
    fireEvent.keyDown(root, { key: "a" })
    expect(highlightedText(container)).toBe("B")
    fireEvent.keyDown(root, { key: "a" }) // B is root-level: no-op
    expect(highlightedText(container)).toBe("B")
  })

  it("d steps into the first child, and no-ops on a leaf", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: "d" })
    expect(highlightedText(container)).toBe("C")
    fireEvent.keyDown(root, { key: "d" })
    expect(highlightedText(container)).toBe("D")
    fireEvent.keyDown(root, { key: "d" }) // D is a leaf: no-op
    expect(highlightedText(container)).toBe("D")
  })

  it("d auto-expands a collapsed block and selects its first child in one press", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: " " }) // collapse B — C/D/E leave the DOM
    expect(renderedBlocks(container)).not.toContain("C")
    fireEvent.keyDown(root, { key: "d" })
    // The subtree is rendered again (collapse state cleared)…
    expect(renderedBlocks(container)).toContain("C")
    expect(renderedBlocks(container)).toContain("D")
    // …and the first child is the highlighted block.
    expect(highlightedText(container)).toBe("C")
    // The expansion was a real state change, not a transient: collapsing again
    // still works from the parent (round-trip through `a`).
    fireEvent.keyDown(root, { key: "a" })
    fireEvent.keyDown(root, { key: " " })
    expect(renderedBlocks(container)).not.toContain("C")
  })

  it("leaves modified w/a/s/d to the browser (e.g. ⌘W)", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    const event = new KeyboardEvent("keydown", { key: "w", metaKey: true, cancelable: true })
    root.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(highlightedText(container)).toBe("B")
  })
})

describe("arrow-key folding (select mode)", () => {
  // NESTED: A, B (> C (> D), E), F

  const renderedBlocks = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('[data-testid="block-body"]'))
      // Rows folding away linger for their animation; they are not rows.
      .filter((el) => !el.closest("[data-folding]"))
      .map((el) => el.textContent ?? "")

  it("← collapses (children unmount), → expands, → again steps into the first child", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: "ArrowLeft" }) // collapse B
    expect(renderedBlocks(container)).not.toContain("C")
    expect(highlightedText(container)).toBe("B") // stayed put
    fireEvent.keyDown(root, { key: "ArrowRight" }) // expand B
    expect(renderedBlocks(container)).toContain("C")
    expect(highlightedText(container)).toBe("B") // still put
    fireEvent.keyDown(root, { key: "ArrowRight" }) // step into the first child
    expect(highlightedText(container)).toBe("C")
    // The collapse/expand were real state changes: Space still round-trips.
    fireEvent.keyDown(root, { key: "a" })
    fireEvent.keyDown(root, { key: " " })
    expect(renderedBlocks(container)).not.toContain("C")
  })

  it("← on a leaf steps out to the parent; root-level leaf no-ops", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 3) // D — a leaf two levels deep
    fireEvent.keyDown(root, { key: "ArrowLeft" }) // leaf → parent
    expect(highlightedText(container)).toBe("C")
    fireEvent.keyDown(root, { key: "ArrowLeft" }) // expanded → collapse
    expect(renderedBlocks(container)).not.toContain("D")
    expect(highlightedText(container)).toBe("C")
    fireEvent.keyDown(root, { key: "ArrowLeft" }) // collapsed → parent
    expect(highlightedText(container)).toBe("B")
    selectNth(root, 0) // still B; walk up to A
    fireEvent.keyDown(root, { key: "ArrowUp" })
    expect(highlightedText(container)).toBe("A")
    fireEvent.keyDown(root, { key: "ArrowLeft" }) // root-level leaf: no-op
    expect(highlightedText(container)).toBe("A")
    fireEvent.keyDown(root, { key: "ArrowRight" }) // leaf: no-op
    expect(highlightedText(container)).toBe("A")
  })

  it("Shift+Arrow multi-select and modified ←/→ are untouched", () => {
    const { container } = render(<Harness initial={NESTED} />)
    const root = editorRoot(container)
    selectNth(root, 0) // A
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true }) // extend A+B
    expect(highlightedAll(container)).toEqual(["A", "B"])
    // Shift+ArrowLeft has no binding: not consumed, selection intact.
    const event = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      shiftKey: true,
      cancelable: true,
    })
    root.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(highlightedAll(container)).toEqual(["A", "B"])
  })
})

describe("turn into (select-mode marker keys)", () => {
  it("# turns a block into a heading, again strips back, and undo restores it", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    const root = editorRoot(container)
    expect(highlightedText(container)).toBe("A")
    fireEvent.keyDown(root, { key: "#", shiftKey: true }) // shifted spelling
    expect(serializedLines(getByTestId)).toEqual(["# A", "B"])
    // No textarea opened — the block had content, so we stay selected.
    expect(container.querySelector("textarea")).toBeNull()
    expect(highlightedText(container)).toBe("A")
    fireEvent.keyDown(root, { key: "#" }) // toggle off
    expect(serializedLines(getByTestId)).toEqual(["A", "B"])
    // One undo step per press: undo restores the heading, then the paragraph.
    fireEvent.keyDown(root, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["# A", "B"])
    fireEvent.keyDown(root, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B"])
  })

  it("swaps between types without touching content or children", () => {
    const { container, getByTestId } = render(<Harness initial={"- P\n  - child"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: ">" })
    expect(serializedLines(getByTestId)).toEqual(["> P", "  - child"])
    fireEvent.keyDown(root, { key: "1" })
    expect(serializedLines(getByTestId)).toEqual(["1. P", "  - child"])
  })

  it("[ makes a todo; x still toggles its checkbox; [ strips even when checked", () => {
    const { container, getByTestId } = render(<Harness initial={"task"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "[" })
    expect(serializedLines(getByTestId)).toEqual(["[ ] task"])
    fireEvent.keyDown(root, { key: "x" })
    expect(serializedLines(getByTestId)).toEqual(["[x] task"])
    fireEvent.keyDown(root, { key: "[" })
    expect(serializedLines(getByTestId)).toEqual(["task"])
  })

  it("on an empty block the marker applies AND editing opens", () => {
    const { container, getByTestId } = render(<Harness initial={""} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "-" })
    expect(getByTestId("serialized").textContent).toContain("- ")
    const textarea = container.querySelector("textarea")
    expect(textarea).not.toBeNull()
    expect(textarea!.value).toBe("") // the marker is styling, not body text
  })

  it("turns a multi-selection into the type, one undo step for the group", () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true }) // A+B
    fireEvent.keyDown(root, { key: "#" })
    expect(serializedLines(getByTestId)).toEqual(["# A", "# B", "C"])
    // The selection survives, so pressing again toggles the group back.
    fireEvent.keyDown(root, { key: "#" })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "C"])
    fireEvent.keyDown(root, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["# A", "# B", "C"])
    fireEvent.keyDown(root, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "C"])
  })
})

describe("keyboard ownership (inactive-selection dimming)", () => {
  /** Flush the rAF the editor uses to settle keyboard ownership after blur. */
  const settleFocus = () =>
    act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

  it("demotes the selection while focus is outside the editor, restores on return", async () => {
    const { container } = render(
      <>
        <Harness initial={"A\nB"} />
        <input data-testid="outside" />
      </>,
    )
    const root = editorRoot(container)
    // The editor grabbed focus on mount — the highlight is active (accent).
    expect(document.activeElement).toBe(root)
    expect(container.querySelector(".block-highlight")).not.toBeNull()
    expect(container.querySelector(".block-highlight-inactive")).toBeNull()

    // Focus a real control elsewhere (relatedTarget set, so the editor's
    // blur-regrab leaves it alone): the highlight demotes…
    act(() => container.querySelector<HTMLInputElement>('[data-testid="outside"]')!.focus())
    await settleFocus()
    expect(container.querySelector(".block-highlight-inactive")).not.toBeNull()
    // …but the structural hooks stay: still selected, still .block-highlight.
    expect(container.querySelector(".bg-bg-secondary")).not.toBeNull()
    expect(container.querySelector(".block-highlight")).not.toBeNull()

    // Focus returning restores the active surface instantly (no rAF needed).
    act(() => root.focus())
    expect(container.querySelector(".block-highlight-inactive")).toBeNull()
  })

  it("demotes on a click on blank space and restores on the next key press", async () => {
    const { container } = render(
      <>
        <Harness initial={"A\nB"} />
        <div data-testid="blank" />
      </>,
    )
    const root = editorRoot(container)
    expect(document.activeElement).toBe(root)
    expect(container.querySelector(".block-highlight-inactive")).toBeNull()

    // Pointer-down on nothing in particular (neither a row nor a control):
    // the selection demotes even though the editor keeps the keyboard.
    fireEvent.pointerDown(container.querySelector('[data-testid="blank"]')!)
    await settleFocus()
    expect(document.activeElement).toBe(root)
    expect(container.querySelector(".block-highlight-inactive")).not.toBeNull()
    expect(container.querySelector(".block-highlight")).not.toBeNull()

    // A bare modifier is not "using the keyboard"; an arrow key is, and the
    // arrow still moves the selection.
    fireEvent.keyDown(root, { key: "Shift" })
    expect(container.querySelector(".block-highlight-inactive")).not.toBeNull()
    fireEvent.keyDown(root, { key: "ArrowDown" })
    expect(container.querySelector(".block-highlight-inactive")).toBeNull()
    expect(container.querySelector(".block-highlight")!.textContent).toContain("B")

    // A click on a row is a deliberate selection: active straight away.
    fireEvent.pointerDown(container.querySelector('[data-testid="blank"]')!)
    expect(container.querySelector(".block-highlight-inactive")).not.toBeNull()
    fireEvent.pointerDown(container.querySelector("[data-block-line]")!)
    expect(container.querySelector(".block-highlight-inactive")).toBeNull()
  })

  it("an arrow key on a focused button comes back to the editor and moves the selection", async () => {
    const { container } = render(
      <>
        <Harness initial={"A\nB\nC"} />
        <button data-testid="btn">Elsewhere</button>
        <input data-testid="field" />
      </>,
    )
    const root = editorRoot(container)
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="btn"]')!
    expect(container.querySelector(".block-highlight")!.textContent).toContain("A")

    // Focus a button (as a click would): the selection demotes…
    act(() => btn.focus())
    await settleFocus()
    expect(document.activeElement).toBe(btn)
    expect(container.querySelector(".block-highlight-inactive")).not.toBeNull()

    // …and ArrowDown pressed there refocuses the editor and moves A → B in
    // the same keystroke, active again.
    fireEvent.keyDown(btn, { key: "ArrowDown" })
    expect(document.activeElement).toBe(root)
    expect(container.querySelector(".block-highlight")!.textContent).toContain("B")
    expect(container.querySelector(".block-highlight-inactive")).toBeNull()

    // Shift+ArrowDown from a button extends the run the same way.
    act(() => btn.focus())
    fireEvent.keyDown(btn, { key: "ArrowDown", shiftKey: true })
    expect(document.activeElement).toBe(root)
    expect(container.querySelectorAll(".block-highlight").length).toBe(2)

    // A text field keeps its arrows: nothing moves, focus stays put.
    const field = container.querySelector<HTMLInputElement>('[data-testid="field"]')!
    act(() => field.focus())
    fireEvent.keyDown(field, { key: "ArrowUp" })
    expect(document.activeElement).toBe(field)
    expect(container.querySelectorAll(".block-highlight").length).toBe(2)
  })

  it("stays active across internal focus moves (select → edit → select)", async () => {
    const { container } = render(<Harness initial={"A\nB"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "Enter" }) // edit A — focus moves to the textarea
    expect(container.querySelector("textarea")).not.toBeNull()
    await settleFocus()
    expect(container.querySelector(".block-highlight-inactive")).toBeNull()
    fireEvent.keyDown(container.querySelector("textarea")!, { key: "Escape" }) // back to select
    await settleFocus()
    expect(container.querySelector(".block-highlight")).not.toBeNull()
    expect(container.querySelector(".block-highlight-inactive")).toBeNull()
  })
})

describe("brand placeholder (empty block being edited)", () => {
  const PLACEHOLDER = "Ruminate…"

  it("shows the ghost prompt on an empty editing textarea", () => {
    const { container } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("")
    expect(textarea.placeholder).toBe(PLACEHOLDER)
  })

  it("never puts the ghost on the focused title", () => {
    const { container } = render(
      <Harness initial={"# Parent\n  id:: blk_p\n  child"} focusRootId="blk_p" />,
    )
    const root = editorRoot(container)
    // Focus lands on the first child; ArrowUp selects the title, Enter edits
    // it — in the title's own field, which carries the title's prompt.
    fireEvent.keyDown(root, { key: "ArrowUp" })
    fireEvent.keyDown(container.querySelector<HTMLElement>('h1 [role="button"]')!, {
      key: "Enter",
    })
    const input = container.querySelector<HTMLInputElement>("h1 input")!
    expect(input.value).toBe("Parent")
    expect(input.placeholder).not.toBe(PLACEHOLDER)
  })
})

describe("developer debug readouts", () => {
  const initial = "- A\n  id:: blk_a000000000\n  - B\n    id:: blk_b000000000\n"

  it("renders no debug chrome unless asked", () => {
    const { queryAllByTestId } = render(<Harness initial={initial} />)
    expect(queryAllByTestId("block-debug-id")).toHaveLength(0)
    expect(queryAllByTestId("block-debug-meta")).toHaveLength(0)
  })

  it("shows every block's id beside it, in document order", () => {
    const { getAllByTestId } = render(<Harness initial={initial} debug={{ showIds: true }} />)
    expect(getAllByTestId("block-debug-id").map((el) => el.textContent)).toEqual([
      "blk_a000000000",
      "blk_b000000000",
    ])
    // The badge sits outside the block body, so the body's text is unchanged.
    expect(getAllByTestId("block-body").map((el) => el.textContent)).toEqual(["A", "B"])
  })

  it("shows type, depth, downstream count, and the notes upstream from the corpus lookup", () => {
    const upstreamOf = (id: string) =>
      id === "blk_a000000000" ? ["blk_note0000", "blk_note1111"] : []
    const { getAllByTestId } = render(
      <Harness initial={initial} debug={{ showMetadata: true, upstreamOf }} />,
    )
    const [metaA, metaB] = getAllByTestId("block-debug-meta").map((el) => el.textContent)
    expect(metaA).toContain("ul")
    expect(metaA).toContain("depth 0")
    expect(metaA).toContain("downstream 1")
    // A is reached from two notes: it is linked, and both are named upstream.
    expect(metaA).toContain("upstream 2 · blk_note0000, blk_note1111")
    expect(metaB).toContain("depth 1")
    expect(metaB).toContain("downstream 0")
    expect(metaB).toContain("upstream 0 · not saved yet")
  })

  it("omits the upstream line when no corpus lookup is wired", () => {
    const { getAllByTestId } = render(<Harness initial={initial} debug={{ showMetadata: true }} />)
    for (const el of getAllByTestId("block-debug-meta")) {
      expect(el.textContent).not.toContain("upstream")
    }
  })
})

describe("slash menu (edit mode)", () => {
  /** Today as the inserted `dd-mm-yyyy`. */
  const today = () => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`
  }

  function typeInto(textarea: HTMLTextAreaElement, value: string) {
    fireEvent.change(textarea, { target: { value } })
    // jsdom leaves the caret at the end after a value change, as a browser does.
    textarea.setSelectionRange(value.length, value.length)
  }

  it("typing / opens the menu with dates above block types", () => {
    const { container, queryByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    expect(queryByTestId("slash-menu")).toBeNull()
    typeInto(textarea, "/")
    const menu = queryByTestId("slash-menu")!
    expect(menu).not.toBeNull()
    const labels = Array.from(menu.querySelectorAll("[role=option]")).map((row) =>
      row.getAttribute("data-slash-item")!,
    )
    expect(labels[0]).toBe("date:Today")
    expect(labels).toContain("block:h1")
    expect(labels.indexOf("date:Today")).toBeLessThan(labels.indexOf("block:text"))
  })

  it("Enter on a date row replaces the /phrase with the date", () => {
    const { container, getByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    typeInto(textarea, "call mum /toda")
    expect(getByTestId("slash-menu").querySelectorAll("[role=option]")).toHaveLength(1)
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(container.querySelector("textarea")!.value).toBe(`call mum ${today()}`)
    expect(serializedLines(getByTestId)).toEqual([`call mum ${today()}`])
    // Still one block: Enter picked a row rather than splitting the block.
    expect(container.querySelectorAll("[data-block-row]")).toHaveLength(1)
  })

  it("arrows move the highlight and Enter picks the highlighted row", () => {
    const { container, getByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    typeInto(textarea, "/list")
    fireEvent.keyDown(textarea, { key: "ArrowDown" })
    const active = getByTestId("slash-menu").querySelector("[aria-selected=true]")!
    expect(active.getAttribute("data-slash-item")).toBe("block:ol")
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(serializedLines(getByTestId)).toEqual(["1. "])
  })

  it("a block-type row swaps the marker and keeps the surrounding text", () => {
    const { container, getByTestId } = render(<Harness initial="- plan" startEditing />)
    const textarea = container.querySelector("textarea")!
    typeInto(textarea, "plan /head")
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(serializedLines(getByTestId)).toEqual(["# plan "])
    expect(container.querySelector("textarea")!.value).toBe("plan ")
  })

  it("Escape closes the menu and leaves the text as typed", () => {
    const { container, queryByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    typeInto(textarea, "/tom")
    expect(queryByTestId("slash-menu")).not.toBeNull()
    fireEvent.keyDown(textarea, { key: "Escape" })
    expect(queryByTestId("slash-menu")).toBeNull()
    expect(container.querySelector("textarea")!.value).toBe("/tom")
    // Escape is consumed by the menu; the block is still being edited.
    expect(container.querySelector("textarea")).not.toBeNull()
    // Typing on keeps that slash dismissed.
    typeInto(textarea, "/tomo")
    expect(queryByTestId("slash-menu")).toBeNull()
  })

  it("a slash inside a word, or followed by a space, never opens the menu", () => {
    const { container, queryByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    typeInto(textarea, "and/or")
    expect(queryByTestId("slash-menu")).toBeNull()
    typeInto(textarea, "and/or / ")
    expect(queryByTestId("slash-menu")).toBeNull()
  })

  it("prose after the slash closes the menu", () => {
    const { container, queryByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    typeInto(textarea, "/meeting notes")
    expect(queryByTestId("slash-menu")).toBeNull()
  })

  it("a phrase that resolves to a date is offered as a row", () => {
    const { container, getByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    typeInto(textarea, "/in 3 days")
    const rows = getByTestId("slash-menu").querySelectorAll("[role=option]")
    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute("data-slash-item")).toBe("date:parsed")
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(container.querySelector("textarea")!.value).toMatch(/^\d{2}-\d{2}-\d{4}$/)
  })

  it("clicking a row picks it", () => {
    const { container, getByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    typeInto(textarea, "/quote")
    fireEvent.click(getByTestId("slash-menu").querySelector("[role=option]")!)
    expect(serializedLines(getByTestId)).toEqual(["> "])
  })

  it("undo after a pick puts the typed /phrase back", () => {
    const { container, getByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    typeInto(textarea, "/toda")
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(container.querySelector("textarea")!.value).toBe(today())
    fireEvent.keyDown(container.querySelector("textarea")!, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["/toda"])
  })
})

describe("BlockEditor context menu", () => {
  /** Right-click the row at `index` and return the opened menu. */
  async function openMenuOn(container: HTMLElement, index: number): Promise<HTMLElement> {
    const row = container.querySelectorAll("[data-occurrence]")[index]!
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    })
    return screen.getByTestId("block-context-menu")
  }

  async function pick(label: string) {
    await act(async () => {
      fireEvent.click(screen.getByText(label))
    })
  }

  it("opens on a touch press-and-hold, on the row under the finger", async () => {
    // A phone sends no `contextmenu`: the menu's trigger opens itself after a
    // 500ms hold and the editor resolves the row from the press.
    const { container, getByTestId } = render(
      <Harness initial={"A\nB\nC"} parentCountOf={() => 1} onDeleteEverywhere={() => {}} />,
    )
    const row = container.querySelectorAll("[data-occurrence]")[1]!
    const body = row.querySelector('[data-testid="block-body"]')!
    await act(async () => {
      fireEvent.touchStart(body, { touches: [{ clientX: 20, clientY: 20 }] })
      await new Promise((resolve) => setTimeout(resolve, 600))
    })
    const menu = await screen.findByTestId("block-context-menu")
    expect(menu.textContent).toContain("Unlink")
    expect(menu.textContent).toContain("Delete")
    expect(highlightedText(container)).toBe("B")
    // The finger lifts: that touchend is consumed, so iOS sends no click
    // onto whatever menu item now sits under the finger. Once only.
    const lifted = fireEvent.touchEnd(body, { changedTouches: [{ clientX: 20, clientY: 20 }] })
    expect(lifted).toBe(false)
    expect(fireEvent.touchEnd(body, { changedTouches: [{ clientX: 20, clientY: 20 }] })).toBe(true)
    await pick("Unlink")
    expect(serializedLines(getByTestId)).toEqual(["A", "C"])
  })

  it("adds a block to Views from its menu, as a view rooted at it, and removes it again", async () => {
    const { container } = render(<Harness initial={"A\nB"} noteId="n" />)
    let menu = await openMenuOn(container, 1)
    expect(menu.textContent).toContain("Add to Views")
    expect(menu.textContent).not.toContain("Remove from Views")
    await pick("Add to Views")
    // The block has a view row now, and nothing in the row itself says so:
    // the sidebar's list is where a view shows.
    const blockId = idsOf(container)[1]
    expect(getDefaultStore().get(viewRootIdsAtom).has(blockId)).toBe(true)
    expect(container.querySelector('[data-testid="block-pinned"]')).toBeNull()
    menu = await openMenuOn(container, 1)
    expect(menu.textContent).toContain("Remove from Views")
    await pick("Remove from Views")
    expect(getDefaultStore().get(viewRootIdsAtom).has(blockId)).toBe(false)
  })

  it("a read-only editor has no menu of its own, and draws its host's list when given one", async () => {
    // A read-only preview: a right-click is the browser's.
    const { container, unmount } = render(
      <BlockEditor doc={parse("A\nB")} onChange={() => {}} readOnly />,
    )
    await act(async () => {
      fireEvent.contextMenu(container.querySelectorAll("[data-occurrence]")[0]!, {
        clientX: 10,
        clientY: 10,
      })
    })
    expect(screen.queryByTestId("block-context-menu")).toBeNull()
    unmount()
    // A browsed list (the Views page): the host says what a row's menu holds.
    const onSelect = vi.fn()
    const { container: browsed } = render(
      <BlockEditor
        doc={parse("A\n  id:: blk_a\nB\n  id:: blk_b")}
        onChange={() => {}}
        readOnly
        onActivate={() => {}}
        menuEntries={(target) => [
          { kind: "item", label: `Host item for ${target.id}`, onSelect },
          { kind: "separator" },
          { kind: "item", label: "Greyed", disabled: true, onSelect },
        ]}
      />,
    )
    const menu = await openMenuOn(browsed, 1)
    expect(menu.textContent).toContain("Host item for blk_b")
    expect(menu.textContent).not.toContain("Delete")
    expect(
      screen.getByText("Greyed").closest('[role="menuitem"]')?.getAttribute("aria-disabled"),
    ).toBe("true")
    await pick("Host item for blk_b")
    expect(onSelect).toHaveBeenCalled()
  })

  it("offers Add to Views only where the rows are a note's own", async () => {
    // No note behind the editor (a clipboard fragment, Storybook): nothing
    // to list the block under, so no view to make.
    const { container } = render(<Harness initial={"A\nB"} />)
    const menu = await openMenuOn(container, 1)
    expect(menu.textContent).not.toContain("Views")
  })

  it("opens on a row with the standard actions, and selects that row", async () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const menu = await openMenuOn(container, 1)
    for (const label of ["Move up", "Move down", "Duplicate", "Copy", "Delete"]) {
      expect(menu.textContent).toContain(label)
    }
    // The row under the pointer becomes the selection (and the menu's target).
    expect(highlightedText(container)).toBe("B")
    // No graph behind this editor: removing the row is the delete, so Delete
    // alone, with nothing to unlink from.
    expect(menu.textContent).not.toContain("Unlink")
    expect(menu.textContent).not.toContain("places")
    // Nothing a click, the chevron or a key (the edit bar, on a phone)
    // already does.
    for (const label of ["Edit", "Indent", "Outdent", "Focus on", "Turn into", "Collapse"]) {
      expect(menu.textContent).not.toContain(label)
    }
  })

  it("runs in sections, ruled apart: copying first, removing last", async () => {
    /** The menu's items in order, "—" for each rule between sections. */
    const outline = (menu: HTMLElement) =>
      Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((el) =>
        el.getAttribute("role") === "separator" ? "—" : el.textContent!.replace(/[⌘⌥⇧↑↓⌫C]+$/, ""),
      )
    const { container } = render(<Harness initial={"A\nRead [the guide](https://e.com/g)"} />)
    // A plain row: no link or figure section, and no rule left for it.
    expect(outline(await openMenuOn(container, 0))).toEqual([
      "Copy",
      "—",
      "Move up",
      "Move down",
      "Duplicate",
      "—",
      "Delete",
    ])
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    })
    // A row with a link: its own section, between copying and arranging.
    expect(outline(await openMenuOn(container, 1))).toEqual([
      "Copy",
      "—",
      "Edit link",
      "Turn into link block",
      "—",
      "Move up",
      "Move down",
      "Duplicate",
      "—",
      "Delete",
    ])
  })

  it("Delete removes the row (an undoable edit)", async () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB\nC"} />)
    await openMenuOn(container, 1)
    await pick("Delete")
    expect(serializedLines(getByTestId)).toEqual(["A", "C"])
    fireEvent.keyDown(editorRoot(container), { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "C"])
  })

  it("in a note, a block held only here offers Unlink (the row) and Delete (the block)", async () => {
    const deleteEverywhere = vi.fn()
    const { container, getByTestId } = render(
      <Harness initial={"A\nB"} parentCountOf={() => 1} onDeleteEverywhere={deleteEverywhere} />,
    )
    const menu = await openMenuOn(container, 1)
    expect(menu.textContent).toContain("Unlink")
    expect(menu.textContent).toContain("Delete")
    // One place: no count to show.
    expect(menu.textContent).not.toContain("places")
    const id = getByTestId("serialized").textContent!.match(/id:: (\S+)\n?$/)![1]
    await pick("Delete")
    expect(deleteEverywhere).toHaveBeenCalledWith([id])
    expect(serializedLines(getByTestId)).toEqual(["A", "B"])
  })

  it("a block held in more than one place offers Unlink, and Delete reaches every place", async () => {
    const deleteEverywhere = vi.fn()
    const { container, getByTestId } = render(
      <Harness initial={"A\nB"} parentCountOf={() => 2} onDeleteEverywhere={deleteEverywhere} />,
    )
    const menu = await openMenuOn(container, 1)
    expect(menu.textContent).toContain("Unlink")
    expect(menu.textContent).toContain("Delete")
    expect(menu.textContent).toContain("2 places")
    const id = getByTestId("serialized").textContent!.match(/id:: (\S+)\n?$/)![1]
    await pick("Delete")
    expect(deleteEverywhere).toHaveBeenCalledWith([id])
    // The graph-level delete is the host's; the row is left for the snapshot
    // to drop, so nothing was removed by the editor itself.
    expect(serializedLines(getByTestId)).toEqual(["A", "B"])
  })

  it("Unlink drops only this row", async () => {
    const { container, getByTestId } = render(
      <Harness initial={"A\nB"} parentCountOf={() => 2} onDeleteEverywhere={() => {}} />,
    )
    await openMenuOn(container, 1)
    await pick("Unlink")
    expect(serializedLines(getByTestId)).toEqual(["A"])
  })

  it("does not open on the empty space below the rows", async () => {
    const { container } = render(<Harness initial={"A\nB"} />)
    await act(async () => {
      fireEvent.contextMenu(editorRoot(container), { clientX: 10, clientY: 500 })
    })
    expect(screen.queryByTestId("block-context-menu")).toBeNull()
  })

  it("leaves a right-click inside the block being typed in to the browser", async () => {
    // The browser's own menu on a textarea carries the spelling suggestions
    // for a marked word (and cut/copy/paste); the block's menu used to open
    // over it and cancel it. A right-click on the row outside its textarea
    // still opens the block's menu.
    const { container } = render(<Harness initial={"A\nB"} startEditing />)
    const textarea = container.querySelector("textarea")!
    let allowed = false
    await act(async () => {
      // `dispatchEvent` returns false when a handler cancelled the default.
      allowed = fireEvent.contextMenu(textarea, { clientX: 10, clientY: 10 })
    })
    expect(allowed).toBe(true)
    expect(screen.queryByTestId("block-context-menu")).toBeNull()
    // Still typing: the textarea kept focus and is the same one.
    expect(container.querySelector("textarea")).toBe(textarea)

    let cancelled = true
    await act(async () => {
      cancelled = !fireEvent.contextMenu(container.querySelectorAll("[data-occurrence]")[1]!, {
        clientX: 10,
        clientY: 10,
      })
    })
    expect(cancelled).toBe(true)
    expect(screen.getByTestId("block-context-menu").textContent).toContain("Duplicate")
    expect(highlightedText(container)).toBe("B")
  })
})

describe("BlockEditor images", () => {
  const pngFile = () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })
  /** A paste event carrying one image file (what a pasted screenshot is). */
  const imagePaste = (files: File[]) => ({
    clipboardData: { files, types: ["Files"], getData: () => "" },
  })
  const THUMBHASH = "YyUKNJh2d3eAiHh3iIeGcGgHdw=="
  const uploads = (id = "img_abcdefghijklmnop") =>
    vi.fn(async (): Promise<UploadedImage> => ({ id, width: 640, height: 480 }))

  // jsdom has no object URLs; the preview a pasted picture draws is one.
  beforeAll(() => {
    const url = URL as unknown as Record<string, unknown>
    url.createObjectURL = vi.fn(() => "blob:preview")
    url.revokeObjectURL = vi.fn()
  })

  it("draws a pasted picture at once, under a spinner, and stays one undo", async () => {
    let settle: (asset: UploadedImage) => void = () => {}
    const onImageUpload = vi.fn(
      () =>
        new Promise<UploadedImage>((resolve) => {
          settle = resolve
        }),
    )
    const { container, getByTestId, queryByTestId } = render(
      <Harness initial={"A\nB\nC"} onImageUpload={onImageUpload} />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight B
    await act(async () => {
      fireEvent.paste(root, imagePaste([pngFile()]))
    })

    // The row is already there, drawing the local file under a spinner — and
    // the block holds no asset id, so nothing provisional can reach the graph.
    const img = container.querySelector<HTMLImageElement>('[data-testid="block-image"]')!
    expect(img.src).toBe("blob:preview")
    expect(queryByTestId("block-image-uploading")).not.toBeNull()
    expect(getByTestId("serialized").textContent).not.toContain("img_")
    expect(serializedLines(getByTestId)).toHaveLength(4)

    await act(async () => {
      settle({ id: "img_abcdefghijklmnop", width: 640, height: 480, thumbhash: THUMBHASH })
    })
    expect(queryByTestId("block-image-uploading")).toBeNull()
    // The picture's size and likeness land with its id.
    expect(JSON.parse(getByTestId("image-props").textContent ?? "[]")).toEqual([
      { image: "img_abcdefghijklmnop", width: 640, height: 480, thumbhash: THUMBHASH },
    ])
    expect(serializedLines(getByTestId)).toEqual([
      "A",
      "B",
      "![](/api/images/img_abcdefghijklmnop)",
      "C",
    ])

    // Landing the upload is the same edit as making the row: one undo.
    fireEvent.keyDown(root, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "C"])
  })

  it("an image row has no marker slot, so the picture starts at the row's edge", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a"],
      blocks: {
        a: {
          id: "a",
          type: "image",
          text: "",
          props: { src: "https://example.com/sunset.png" },
          children: [],
        },
      },
    }
    const { container } = render(<Harness initialDoc={doc} />)
    expect(container.querySelector('[data-testid="block-image"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="paragraph-slot"]')).toBeNull()
  })

  it("a click on the empty space around a picture selects its row", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a", "b"],
      blocks: {
        a: { id: "a", type: "text", text: "A", children: [] },
        b: {
          id: "b",
          type: "image",
          text: "",
          props: { src: "https://example.com/sunset.png" },
          children: [],
        },
      },
    }
    const { container } = render(<Harness initialDoc={doc} />)
    expect(container.querySelector('.bg-bg-secondary [data-testid="block-image"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-testid="image-block"]')!)
    expect(container.querySelector('.bg-bg-secondary [data-testid="block-image"]')).not.toBeNull()
  })

  it("hangs no caption line under an uncaptioned picture", () => {
    const withCaption = (text: string): BlockDoc => ({
      props: null,
      rootBlockIds: ["a"],
      blocks: {
        a: {
          id: "a",
          type: "image",
          text,
          props: { src: "https://example.com/sunset.png" },
          children: [],
        },
      },
    })
    const bare = render(<Harness initialDoc={withCaption("")} />)
    expect(bare.container.querySelector('[data-testid="block-body"]')).toBeNull()
    bare.unmount()

    const captioned = render(<Harness initialDoc={withCaption("A sunset")} />)
    expect(captioned.container.querySelector('[data-testid="block-body"]')).not.toBeNull()
  })

  it("draws an image block as its picture with the caption beneath", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a"],
      blocks: {
        a: {
          id: "a",
          type: "image",
          text: "A sunset",
          props: { src: "https://example.com/sunset.png" },
          children: [],
        },
      },
    }
    const { container } = render(<Harness initialDoc={doc} />)
    const img = container.querySelector<HTMLImageElement>('[data-testid="block-image"]')!
    expect(img.alt).toBe("A sunset")
    expect(img.src).toBe("https://example.com/sunset.png")
    expect(container.querySelector('[data-testid="block-body"]')!.textContent).toBe("A sunset")
  })

  it("a pasted picture uploads and becomes an image block after the highlighted row", async () => {
    const onImageUpload = uploads()
    const { container, getByTestId } = render(
      <Harness initial={"A\nB\nC"} onImageUpload={onImageUpload} />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight B
    await act(async () => {
      fireEvent.paste(root, imagePaste([pngFile()]))
    })
    expect(onImageUpload).toHaveBeenCalledTimes(1)
    expect(serializedLines(getByTestId)).toEqual([
      "A",
      "B",
      "![](/api/images/img_abcdefghijklmnop)",
      "C",
    ])
    // The new row is highlighted, and the size measured at upload is kept.
    expect(
      container.querySelector('.bg-bg-secondary [data-testid="block-image"], .bg-bg-secondary'),
    ).not.toBeNull()
    expect(getByTestId("serialized").textContent).toContain("img_abcdefghijklmnop")
    // One structural step: undo removes the picture.
    fireEvent.keyDown(root, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "C"])
  })

  it("a picture pasted onto an empty line takes that line", async () => {
    const onImageUpload = uploads()
    // Markdown cannot express an empty block, so build the doc by hand.
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a", "blank", "c"],
      blocks: {
        a: { id: "a", type: "text", text: "A", children: [] },
        blank: { id: "blank", type: "text", text: "", children: [] },
        c: { id: "c", type: "text", text: "C", children: [] },
      },
    }
    const { container, getByTestId } = render(
      <Harness initialDoc={doc} onImageUpload={onImageUpload} />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown" }) // the blank row
    await act(async () => {
      fireEvent.paste(root, imagePaste([pngFile()]))
    })
    expect(serializedLines(getByTestId)).toEqual([
      "A",
      "![](/api/images/img_abcdefghijklmnop)",
      "C",
    ])
  })

  it("pasting a picture while editing puts it after the block being edited", async () => {
    const onImageUpload = uploads()
    const { container, getByTestId } = render(
      <Harness initial={"A\nB"} onImageUpload={onImageUpload} />,
    )
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "Enter" }) // edit A
    await act(async () => {
      fireEvent.paste(container.querySelector("textarea")!, imagePaste([pngFile()]))
    })
    expect(serializedLines(getByTestId)).toEqual([
      "A",
      "![](/api/images/img_abcdefghijklmnop)",
      "B",
    ])
  })

  it("without an upload handler (images off) an image paste changes nothing", async () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    await act(async () => {
      fireEvent.paste(editorRoot(container), imagePaste([pngFile()]))
    })
    expect(serializedLines(getByTestId)).toEqual(["A", "B"])
    expect(container.querySelector('[data-testid="image-input"]')).toBeNull()
  })

  it("a failed upload leaves the note as it was and says why in a toast", async () => {
    const onImageUpload = vi.fn(async () => {
      throw new ImageUploadError("too_large", "Images must be under 10 MB")
    })
    const { container, getByTestId } = render(
      <>
        <Harness initial={"A\nB"} onImageUpload={onImageUpload} />
        <Toaster />
      </>,
    )
    await act(async () => {
      fireEvent.paste(editorRoot(container), imagePaste([pngFile()]))
    })
    expect(serializedLines(getByTestId)).toEqual(["A", "B"])
    // Nothing is left under the editor; the message floats in a toast.
    expect(editorRoot(container).querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector("[data-sonner-toast]")?.textContent).toContain(
      "Images must be under 10 MB",
    )
    toast.dismiss()
  })

  it("the context menu on an image offers to open and download it, not to turn it into text", async () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a"],
      blocks: {
        a: {
          id: "a",
          type: "image",
          text: "",
          props: { src: "https://example.com/sunset.png" },
          children: [],
        },
      },
    }
    const { container } = render(<Harness initialDoc={doc} />)
    const row = container.querySelector("[data-occurrence]")!
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    })
    const menu = screen.getByTestId("block-context-menu")
    expect(menu.textContent).toContain("Open image")
    expect(menu.textContent).toContain("Download image")
    expect(menu.textContent).not.toContain("Turn into")
  })

  /** A doc of one image block with the given props. */
  const imageDoc = (props: Record<string, unknown>, text = ""): BlockDoc => ({
    props: null,
    rootBlockIds: ["a"],
    blocks: {
      a: { id: "a", type: "image", text, props, children: [] },
    },
  })
  const imageProps = (getByTestId: (id: string) => HTMLElement) =>
    JSON.parse(getByTestId("image-props").textContent ?? "[]") as unknown[]
  /** Give the figure and its row a laid-out width (jsdom has none). */
  const layOut = (container: HTMLElement, rowWidth: number, figureWidth: number) => {
    const figure = container.querySelector<HTMLElement>('[data-testid="image-figure"]')!
    const row = figure.parentElement!
    row.getBoundingClientRect = () => ({ width: rowWidth }) as DOMRect
    figure.getBoundingClientRect = () => ({ width: figureWidth }) as DOMRect
    return figure
  }
  const SRC = "https://example.com/sunset.png"

  it("lays a picture out by its props: the side it keeps to, its width, and its caption with it", () => {
    const { container, unmount } = render(
      <Harness initialDoc={imageDoc({ src: SRC, align: "right", size: 40 }, "A sunset")} />,
    )
    const figure = container.querySelector<HTMLElement>('[data-testid="image-figure"]')!
    expect(figure.dataset.align).toBe("right")
    expect(figure.className).toContain("self-end")
    expect(figure.style.width).toBe("40%")
    // The caption is inside the figure — as wide as the picture, wherever it
    // is — and set to the picture's side.
    const caption = figure.querySelector('[data-testid="block-body"]')!
    expect(caption.textContent).toBe("A sunset")
    expect(caption.className).toContain("text-right")

    // Left alone, a picture is its natural size, centred, its caption centred.
    unmount()
    const bare = render(<Harness initialDoc={imageDoc({ src: SRC }, "A sunset")} />)
    const plain = bare.container.querySelector<HTMLElement>('[data-testid="image-figure"]')!
    expect(plain.dataset.align).toBe("center")
    expect(plain.className).toContain("self-center")
    expect(plain.style.width).toBe("")
    expect(plain.querySelector('[data-testid="block-body"]')!.className).toContain("text-center")
  })

  it("reserves a picture's space from its pixel size, before its bytes arrive", () => {
    // At its natural size: the figure is as wide as the picture's pixels,
    // capped at the row and at what a screenful of height allows (20rem,
    // through the ratio), and the picture fills it at its own shape — so
    // the row is its final height before the picture has loaded.
    const natural = render(
      <Harness initialDoc={imageDoc({ src: SRC, width: 1200, height: 500 })} />,
    )
    const figure = natural.container.querySelector<HTMLElement>('[data-testid="image-figure"]')!
    expect(figure.style.width).toBe("min(1200px, 100%, 48rem)")
    const img = natural.container.querySelector<HTMLImageElement>('[data-testid="block-image"]')!
    expect(img.style.aspectRatio).toBe("1200 / 500")
    expect(img.className).toContain("w-full")
    natural.unmount()

    // A sized picture keeps its fraction of the row, at the same shape.
    const sized = render(
      <Harness initialDoc={imageDoc({ src: SRC, width: 1200, height: 500, size: 40 })} />,
    )
    expect(
      sized.container.querySelector<HTMLElement>('[data-testid="image-figure"]')!.style.width,
    ).toBe("40%")
    expect(
      sized.container.querySelector<HTMLImageElement>('[data-testid="block-image"]')!.style
        .aspectRatio,
    ).toBe("1200 / 500")
    sized.unmount()

    // An uploaded picture's placeholder, shown while its bytes are fetched,
    // is the same box, so the swap moves nothing.
    const fetched = render(
      <Harness
        initialDoc={imageDoc({ image: "img_abcdefghijklmnop", width: 1200, height: 500 })}
      />,
    )
    const placeholder = fetched.container.querySelector<HTMLElement>(
      '[data-testid="block-image-placeholder"]',
    )!
    expect(placeholder.style.aspectRatio).toBe("1200 / 500")
    expect(placeholder.className).toContain("w-full")
    expect(
      fetched.container.querySelector<HTMLElement>('[data-testid="image-figure"]')!.style.width,
    ).toBe("min(1200px, 100%, 48rem)")
    fetched.unmount()

    // A picture of unknown size (an external URL pasted as markdown) is laid
    // out as it loads, as before: natural width, capped by the row and by
    // a screenful of height.
    const bare = render(<Harness initialDoc={imageDoc({ src: SRC })} />)
    expect(
      bare.container.querySelector<HTMLElement>('[data-testid="image-figure"]')!.style.width,
    ).toBe("")
    const plain = bare.container.querySelector<HTMLImageElement>('[data-testid="block-image"]')!
    expect(plain.style.aspectRatio).toBe("")
    expect(plain.className).toContain("max-h-80")
    expect(plain.className).not.toMatch(/(^|\s)w-full(\s|$)/)
  })

  it("stands a picture's likeness in its place, and says so when it cannot be fetched", async () => {
    // No session in the harness: the picture can be neither read from the
    // device nor fetched — as it is offline.
    const { container, findByTestId } = render(
      <Harness
        initialDoc={imageDoc({
          // An id no other test has uploaded (and so primed the page's cache).
          image: "img_notonthisdevice",
          width: 1200,
          height: 500,
          thumbhash: "YyUKNJh2d3eAiHh3iIeGcGgHdw==",
        })}
      />,
    )
    const placeholder = container.querySelector<HTMLElement>(
      '[data-testid="block-image-placeholder"]',
    )!
    // The blurred likeness, in the picture's own box, and still.
    expect(placeholder.style.backgroundImage).toMatch(/^url\("data:image\/png;base64,/)
    expect(placeholder.style.aspectRatio).toBe("1200 / 500")
    expect(placeholder.className).not.toContain("animate-pulse")
    // It stays that box, with a badge, rather than turning into "unavailable".
    expect((await findByTestId("block-image-unreachable")).textContent).toMatch(/load|Offline/)
    expect(container.querySelector('[data-testid="block-image-missing"]')).toBeNull()
    expect(container.querySelector('[data-testid="block-image-placeholder"]')).toBe(placeholder)
  })

  it("the figure's toolbar sets the side the picture keeps to, as one undo step", () => {
    const { container, getByTestId } = render(<Harness initialDoc={imageDoc({ src: SRC })} />)
    // Centred: a handle at each side.
    expect(container.querySelector('[data-testid="image-resize-left"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="image-resize-right"]')).not.toBeNull()
    const toolbar = getByTestId("image-toolbar")
    const left = toolbar.querySelector<HTMLButtonElement>('[aria-label="Align left"]')!
    expect(toolbar.querySelector('[aria-label="Align centre"]')!.getAttribute("aria-pressed")).toBe(
      "true",
    )
    fireEvent.click(left)
    expect(imageProps(getByTestId)).toEqual([{ src: SRC, align: "left" }])
    expect(getByTestId("image-figure").dataset.align).toBe("left")
    expect(left.getAttribute("aria-pressed")).toBe("true")
    // Kept to the left, the handle against that side goes.
    expect(container.querySelector('[data-testid="image-resize-left"]')).toBeNull()
    expect(container.querySelector('[data-testid="image-resize-right"]')).not.toBeNull()
    // The picture's click (the lightbox) is not the button's.
    expect(screen.queryByTestId("image-lightbox")).toBeNull()

    // Back to centre is stored as nothing at all.
    fireEvent.click(toolbar.querySelector('[aria-label="Align centre"]')!)
    expect(imageProps(getByTestId)).toEqual([{ src: SRC }])

    // Each choice was one step.
    fireEvent.keyDown(editorRoot(container), { key: "z", metaKey: true })
    expect(imageProps(getByTestId)).toEqual([{ src: SRC, align: "left" }])
    fireEvent.keyDown(editorRoot(container), { key: "z", metaKey: true })
    expect(imageProps(getByTestId)).toEqual([{ src: SRC }])
  })

  it("dragging a handle resizes the picture as a fraction of the row, written when the pointer lets go", () => {
    const { container, getByTestId } = render(<Harness initialDoc={imageDoc({ src: SRC })} />)
    const figure = layOut(container, 600, 600)
    const handle = getByTestId("image-resize-right")
    fireEvent.pointerDown(handle, { clientX: 600, pointerId: 1 })
    // A centred picture grows from both sides: 150px of travel is 300px of
    // width, so the picture is now half the row — live, before the block
    // is written.
    fireEvent.pointerMove(window, { clientX: 450, pointerId: 1 })
    expect(figure.style.width).toBe("50%")
    expect(imageProps(getByTestId)).toEqual([{ src: SRC }])
    fireEvent.pointerUp(window, { clientX: 450, pointerId: 1 })
    expect(imageProps(getByTestId)).toEqual([{ src: SRC, size: 50 }])
    expect(figure.style.width).toBe("50%")

    // The whole drag was one undo step.
    fireEvent.keyDown(editorRoot(container), { key: "z", metaKey: true })
    expect(imageProps(getByTestId)).toEqual([{ src: SRC }])
  })

  it("a picture kept to a side grows away from it, never narrower than a tenth of the row, and snaps to the full row", () => {
    const { container, getByTestId } = render(
      <Harness initialDoc={imageDoc({ src: SRC, align: "left", size: 50 })} />,
    )
    layOut(container, 600, 300)
    // A picture kept to the left grows away from it: only the right edge
    // has a handle (one against the left would only fight the alignment).
    expect(container.querySelector('[data-testid="image-resize-left"]')).toBeNull()
    // Dragging the right handle moves only that edge: 60px is a tenth of
    // the row.
    fireEvent.pointerDown(getByTestId("image-resize-right"), { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 360, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 360, pointerId: 1 })
    expect(imageProps(getByTestId)).toEqual([{ src: SRC, align: "left", size: 60 }])

    // Dragged nearly to the row's edge, it snaps to the whole row…
    layOut(container, 600, 360)
    fireEvent.pointerDown(getByTestId("image-resize-right"), { clientX: 360, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 590, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 590, pointerId: 1 })
    expect(imageProps(getByTestId)).toEqual([{ src: SRC, align: "left", size: 100 }])

    // …and dragged past nothing, it stops at a tenth.
    layOut(container, 600, 600)
    fireEvent.pointerDown(getByTestId("image-resize-right"), { clientX: 600, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 0, pointerId: 1 })
    expect(imageProps(getByTestId)).toEqual([{ src: SRC, align: "left", size: 10 }])
  })

  it("the context menu aligns a picture and returns a dragged one to its natural size", async () => {
    const { container, getByTestId } = render(<Harness initialDoc={imageDoc({ src: SRC })} />)
    const row = container.querySelector("[data-occurrence]")!
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    })
    let menu = screen.getByTestId("block-context-menu")
    expect(menu.textContent).toContain("Align")
    // Nothing to return to yet.
    expect(menu.textContent).not.toContain("Original size")
    await act(async () => {
      fireEvent.click(screen.getByText("Align"))
    })
    await act(async () => {
      fireEvent.click(screen.getByText("Right"))
    })
    expect(imageProps(getByTestId)).toEqual([{ src: SRC, align: "right" }])

    // Once dragged, the menu offers the natural size back.
    layOut(container, 600, 600)
    fireEvent.pointerDown(getByTestId("image-resize-left"), { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 300, pointerId: 1 })
    expect(imageProps(getByTestId)).toEqual([{ src: SRC, align: "right", size: 50 }])
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    })
    menu = screen.getByTestId("block-context-menu")
    expect(menu.textContent).toContain("Original size")
    await act(async () => {
      fireEvent.click(screen.getByText("Original size"))
    })
    expect(imageProps(getByTestId)).toEqual([{ src: SRC, align: "right" }])
    expect(getByTestId("image-figure").style.width).toBe("")
  })

  it("a read-only view lays the picture out the same, with no controls", () => {
    const { container } = render(
      <BlockEditor
        doc={imageDoc({ src: SRC, align: "left", size: 30 }, "A sunset")}
        onChange={() => {}}
        readOnly
      />,
    )
    const figure = container.querySelector<HTMLElement>('[data-testid="image-figure"]')!
    expect(figure.dataset.align).toBe("left")
    expect(figure.style.width).toBe("30%")
    expect(container.querySelector('[data-testid="image-toolbar"]')).toBeNull()
    expect(container.querySelector('[data-testid="image-resize-left"]')).toBeNull()
  })

  it("clicking the picture opens it full size", async () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a"],
      blocks: {
        a: {
          id: "a",
          type: "image",
          text: "Wide",
          props: { src: "https://example.com/wide.png" },
          children: [],
        },
      },
    }
    const { container } = render(<Harness initialDoc={doc} />)
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="block-image"]')!)
    })
    const lightbox = screen.getByTestId("image-lightbox")
    expect(lightbox.querySelector("img")!.alt).toBe("Wide")
  })
})

describe("BlockEditor inline links", () => {
  /** Hover `element` until the link's card opens. */
  async function hover(element: Element): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.pointerEnter(element, { pointerType: "mouse" })
      fireEvent.mouseEnter(element)
      fireEvent.mouseMove(element)
      await new Promise((resolve) => setTimeout(resolve, 500))
    })
    return screen.getByTestId("link-hover-card")
  }
  /** Hover the link in row `index`. */
  const hoverLink = (container: HTMLElement, index: number) =>
    hover(container.querySelectorAll("[data-occurrence]")[index]!.querySelector("a")!)
  /** A paste of plain text into the textarea being edited. */
  const pasteText = (textarea: Element, text: string) =>
    fireEvent.paste(textarea, {
      clipboardData: {
        files: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    })

  it("a pasted address is written out as a link named for its host, the address kept whole", async () => {
    const { container, getByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    await act(async () => {
      pasteText(textarea, "see https://www.example.com/a/b?c=1. and [kept](https://e.com/k)")
    })
    expect(serializedLines(getByTestId)).toEqual([
      "see [example.com](https://www.example.com/a/b?c=1). and [kept](https://e.com/k)",
    ])
  })

  it("the hover card is a pill — the address as a link, a copy, Edit — that opens to a panel", async () => {
    const { container, getByTestId } = render(
      <Harness initial={"Read [the guide](https://e.com/g) first"} />,
    )
    const card = await hoverLink(container, 0)
    const address = within(card).getByTestId("link-card-address")
    expect(address.getAttribute("href")).toBe("https://e.com/g")
    expect(address.getAttribute("target")).toBe("_blank")
    expect(within(card).getByLabelText("Copy address")).not.toBeNull()
    expect(screen.queryByTestId("link-card-panel")).toBeNull()

    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    expect((screen.getByTestId("link-card-url") as HTMLInputElement).value).toBe("https://e.com/g")
    const field = screen.getByTestId("link-display-text") as HTMLInputElement
    expect(field.value).toBe("the guide")
    await act(async () => {
      fireEvent.change(field, { target: { value: "the manual" } })
      fireEvent.submit(field.closest("form")!)
    })
    expect(serializedLines(getByTestId)).toEqual(["Read [the manual](https://e.com/g) first"])
    // One undo step.
    fireEvent.keyDown(editorRoot(container), { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["Read [the guide](https://e.com/g) first"])
  })

  it("the panel points the link at a new address, and takes the link off", async () => {
    const { container, getByTestId } = render(
      <Harness initial={"Read [the guide](https://e.com/g) first"} />,
    )
    await hoverLink(container, 0)
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    const url = screen.getByTestId("link-card-url") as HTMLInputElement
    await act(async () => {
      fireEvent.change(url, { target: { value: "docs.e.com/guide" } })
      fireEvent.blur(url)
    })
    expect(serializedLines(getByTestId)).toEqual([
      "Read [the guide](https://docs.e.com/guide) first",
    ])

    // The card stays at its panel after a save; hover again and it is
    // there, or Edit brings it back.
    await hoverLink(container, 0)
    if (!screen.queryByTestId("link-card-panel")) {
      await act(async () => {
        fireEvent.click(getByTestId("link-card-edit"))
      })
    }
    await act(async () => {
      fireEvent.click(getByTestId("link-card-remove"))
    })
    expect(serializedLines(getByTestId)).toEqual(["Read the guide first"])
    expect(container.querySelector("a")).toBeNull()
  })

  it("a field left unsaved is saved as the card closes, however it closes", async () => {
    const { container, getByTestId } = render(
      <Harness initial={"Read [the guide](https://e.com/g) first"} />,
    )
    await hoverLink(container, 0)
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    const field = screen.getByTestId("link-display-text") as HTMLInputElement
    await act(async () => {
      fireEvent.change(field, { target: { value: "the manual" } })
    })
    // A press elsewhere takes the popup down, with no blur first.
    await act(async () => {
      fireEvent.pointerDown(document.body, { pointerType: "mouse", pointerId: 1 })
      fireEvent.mouseDown(document.body)
      fireEvent.pointerUp(document.body, { pointerType: "mouse", pointerId: 1 })
      fireEvent.mouseUp(document.body)
      fireEvent.click(document.body)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    await waitFor(() => expect(screen.queryByTestId("link-card-panel")).toBeNull())
    expect(serializedLines(getByTestId)).toEqual(["Read [the manual](https://e.com/g) first"])
  })

  it("both fields changed at once are one rewrite, and a field left alone is no change", async () => {
    const { container, getByTestId } = render(
      <Harness initial={"Read [the guide](https://e.com/g) first"} />,
    )
    await hoverLink(container, 0)
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId("link-card-url"), {
        target: { value: "https://docs.e.com/g" },
      })
      fireEvent.change(screen.getByTestId("link-display-text"), {
        target: { value: "the manual" },
      })
      fireEvent.submit(screen.getByTestId("link-card-panel"))
    })
    expect(serializedLines(getByTestId)).toEqual(["Read [the manual](https://docs.e.com/g) first"])
    // One undo step for both.
    fireEvent.keyDown(editorRoot(container), { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["Read [the guide](https://e.com/g) first"])
    // Opened and left alone: nothing is written.
    await hoverLink(container, 0)
    if (!screen.queryByTestId("link-card-panel")) {
      await act(async () => {
        fireEvent.click(getByTestId("link-card-edit"))
      })
    }
    await act(async () => {
      fireEvent.blur(screen.getByTestId("link-display-text"))
    })
    expect(serializedLines(getByTestId)).toEqual(["Read [the guide](https://e.com/g) first"])
  })

  it("a typed address is offered its host as display text, and written out as a link", async () => {
    const { container, getByTestId } = render(<Harness initial={"See https://www.e.com/x now"} />)
    await hoverLink(container, 0)
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    const field = screen.getByTestId("link-display-text") as HTMLInputElement
    expect(field.value).toBe("e.com")
    await act(async () => {
      fireEvent.submit(field.closest("form")!)
    })
    expect(serializedLines(getByTestId)).toEqual(["See [e.com](https://www.e.com/x) now"])
  })

  it("a space typed after an address writes it out as a link, the caret following", async () => {
    const { container, getByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "see https://www.e.com/x" } })
    })
    expect(serializedLines(getByTestId)).toEqual(["see https://www.e.com/x"])
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "see https://www.e.com/x " } })
    })
    expect(serializedLines(getByTestId)).toEqual(["see [e.com](https://www.e.com/x) "])
    expect(textarea.selectionStart).toBe("see [e.com](https://www.e.com/x) ".length)
    // Its own undo step: the bare address comes back.
    fireEvent.keyDown(textarea, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["see https://www.e.com/x"])
  })

  it("a name with a common ending is an address too: google.com, then a space", async () => {
    const { container, getByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "search google.com " } })
    })
    expect(serializedLines(getByTestId)).toEqual(["search [google.com](https://google.com) "])
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: "search [google.com](https://google.com) not node.js " },
      })
    })
    expect(serializedLines(getByTestId)).toEqual([
      "search [google.com](https://google.com) not node.js ",
    ])
  })

  it("leaving edit mode writes out a bare address left in the row", async () => {
    const { container, getByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")!
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "https://www.e.com/x" } })
    })
    expect(serializedLines(getByTestId)).toEqual(["https://www.e.com/x"])
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Escape" })
    })
    expect(container.querySelector("textarea")).toBeNull()
    expect(serializedLines(getByTestId)).toEqual(["[e.com](https://www.e.com/x)"])
  })

  it("the menu's Edit link opens a link's card without a hover, for a touch screen", async () => {
    const { container } = render(
      <Harness initial={"Read [the guide](https://e.com/g) and https://e.com/x"} />,
    )
    const row = container.querySelector("[data-occurrence]")!
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    })
    const menu = screen.getByTestId("block-context-menu")
    expect(menu.textContent).toContain("Edit link")
    // Two links: a submenu names them by their text.
    await act(async () => {
      fireEvent.click(screen.getByText("Edit link"))
    })
    const submenu = await screen.findByTestId("edit-link-menu")
    expect(submenu.textContent).toContain("the guide")
    expect(submenu.textContent).toContain("https://e.com/x")
    await act(async () => {
      fireEvent.click(within(submenu).getByText("the guide"))
    })
    // Opened this way it is the panel straight away: there is no hover to
    // reach Edit from.
    await screen.findByTestId("link-card-panel")
    expect((screen.getByTestId("link-card-url") as HTMLInputElement).value).toBe("https://e.com/g")
    expect((screen.getByTestId("link-display-text") as HTMLInputElement).value).toBe("the guide")
  })

  it("a read-only row's link is only a link", async () => {
    const { container } = render(
      <BlockEditor doc={withStarter(parse("https://e.com/x"))} onChange={() => {}} readOnly />,
    )
    const anchor = container.querySelector("a")!
    await act(async () => {
      fireEvent.pointerEnter(anchor, { pointerType: "mouse" })
      fireEvent.mouseEnter(anchor)
      fireEvent.mouseMove(anchor)
      await new Promise((resolve) => setTimeout(resolve, 500))
    })
    expect(screen.queryByTestId("link-hover-card")).toBeNull()
  })
})

describe("BlockEditor links", () => {
  const linkProps = (getByTestId: (id: string) => HTMLElement) =>
    JSON.parse(getByTestId("link-props").textContent ?? "[]") as unknown[]
  const linkDoc = (props: Record<string, unknown>, text = ""): BlockDoc => ({
    props: null,
    rootBlockIds: ["a"],
    blocks: { a: { id: "a", type: "link", text, props, children: [] } },
  })
  const PREVIEW: LinkPreview = {
    url: "https://e.com/x",
    title: "Page title",
    description: "What the page says.",
    image: "https://e.com/x.png",
    favicon: "https://e.com/favicon.ico",
    site: "E",
  }
  /** Hover `element` until the link's card opens. */
  async function hover(element: Element): Promise<HTMLElement> {
    await act(async () => {
      fireEvent.pointerEnter(element, { pointerType: "mouse" })
      fireEvent.mouseEnter(element)
      fireEvent.mouseMove(element)
      await new Promise((resolve) => setTimeout(resolve, 500))
    })
    return screen.getByTestId("link-hover-card")
  }
  /** Hover the link in row `index`. */
  const hoverLink = (container: HTMLElement, index: number) =>
    hover(container.querySelectorAll("[data-occurrence]")[index]!.querySelector("a")!)
  async function openMenuOn(container: HTMLElement, index: number): Promise<HTMLElement> {
    const row = container.querySelectorAll("[data-occurrence]")[index]!
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    })
    return screen.getByTestId("block-context-menu")
  }

  it("a whole-line link's hover card turns the row into a link block, previewed as one edit", async () => {
    let settle: (preview: LinkPreview) => void = () => {}
    const onLinkPreview = vi.fn(
      () =>
        new Promise<LinkPreview>((resolve) => {
          settle = resolve
        }),
    )
    const { container, getByTestId } = render(
      <Harness initial={"A\n[e.com](https://e.com/x)\nC"} onLinkPreview={onLinkPreview} />,
    )
    const card = await hoverLink(container, 1)
    expect(within(card).getByTestId("link-card-address").textContent).toBe("https://e.com/x")
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    await act(async () => {
      fireEvent.click(screen.getByText("Turn into block"))
    })
    // The row is the block at once, with its address and the link's text —
    // which is only the host, so the card says there is no preview yet.
    expect(serializedLines(getByTestId)).toEqual(["A", "[e.com](https://e.com/x)", "C"])
    expect(linkProps(getByTestId)).toEqual([{ url: "https://e.com/x" }])
    expect(container.querySelector('[data-testid="link-card"]')).not.toBeNull()
    expect(getByTestId("link-placeholder").textContent).toBe("No preview available")
    expect(
      container.querySelector('[data-testid="link-card"] [data-testid="block-body"]'),
    ).toBeNull()
    expect(highlightedText(container)).toContain("e.com")
    expect(onLinkPreview).toHaveBeenCalledWith("https://e.com/x")

    await act(async () => {
      settle(PREVIEW)
    })
    // A titled block keeps its title; the preview is on the block.
    expect(serializedLines(getByTestId)).toEqual(["A", "[e.com](https://e.com/x)", "C"])
    expect(linkProps(getByTestId)).toEqual([
      {
        url: "https://e.com/x",
        description: "What the page says.",
        image: "https://e.com/x.png",
        favicon: "https://e.com/favicon.ico",
        site: "E",
      },
    ])
    expect(getByTestId("link-description").textContent).toBe("What the page says.")
    expect(container.querySelector('[data-testid="link-placeholder"]')).toBeNull()

    // Landing the preview is the same edit as making the block: one undo.
    fireEvent.keyDown(editorRoot(container), { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "[e.com](https://e.com/x)", "C"])
    expect(linkProps(getByTestId)).toEqual([])
  })

  it("a bare address becomes an untitled block, which takes the page's title", async () => {
    const onLinkPreview = vi.fn(async () => PREVIEW)
    const { container, getByTestId } = render(
      <Harness initial={"https://e.com/x"} onLinkPreview={onLinkPreview} />,
    )
    await hoverLink(container, 0)
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    await act(async () => {
      fireEvent.click(screen.getByText("Turn into block"))
    })
    await waitFor(() =>
      expect(serializedLines(getByTestId)).toEqual(["[Page title](https://e.com/x)"]),
    )
  })

  it("Turn into link block in the menu makes the block of the row's first link", async () => {
    const { container, getByTestId } = render(
      <Harness
        initial={"Read [the guide](https://e.com/g) and https://e.com/x\n[e.com](https://e.com/y)"}
      />,
    )
    // A sentence: the block goes in beneath, titled as the link.
    await openMenuOn(container, 0)
    await act(async () => {
      fireEvent.click(screen.getByText("Turn into link block"))
    })
    expect(serializedLines(getByTestId)).toEqual([
      "Read [the guide](https://e.com/g) and https://e.com/x",
      "[the guide](https://e.com/g)",
      "[e.com](https://e.com/y)",
    ])
    // A row that is only the link becomes the block itself.
    await openMenuOn(container, 2)
    await act(async () => {
      fireEvent.click(screen.getByText("Turn into link block"))
    })
    expect(serializedLines(getByTestId)).toEqual([
      "Read [the guide](https://e.com/g) and https://e.com/x",
      "[the guide](https://e.com/g)",
      "[e.com](https://e.com/y)",
    ])
    expect(linkProps(getByTestId)).toHaveLength(2)
    expect(linkProps(getByTestId)).toEqual(
      expect.arrayContaining([{ url: "https://e.com/g" }, { url: "https://e.com/y" }]),
    )
    // A row with no link is not offered it.
    const plain = render(<Harness initial={"No link here"} />)
    const menu = await openMenuOn(plain.container, 0)
    expect(menu.textContent).not.toContain("Turn into link block")
  })

  it("the menu's Edit link opens a link block's card outright, for a touch screen", async () => {
    const { container } = render(
      <Harness initialDoc={linkDoc({ url: "https://e.com/x", site: "E" }, "Old")} />,
    )
    const menu = await openMenuOn(container, 0)
    expect(menu.textContent).toContain("Edit link")
    await act(async () => {
      fireEvent.click(screen.getByText("Edit link"))
    })
    const card = await screen.findByTestId("link-card-panel")
    expect(card.textContent).toContain("Turn into inline")
    expect((screen.getByTestId("link-display-text") as HTMLInputElement).value).toBe("Old")
  })

  it("a panel stays open while the pointer wanders, and no other card opens meanwhile", async () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a", "b"],
      blocks: {
        a: { id: "a", type: "text", text: "See [the guide](https://e.com/g)", children: [] },
        b: { id: "b", type: "link", text: "B", props: { url: "https://e.com/x" }, children: [] },
      },
    }
    const { container, getByTestId } = render(<Harness initialDoc={doc} />)
    await hoverLink(container, 0)
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    expect(screen.getByTestId("link-card-panel")).not.toBeNull()
    // The pointer leaves the link for the card beneath, and lingers there.
    const anchor = container.querySelector("a")!
    const card = getByTestId("link-card")
    await act(async () => {
      fireEvent.pointerLeave(anchor, { pointerType: "mouse" })
      fireEvent.mouseLeave(anchor)
      fireEvent.pointerEnter(card, { pointerType: "mouse" })
      fireEvent.mouseEnter(card)
      fireEvent.mouseMove(card)
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    expect(screen.getAllByTestId("link-hover-card")).toHaveLength(1)
    expect(screen.getByTestId("link-card-panel")).not.toBeNull()
    expect((screen.getByTestId("link-display-text") as HTMLInputElement).value).toBe("the guide")
  })

  it("a link in a sentence gets its block as a new row beneath, titled as the link", async () => {
    const { container, getByTestId } = render(
      <Harness initial={"Read [the guide](https://e.com/g) first"} />,
    )
    await hoverLink(container, 0)
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    await act(async () => {
      fireEvent.click(screen.getByText("Turn into block"))
    })
    expect(serializedLines(getByTestId)).toEqual([
      "Read [the guide](https://e.com/g) first",
      "[the guide](https://e.com/g)",
    ])
    expect(linkProps(getByTestId)).toEqual([{ url: "https://e.com/g" }])
  })

  it("a space typed after an address writes it out as a link, the caret following", async () => {
    const { container, getByTestId } = render(<Harness initial="" startEditing />)
    const textarea = container.querySelector("textarea")! as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "see https://www.e.com/x" } })
    })
    expect(serializedLines(getByTestId)).toEqual(["see https://www.e.com/x"])
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "see https://www.e.com/x " } })
    })
    expect(serializedLines(getByTestId)).toEqual(["see [e.com](https://www.e.com/x) "])
    expect(textarea.selectionStart).toBe("see [e.com](https://www.e.com/x) ".length)
    // Its own undo step: the bare address comes back.
    fireEvent.keyDown(textarea, { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["see https://www.e.com/x"])
  })

  it("draws a link block as a card: the title line, the description and a byline that opens the page", () => {
    const { container, getByTestId } = render(
      <Harness
        initialDoc={linkDoc(
          {
            url: "https://www.e.com/x",
            description: "Desc",
            site: "E",
            favicon: "https://e.com/f.png",
          },
          "My **title**",
        )}
      />,
    )
    expect(container.querySelector('[data-testid="paragraph-slot"]')).toBeNull()
    const body = container.querySelector('[data-testid="link-card"] [data-testid="block-body"]')!
    expect(body.querySelector("strong")!.textContent).toBe("title")
    expect(getByTestId("link-description").textContent).toBe("Desc")
    const byline = getByTestId("link-byline") as HTMLAnchorElement
    expect(byline.getAttribute("href")).toBe("https://www.e.com/x")
    expect(byline.getAttribute("target")).toBe("_blank")
    expect(byline.textContent).toBe("Ee.com")
    expect(byline.querySelector("img")!.getAttribute("src")).toBe("https://e.com/f.png")
    // No picture, no thumbnail.
    expect(container.querySelector('[data-testid="link-image"]')).toBeNull()

    // With one, it leads the card, on the left, at a width that stays a
    // thumbnail.
    cleanup()
    const pictured = render(
      <Harness
        initialDoc={linkDoc({ url: "https://www.e.com/x", image: "https://e.com/p.png" }, "T")}
      />,
    )
    const card = pictured.getByTestId("link-card")
    const first = card.firstElementChild!
    expect(first.querySelector('[data-testid="link-image"]')).not.toBeNull()
    expect(first.className).toContain("min-w-32")
  })

  it("a link block without a preview says so, keeps a real title, and edits on double-click", async () => {
    // No description, no picture: a placeholder where the description
    // would be, the address in the byline, and no title line for a title
    // that is only the host.
    const bare = render(<Harness initialDoc={linkDoc({ url: "https://e.com/x" }, "e.com")} />)
    expect(bare.container.querySelector('[data-testid="block-body"]')).toBeNull()
    expect(bare.container.querySelector('[data-testid="link-untitled"]')).toBeNull()
    expect(bare.getByTestId("link-placeholder").textContent).toBe("No preview available")
    expect(bare.getByTestId("link-byline").textContent).toBe("e.com")
    await act(async () => {
      fireEvent.doubleClick(bare.getByTestId("link-card"))
    })
    expect(bare.container.querySelector("textarea")).not.toBeNull()
    expect(bare.container.querySelector("textarea")!.getAttribute("placeholder")).toBe(
      "Add a title…",
    )
    bare.unmount()

    // A title the reader gave it stays, over the placeholder.
    const named = render(
      <Harness initialDoc={linkDoc({ url: "https://e.com/x" }, "Flight booking")} />,
    )
    expect(named.container.querySelector('[data-testid="block-body"]')!.textContent).toBe(
      "Flight booking",
    )
    expect(named.getByTestId("link-placeholder")).not.toBeNull()
    named.unmount()

    // With a preview and no title, the host stands in for the title line.
    const previewed = render(
      <Harness initialDoc={linkDoc({ url: "https://e.com/x", description: "D" })} />,
    )
    expect(previewed.getByTestId("link-untitled").textContent).toBe("e.com")
    expect(previewed.container.querySelector('[data-testid="link-placeholder"]')).toBeNull()
  })

  it("says why when a preview cannot be fetched", async () => {
    const onLinkPreview = vi.fn(async () => {
      throw new LinkPreviewError("unreachable", "The page did not answer")
    })
    const { container, getByTestId } = render(
      <>
        <Harness initial={"[e.com](https://e.com/x)"} onLinkPreview={onLinkPreview} />
        <Toaster />
      </>,
    )
    await hoverLink(container, 0)
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    await act(async () => {
      fireEvent.click(screen.getByText("Turn into block"))
    })
    await waitFor(() =>
      expect(document.body.textContent).toContain("No preview for e.com: the page did not answer"),
    )
  })

  it("a click on the card selects its row; the byline keeps its own click", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a", "b"],
      blocks: {
        a: { id: "a", type: "text", text: "A", children: [] },
        b: { id: "b", type: "link", text: "B", props: { url: "https://e.com/x" }, children: [] },
      },
    }
    const { container, getByTestId } = render(<Harness initialDoc={doc} />)
    const selectedCard = () => container.querySelector('.bg-bg-secondary [data-testid="link-card"]')
    expect(selectedCard()).toBeNull()
    fireEvent.click(getByTestId("link-byline"))
    expect(selectedCard()).toBeNull()
    fireEvent.click(getByTestId("link-card"))
    expect(selectedCard()).not.toBeNull()
  })

  it("the card's hover card renames the block and turns it back into an inline link", async () => {
    const { container, getByTestId } = render(
      <Harness initialDoc={linkDoc({ url: "https://e.com/x", site: "E" }, "Old")} />,
    )
    await hover(getByTestId("link-card"))
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    const field = screen.getByTestId("link-display-text") as HTMLInputElement
    expect(field.value).toBe("Old")
    await act(async () => {
      fireEvent.change(field, { target: { value: "New" } })
      fireEvent.submit(field.closest("form")!)
    })
    expect(serializedLines(getByTestId)).toEqual(["[New](https://e.com/x)"])
    expect(linkProps(getByTestId)).toEqual([{ url: "https://e.com/x", site: "E" }])

    await act(async () => {
      fireEvent.click(screen.getByText("Turn into inline"))
    })
    expect(serializedLines(getByTestId)).toEqual(["[New](https://e.com/x)"])
    expect(linkProps(getByTestId)).toEqual([])
    expect(container.querySelector('[data-testid="link-card"]')).toBeNull()
    expect(container.querySelector("a")!.getAttribute("href")).toBe("https://e.com/x")
  })

  it("the card's panel points the block at a new page, whose preview replaces the old", async () => {
    const onLinkPreview = vi.fn(async (url: string) => ({ ...PREVIEW, url, site: "New site" }))
    const { getByTestId } = render(
      <Harness
        initialDoc={linkDoc(
          { url: "https://e.com/x", description: "Old", site: "E", align: "left" },
          "Kept",
        )}
        onLinkPreview={onLinkPreview}
      />,
    )
    await hover(getByTestId("link-card"))
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    await act(async () => {
      fireEvent.change(screen.getByTestId("link-card-url"), { target: { value: "new.e.com/y" } })
      fireEvent.submit(screen.getByTestId("link-card-panel"))
    })
    expect(serializedLines(getByTestId)).toEqual(["[Kept](https://new.e.com/y)"])
    expect(onLinkPreview).toHaveBeenCalledWith("https://new.e.com/y")
    await waitFor(() =>
      expect(linkProps(getByTestId)).toEqual([expect.objectContaining({ site: "New site" })]),
    )
    // The old preview went with the old address; the layout stayed.
    expect(linkProps(getByTestId)).toEqual([
      expect.objectContaining({ url: "https://new.e.com/y", align: "left" }),
    ])
    expect((linkProps(getByTestId)[0] as { description?: string }).description).toBe(
      "What the page says.",
    )
  })

  it("Remove link on the card takes the whole row out", async () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a", "b", "c"],
      blocks: {
        a: { id: "a", type: "text", text: "A", children: [] },
        b: { id: "b", type: "link", text: "B", props: { url: "https://e.com/x" }, children: [] },
        c: { id: "c", type: "text", text: "C", children: [] },
      },
    }
    const { getByTestId } = render(<Harness initialDoc={doc} />)
    await hover(getByTestId("link-card"))
    await act(async () => {
      fireEvent.click(getByTestId("link-card-edit"))
    })
    await act(async () => {
      fireEvent.click(getByTestId("link-card-remove"))
    })
    expect(serializedLines(getByTestId)).toEqual(["A", "C"])
    expect(linkProps(getByTestId)).toEqual([])
  })

  it("the menu refreshes the preview, filling an empty title", async () => {
    const onLinkPreview = vi.fn(async () => PREVIEW)
    const { container, getByTestId } = render(
      <Harness
        initialDoc={linkDoc({ url: "https://e.com/x", description: "Stale" })}
        onLinkPreview={onLinkPreview}
      />,
    )
    const menu = await openMenuOn(container, 0)
    expect(menu.textContent).toContain("Open link")
    expect(menu.textContent).toContain("Turn into inline")
    expect(menu.textContent).toContain("Align")
    await act(async () => {
      fireEvent.click(screen.getByText("Refresh preview"))
    })
    await waitFor(() =>
      expect(linkProps(getByTestId)).toEqual([expect.objectContaining({ site: "E" })]),
    )
    expect(serializedLines(getByTestId)).toEqual(["[Page title](https://e.com/x)"])
    expect(linkProps(getByTestId)).toEqual([
      {
        url: "https://e.com/x",
        description: "What the page says.",
        image: "https://e.com/x.png",
        favicon: "https://e.com/favicon.ico",
        site: "E",
      },
    ])
  })

  it("offers no refresh without a way to fetch, and lays the card out like a picture", async () => {
    const { container, getByTestId } = render(
      <Harness initialDoc={linkDoc({ url: "https://e.com/x", align: "left", size: 40 })} />,
    )
    const frame = getByTestId("link-figure")
    expect(frame.dataset.align).toBe("left")
    expect(frame.style.width).toBe("40%")
    expect(container.querySelector('[data-testid="link-resize-right"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="link-resize-left"]')).toBeNull()
    const menu = await openMenuOn(container, 0)
    expect(menu.textContent).not.toContain("Refresh preview")
    expect(menu.textContent).toContain("Full width")
    await act(async () => {
      fireEvent.click(screen.getByText("Full width"))
    })
    expect(linkProps(getByTestId)).toEqual([{ url: "https://e.com/x", align: "left" }])
    expect(getByTestId("link-figure").style.width).toBe("100%")
  })
})

describe("two editors on one page", () => {
  /** The note page's shape: the outline and, beneath it, the Unassigned
   * basket — a second editor whose doc is walked from the same graph, so it
   * changes on every keystroke in the first. */
  function TwoEditors() {
    const [outline, setOutline] = useState<BlockDoc>(() => parse("A"))
    const [basket, setBasket] = useState<BlockDoc>(() => parse("B"))
    return (
      <>
        <div data-testid="outline">
          <BlockEditor doc={outline} onChange={setOutline} />
        </div>
        <div data-testid="basket">
          <BlockEditor doc={basket} onChange={setBasket} />
        </div>
        <button data-testid="graph-change" onClick={() => setBasket(parse("B, changed"))}>
          graph change
        </button>
      </>
    )
  }

  it("keeps the block being typed in editing when the other editor's doc changes", () => {
    const { getByTestId } = render(<TwoEditors />)
    const outline = getByTestId("outline")
    const root = editorRoot(outline)
    act(() => root.focus())
    fireEvent.keyDown(root, { key: "Enter" }) // edit A
    const textarea = outline.querySelector("textarea")!
    expect(textarea).not.toBeNull()
    expect(document.activeElement).toBe(textarea)

    // The other editor's doc changes underneath (as every keystroke here
    // changes the graph the basket is walked from): the textarea stays.
    fireEvent.click(getByTestId("graph-change"))
    expect(outline.querySelector("textarea")).toBe(textarea)
    expect(document.activeElement).toBe(textarea)
  })
})

describe("reaching for a control never ends the edit", () => {
  const NESTED =
    "- parent\n  id:: blk_parent\n  - child\n    id:: blk_child\n- [ ] task\n  id:: blk_task\n"

  it("keeps the caret where it was when the fold chevron is pressed", () => {
    const { container } = render(<Harness initial={NESTED} startEditing />)
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!
    expect(document.activeElement).toBe(textarea)

    // A press moves focus by default, and the blur would close the edit. The
    // chevron drops that half of the press, so the row keeps typing.
    const chevron = container.querySelector<HTMLElement>('[aria-label="Collapse"]')!
    const press = fireEvent.mouseDown(chevron)
    expect(press).toBe(false) // preventDefault: focus stays put
    fireEvent.click(chevron)
    expect(container.querySelector("textarea")).toBe(textarea)
    expect(document.activeElement).toBe(textarea)
    // And it really folded: the child is gone from the rows.
    expect(container.querySelector('[data-block-row="blk_child"]')).toBeNull()
  })

  it("ticks a todo without ending the edit, and the tick still lands", () => {
    const { container, getByTestId } = render(<Harness initial={NESTED} startEditing />)
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(fireEvent.mouseDown(box)).toBe(false)
    fireEvent.click(box)
    expect(document.activeElement).toBe(textarea)
    expect(serializedLines(getByTestId)).toContain("[x] task")
  })
})

describe("Tab into a row that has just become a parent", () => {
  it("asks for that row to be revealed, so a fold rule cannot hide the row just nested", () => {
    // The row `y` goes under `x`, which was a leaf. A depth rule that folds
    // from the second level down would close `x` the instant it gains a
    // child, taking the row being typed in with it — so the editor is told
    // to record `x` as open.
    const reveal = vi.fn()
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a"],
      blocks: {
        a: { id: "a", type: "text", text: "A", children: ["x", "y"] },
        x: { id: "x", type: "text", text: "X", children: [] },
        y: { id: "y", type: "text", text: "Y", children: [] },
      },
    }
    const { container } = render(
      <BlockEditor
        doc={doc}
        onChange={vi.fn()}
        collapsed={new Set()}
        onToggleCollapse={vi.fn()}
        onReveal={reveal}
      />,
    )
    const root = editorRoot(container)
    act(() => root.focus())
    fireEvent.keyDown(root, { key: "ArrowDown" })
    fireEvent.keyDown(root, { key: "ArrowDown" })
    fireEvent.keyDown(root, { key: "ArrowDown" }) // highlight `Y`
    fireEvent.keyDown(root, { key: "Tab" })
    expect(reveal).toHaveBeenCalledWith("a/x")
  })
})

describe("wrapping the selection by typing", () => {
  const selectAll = (textarea: HTMLTextAreaElement) => {
    textarea.setSelectionRange(0, textarea.value.length)
  }

  it("puts the selection inside the character typed instead of replacing it", () => {
    const { container, getByTestId } = render(<Harness initial={"- alpha"} startEditing />)
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!
    selectAll(textarea)
    const typed = fireEvent.keyDown(textarea, { key: "(", shiftKey: true })
    expect(typed).toBe(false) // handled: the character does not also type
    expect(serializedLines(getByTestId)).toEqual(["- (alpha)"])
  })

  it("closes a quote and a backtick with themselves, a bracket with its partner", () => {
    for (const [char, expected] of [
      ['"', '- "alpha"'],
      ["`", "- `alpha`"],
      ["[", "- [alpha]"],
      ["{", "- {alpha}"],
    ] as const) {
      const { container, getByTestId } = render(<Harness initial={"- alpha"} startEditing />)
      const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!
      selectAll(textarea)
      fireEvent.keyDown(textarea, { key: char })
      expect(serializedLines(getByTestId)).toEqual([expected])
      cleanup()
    }
  })

  it("leaves the character to type when nothing is selected", () => {
    const { container } = render(<Harness initial={"- alpha"} startEditing />)
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!
    textarea.setSelectionRange(5, 5)
    expect(fireEvent.keyDown(textarea, { key: "(" })).toBe(true)
  })
})

describe("one action layer: a range of blocks takes the same commands as one", () => {
  const FOUR = [
    "A",
    "  id:: blk_a",
    "B",
    "  id:: blk_b",
    "C",
    "  id:: blk_c",
    "D",
    "  id:: blk_d",
  ].join("\n")

  async function openMenuOn(container: HTMLElement, index: number): Promise<HTMLElement> {
    const row = container.querySelectorAll("[data-occurrence]")[index]!
    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    })
    return screen.getByTestId("block-context-menu")
  }
  async function pick(label: string) {
    await act(async () => {
      fireEvent.click(screen.getByText(label))
    })
  }
  /** Highlight B, then extend the range down to C (B is the anchor, C the head). */
  function selectBC(root: HTMLElement) {
    selectNth(root, 1)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true })
  }

  it("the menu opened on a selected row acts on every selected block, and says how many", async () => {
    const deleteEverywhere = vi.fn()
    const { container, getByTestId } = render(
      <Harness initial={FOUR} parentCountOf={() => 1} onDeleteEverywhere={deleteEverywhere} />,
    )
    const root = editorRoot(container)
    selectBC(root)
    expect(highlightedAll(container)).toEqual(["B", "C"])
    let menu = await openMenuOn(container, 2) // C, inside the selection
    // The selection survives the right-click, and the menu is for all of it.
    expect(highlightedAll(container)).toEqual(["B", "C"])
    for (const label of [
      "Copy 2 blocks",
      "Duplicate 2 blocks",
      "Unlink 2 blocks",
      "Delete 2 blocks",
    ]) {
      expect(menu.textContent).toContain(label)
    }
    await pick("Delete 2 blocks")
    // The graph-level delete gets every selected block, in document order.
    expect(deleteEverywhere).toHaveBeenCalledWith(["blk_b", "blk_c"])

    menu = await openMenuOn(container, 1) // B, still selected with C
    await pick("Unlink 2 blocks")
    // Both rows go — what ⌫ on the selection does — and the highlight lands
    // on the row that takes their place.
    expect(serializedLines(getByTestId)).toEqual(["A", "D"])
    expect(highlightedAll(container)).toEqual(["D"])
  })

  it("the menu opened off the selection is for that row alone", async () => {
    const { container, getByTestId } = render(
      <Harness initial={FOUR} parentCountOf={() => 1} onDeleteEverywhere={() => {}} />,
    )
    const root = editorRoot(container)
    selectBC(root)
    const menu = await openMenuOn(container, 3) // D, outside the selection
    // The row under the pointer becomes the selection, so the menu names no count.
    expect(highlightedAll(container)).toEqual(["D"])
    expect(menu.textContent).toContain("Unlink")
    expect(menu.textContent).not.toContain("blocks")
    await pick("Unlink")
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "C"])
  })

  it("the menu's Duplicate and moves take the selection too, and the range follows", async () => {
    const { container, getByTestId } = render(<Harness initial={FOUR} />)
    const root = editorRoot(container)
    selectBC(root)
    await openMenuOn(container, 1)
    await pick("Move down")
    expect(serializedLines(getByTestId)).toEqual(["A", "D", "B", "C"])
    expect(highlightedAll(container)).toEqual(["B", "C"])
    await openMenuOn(container, 2)
    await pick("Duplicate 2 blocks")
    expect(serializedLines(getByTestId)).toEqual(["A", "D", "B", "C", "B", "C"])
    // The copies are the selection now.
    expect(highlightedAll(container).length).toBe(2)
  })

  it("Escape on a range collapses it to the head, then deselects", () => {
    const { container } = render(<Harness initial={FOUR} />)
    const root = editorRoot(container)
    selectBC(root)
    fireEvent.keyDown(root, { key: "Escape" })
    expect(highlightedAll(container)).toEqual(["C"])
    fireEvent.keyDown(root, { key: "Escape" })
    expect(highlightedAll(container)).toEqual([])
  })

  it("Tab on a range indents every root and keeps the range on the moved rows", () => {
    const { container, getByTestId } = render(<Harness initial={FOUR} />)
    const root = editorRoot(container)
    selectBC(root)
    fireEvent.keyDown(root, { key: "Tab" })
    expect(serializedLines(getByTestId)).toEqual(["A", "  B", "  C", "D"])
    expect(highlightedAll(container)).toEqual(["B", "C"])
    // Nothing above the first root to nest under now: the range stays put.
    fireEvent.keyDown(root, { key: "Tab" })
    expect(serializedLines(getByTestId)).toEqual(["A", "  B", "  C", "D"])
    fireEvent.keyDown(root, { key: "Tab", shiftKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "C", "D"])
    expect(highlightedAll(container)).toEqual(["B", "C"])
  })

  it("x toggles every todo in the range", () => {
    const { container, getByTestId } = render(<Harness initial={"[ ] A\n[x] B\nC"} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true })
    fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true })
    expect(highlightedAll(container)).toEqual(["A", "B", "C"])
    fireEvent.keyDown(root, { key: "x" })
    expect(serializedLines(getByTestId)).toEqual(["[x] A", "[ ] B", "C"])
    expect(highlightedAll(container)).toEqual(["A", "B", "C"])
  })
})

describe("every surface runs the one action set", () => {
  const FOUR = [
    "A",
    "  id:: blk_a",
    "B",
    "  id:: blk_b",
    "C",
    "  id:: blk_c",
    "D",
    "  id:: blk_d",
  ].join("\n")
  const pick = async (label: string) => {
    await act(async () => {
      fireEvent.click(screen.getByText(label))
    })
  }
  /** Highlight rows `from`..`to` by keyboard, from the first row. */
  const selectRows = (root: HTMLElement, from: number, to: number) => {
    selectNth(root, from)
    for (let i = from; i < to; i++) fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true })
  }
  /** The three ways to run an action on the selection: its key, the block
   * menu opened on a selected row, and the selection bar's menu. */
  const drivers = {
    key: async (root: HTMLElement, _container: HTMLElement, by: Driver) => {
      fireEvent.keyDown(root, by.key)
    },
    menu: async (_root: HTMLElement, container: HTMLElement, by: Driver) => {
      const row = container.querySelectorAll("[data-occurrence]")[2]! // C, in the selection
      await act(async () => {
        fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
      })
      await pick(by.menu!)
    },
    bar: async (_root: HTMLElement, _container: HTMLElement, by: Driver) => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Actions" }))
      })
      for (const label of Array.isArray(by.bar) ? by.bar : [by.bar]) await pick(label)
    },
  }
  interface Driver {
    key: { key: string; altKey?: boolean; shiftKey?: boolean }
    /** The block menu's item; absent where the menu does not offer the action. */
    menu?: string
    bar: string | string[]
  }
  const cases: { action: string; initial?: string; by: Driver }[] = [
    { action: "indent", by: { key: { key: "Tab" }, bar: "Indent" } },
    {
      action: "outdent",
      initial: "A\n  B\n  C\nD",
      by: { key: { key: "Tab", shiftKey: true }, bar: "Outdent" },
    },
    {
      action: "move up",
      by: { key: { key: "ArrowUp", altKey: true }, menu: "Move up", bar: "Move up" },
    },
    {
      action: "move down",
      by: { key: { key: "ArrowDown", altKey: true }, menu: "Move down", bar: "Move down" },
    },
    {
      action: "duplicate",
      by: {
        key: { key: "ArrowDown", altKey: true, shiftKey: true },
        menu: "Duplicate 2 blocks",
        bar: "Duplicate",
      },
    },
    {
      action: "remove",
      by: { key: { key: "Backspace" }, menu: "Delete 2 blocks", bar: "Delete" },
    },
    { action: "turn into", by: { key: { key: "[" }, bar: ["Turn into", "To-do"] } },
  ]

  for (const { action, initial = FOUR, by } of cases) {
    it(`${action}: the key, the menu and the bar leave the same doc and the same rows selected`, async () => {
      const outcomes: Record<string, { lines: string[]; highlighted: string[] }> = {}
      for (const [name, drive] of Object.entries(drivers)) {
        if (name === "menu" && !by.menu) continue
        const { container, getByTestId, unmount } = render(<Harness initial={initial} />)
        const root = editorRoot(container)
        selectRows(root, 1, 2) // B and C
        expect(highlightedAll(container)).toEqual(["B", "C"])
        await drive(root, container, by)
        outcomes[name] = {
          lines: serializedLines(getByTestId),
          highlighted: highlightedAll(container),
        }
        unmount()
      }
      const [first, ...rest] = Object.values(outcomes)
      expect(rest.length).toBeGreaterThan(0)
      for (const other of rest) expect(other).toEqual(first)
      // And it did something: the action changed the doc.
      expect(first.lines).not.toEqual(serializedLinesOf(initial))
    })
  }

  /** The content lines an initial markdown would serialise to. */
  function serializedLinesOf(markdown: string): string[] {
    return markdown.split("\n").filter((l) => !l.includes("id::") && l.trim() !== "")
  }

  it("the bar's Delete deletes every selected block everywhere, as the menu's does", async () => {
    const fromBar = vi.fn()
    const fromMenu = vi.fn()
    for (const [deleteEverywhere, open] of [
      [fromBar, async () => fireEvent.click(screen.getByRole("button", { name: "Actions" }))],
      [
        fromMenu,
        async (container: HTMLElement) =>
          fireEvent.contextMenu(container.querySelectorAll("[data-occurrence]")[2]!, {
            clientX: 10,
            clientY: 10,
          }),
      ],
    ] as const) {
      const { container, unmount } = render(
        <Harness initial={FOUR} parentCountOf={() => 1} onDeleteEverywhere={deleteEverywhere} />,
      )
      selectRows(editorRoot(container), 1, 2)
      await act(async () => {
        await open(container)
      })
      // The bar says Unlink beside Delete here, as the menu does.
      await pick(deleteEverywhere === fromBar ? "Delete" : "Delete 2 blocks")
      unmount()
    }
    expect(fromBar).toHaveBeenCalledWith(["blk_b", "blk_c"])
    expect(fromMenu).toHaveBeenCalledWith(["blk_b", "blk_c"])
  })

  it("the per-block actions take each selected block: Add to Views adds them all", async () => {
    const { container } = render(<Harness initial={FOUR} noteId="n" />)
    selectRows(editorRoot(container), 1, 2)
    await act(async () => {
      fireEvent.contextMenu(container.querySelectorAll("[data-occurrence]")[1]!, {
        clientX: 10,
        clientY: 10,
      })
    })
    await pick("Add to Views")
    const ids = idsOf(container)
    const roots = getDefaultStore().get(viewRootIdsAtom)
    expect(ids.map((id) => roots.has(id))).toEqual([false, true, true, false])
  })
})
