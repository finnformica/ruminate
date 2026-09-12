// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { toast, Toaster } from "sonner"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { emptyBlock } from "../../blocks/ops"
import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import type { BlockDoc, ChangeHint } from "../../blocks/types"
import type { BlockRevealRequest } from "../../utils/note-outline"
import { richClipboardFormats } from "../../utils/rich-clipboard"
import { ImageUploadError, type UploadedImage } from "../../data/images"
import { BlockEditor, type BlockDebugOptions } from "./block-editor"

// The context menu (Base UI) measures its popup with a ResizeObserver and
// scrolls the highlighted item into view; jsdom implements neither.
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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
  initial = "",
  initialDoc,
  startEditing,
  zoomRootId,
  refocusSignal,
  resolveBlocks,
  debug,
  parentCountOf,
  onDeleteEverywhere,
  onImageUpload,
  onHint,
  knownBlock,
}: {
  initial?: string
  /** A doc built by hand — for shapes markdown cannot express (a shared block). */
  initialDoc?: BlockDoc
  startEditing?: boolean
  zoomRootId?: string | null
  refocusSignal?: number
  resolveBlocks?: (ids: string[]) => Record<string, string | null>
  debug?: BlockDebugOptions
  parentCountOf?: (id: string) => number
  onDeleteEverywhere?: (id: string) => void
  onImageUpload?: (file: File) => Promise<UploadedImage>
  /** Sees every change's hint (undefined when there is none). */
  onHint?: (hint: ChangeHint | undefined) => void
  knownBlock?: (id: string) => boolean
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
        startEditing={startEditing}
        zoomRootId={zoomRootId}
        refocusSignal={refocusSignal}
        resolveBlocks={resolveBlocks}
        debug={debug}
        parentCountOf={parentCountOf}
        onDeleteEverywhere={onDeleteEverywhere}
        onImageUpload={onImageUpload}
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
    // Not the first block in the note — the block Enter was pressed on.
    expect(container.querySelector("textarea")).toBeNull()
    expect(highlightedText(container)).toBe("B")
    // Redo brings the created block back and re-highlights it.
    fireEvent.keyDown(root, { key: "z", metaKey: true, shiftKey: true })
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

  it("renders only the zoomed subtree, with the block styled as itself", () => {
    const { container } = render(<Harness initial={ZOOMABLE} zoomRootId="blk_b" />)
    const bodies = Array.from(container.querySelectorAll('[data-testid="block-body"]'))
    expect(bodies.map((el) => el.textContent)).toEqual(["B", "C", "D", "E"])
    // Focus mode changes what is visible, never what a block looks like: no
    // note-title promotion — the zoomed bullet keeps its normal typography.
    expect(bodies[0].closest(".text-3xl")).toBeNull()
    // The breadcrumb is the navigation stack: a direct (deep-link) zoom knows
    // only the note and the block itself.
    expect(crumb(container)?.textContent).toContain("Note")
    expect(crumb(container)?.textContent).toContain("B")
    // Zoom-in lands on the first child, not the title.
    expect(highlightedText(container)).toBe("C")
  })

  it("the breadcrumb follows the path taken; Shift+F pops back along it", () => {
    const { container, queryByText } = render(<Harness initial={ZOOMABLE} />)
    const root = editorRoot(container)
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: "f" }) // zoom B — selection lands on C
    fireEvent.keyDown(root, { key: "f" }) // zoom C
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

  it("Shift+F from a deep-linked zoom exits fully (the path back is unknown)", () => {
    const { container, queryByText } = render(<Harness initial={ZOOMABLE} zoomRootId="blk_c" />)
    const root = editorRoot(container)
    expect(queryByText("E")).toBeNull() // C's view: title C + child D
    fireEvent.keyDown(root, { key: "F", shiftKey: true })
    // No stack below the deep link — pop leaves zoom entirely.
    expect(queryByText("A")).not.toBeNull()
    expect(crumb(container)).toBeNull()
    expect(highlightedText(container)).toBe("C")
  })

  it("a zoomed block keeps its own marker and style — heading hash, quote ink", () => {
    const heading = ["# Section", "  id:: blk_h", "  - child", "    id:: blk_hc"].join("\n")
    const zoomHeading = render(<Harness initial={heading} zoomRootId="blk_h" />)
    // The regular heading hash renders, exactly as un-zoomed — no promoted
    // note-title variant exists any more.
    expect(zoomHeading.queryByTestId("zoom-title-hash")).toBeNull()
    expect(zoomHeading.queryAllByTestId("heading-hash").length).toBeGreaterThan(0)
    const headingBody = zoomHeading
      .getAllByTestId("block-body")
      .find((el) => el.textContent === "Section")!
    expect(headingBody.closest(".text-3xl")).toBeNull()
    zoomHeading.unmount()

    // A zoomed quote keeps its secondary ink at its normal scale.
    const quote = ["> Wise words", "  id:: blk_q", "  - child", "    id:: blk_qc"].join("\n")
    const zoomQuote = render(<Harness initial={quote} zoomRootId="blk_q" />)
    const title = zoomQuote
      .getAllByTestId("block-body")
      .find((el) => el.textContent === "Wise words")!
    expect(title.className).toContain("text-text-secondary")
    expect(title.className).not.toContain("text-3xl")
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

  it("breadcrumb crumbs navigate: an earlier hop re-zooms there, the note crumb exits", () => {
    const { container, getByText, queryByText } = render(<Harness initial={ZOOMABLE} />)
    const root = editorRoot(container)
    // Walk the path by keyboard: B → C → D, so the stack is Note › B › C › D.
    selectNth(root, 1) // B
    fireEvent.keyDown(root, { key: "f" }) // zoom B, selection on C
    fireEvent.keyDown(root, { key: "f" }) // zoom C, selection on D
    fireEvent.keyDown(root, { key: "f" }) // zoom D
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

  it("is a static glyph, never a zoom button, in every view", () => {
    // The hash reads as typography (like the note title's), not a control —
    // zoom stays on F / Cmd+. and the bullet/number click targets. (A parent
    // heading's slot also hosts the collapse chevron; that is not a zoom.)
    for (const readOnly of [false, true]) {
      const { container, unmount } = render(
        <BlockEditor doc={parse(NESTED)} onChange={() => {}} readOnly={readOnly} />,
      )
      const slot = container.querySelector('[data-testid="heading-hash"]')!
      expect(slot.querySelector('button[aria-label="Zoom into block"]')).toBeNull()
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
    // The dot is the fading key; it is no longer a zoom button.
    expect(slot.querySelector(".block-key")).not.toBeNull()
    expect(slot.querySelector('button[aria-label="Zoom into block"]')).toBeNull()
    // Same for the heading's hash.
    const hashSlot = toggleOf(container, "blk_hp")!.parentElement!
    expect(hashSlot.getAttribute("data-testid")).toBe("heading-hash")
    expect(hashSlot.querySelector(".block-key")?.textContent).toBe("#")
  })

  it("a leaf bullet still zooms on click", () => {
    const { container } = render(<Harness initial={OUTLINE} />)
    const line = lineOf(container, "blk_leaf")
    expect(line.querySelector('button[aria-label="Zoom into block"]')).not.toBeNull()
    expect(line.querySelector(".block-key")).toBeNull()
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

  it("renders verbatim in a mono panel with its language, no marker key", () => {
    const { container } = render(<Harness initial={CODE} />)
    const body = container.querySelector<HTMLElement>('[data-block-id="blk_code"]')!
    expect(body.textContent).toBe("const a = 1\n  b()")
    expect(body.className).toContain("font-mono")
    expect(body.className).toContain("whitespace-pre-wrap")
    expect(container.querySelector('[data-testid="code-language"]')?.textContent).toBe("ts")
    const row = container.querySelector('[data-block-row="blk_code"]')!
    expect(row.querySelector('[data-testid="code-slot"]')).not.toBeNull()
    expect(row.querySelector(".block-key")).toBeNull()
  })

  it("Enter while editing stays in the block; Shift+Enter leaves with a block below", () => {
    const { container, getByTestId } = render(<Harness initial={CODE} />)
    const root = editorRoot(container)
    fireEvent.keyDown(root, { key: "Enter" }) // edit blk_code
    const textarea = container.querySelector("textarea")!
    expect(textarea.className).toContain("font-mono")
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

  it("never puts the ghost on the zoomed title", () => {
    const { container } = render(
      <Harness initial={"Parent\n  id:: blk_p\n  child"} zoomRootId="blk_p" />,
    )
    const root = editorRoot(container)
    // Zoom lands on the first child; ArrowUp selects the title, Enter edits it.
    fireEvent.keyDown(root, { key: "ArrowUp" })
    fireEvent.keyDown(root, { key: "Enter" })
    const textarea = container.querySelector("textarea")!
    expect(textarea.value).toBe("Parent")
    expect(textarea.placeholder).toBe("")
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

  it("opens on a row with the standard actions, and selects that row", async () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    const menu = await openMenuOn(container, 1)
    for (const label of ["Edit", "Turn into", "Duplicate", "Zoom into", "Copy", "Delete"]) {
      expect(menu.textContent).toContain(label)
    }
    // The row under the pointer becomes the selection (and the menu's target).
    expect(highlightedText(container)).toBe("B")
    // No graph behind this editor: removing the row is the delete, so Delete
    // alone, with nothing to unlink from.
    expect(menu.textContent).not.toContain("Unlink")
    expect(menu.textContent).not.toContain("places")
    // Structure moves stay on the keyboard.
    for (const label of ["Indent", "Outdent", "Move up", "Move down"]) {
      expect(menu.textContent).not.toContain(label)
    }
  })

  it("Delete removes the row (an undoable edit)", async () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB\nC"} />)
    await openMenuOn(container, 1)
    await pick("Delete")
    expect(serializedLines(getByTestId)).toEqual(["A", "C"])
    fireEvent.keyDown(editorRoot(container), { key: "z", metaKey: true })
    expect(serializedLines(getByTestId)).toEqual(["A", "B", "C"])
  })

  it("Turn into changes the block's type from the submenu", async () => {
    const { container, getByTestId } = render(<Harness initial={"A\nB"} />)
    await openMenuOn(container, 0)
    await act(async () => {
      fireEvent.click(screen.getByText("Turn into"))
    })
    await pick("Heading")
    expect(serializedLines(getByTestId)).toEqual(["# A", "B"])
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
    expect(deleteEverywhere).toHaveBeenCalledWith(id)
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
    expect(deleteEverywhere).toHaveBeenCalledWith(id)
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
})

describe("BlockEditor images", () => {
  const pngFile = () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })
  /** A paste event carrying one image file (what a pasted screenshot is). */
  const imagePaste = (files: File[]) => ({
    clipboardData: { files, types: ["Files"], getData: () => "" },
  })
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
      settle({ id: "img_abcdefghijklmnop", width: 640, height: 480 })
    })
    expect(queryByTestId("block-image-uploading")).toBeNull()
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
    expect(menu.textContent).toContain("Edit caption")
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
