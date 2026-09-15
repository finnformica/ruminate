// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Unlike block-note-editor.test.tsx, the collapse state is REAL here: what
// these tests pin is that a read-only note folds to the reader's default
// depth (src/data/view-state.ts) exactly as an editable one does.
vi.mock("../../global-state", async () => {
  const { atom } = await import("jotai")
  return {
    noteOutlineAtom: atom(null),
    blockRevealAtom: atom(null),
    graphSnapshotAtom: atom({ nodes: new Map(), childLinks: new Map() }),
    githubUserAtom: atom(null),
    isDatabaseModeAtom: atom(false),
    newBlockMarkerAtom: atom("- "),
    expandedLevelsAtom: atom(2),
  }
})

import { parse } from "../../blocks/parse"
import { BlockNoteEditor } from "./block-note-editor"

Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup)
beforeEach(() => localStorage.clear())

/** Two levels open by default: `three` starts folded away under `two`. Ids
 * are pinned, as a real note's are, so folds stored between renders apply. */
const DEEP = [
  "- one",
  "  id:: blk_one",
  "  - two",
  "    id:: blk_two",
  "    - three",
  "      id:: blk_three",
  "      - four",
  "        id:: blk_four",
  "- five",
  "  id:: blk_five",
  "",
].join("\n")

const rows = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('[data-testid="block-body"]'))
    .filter((el) => !el.closest("[data-folding]"))
    .map((el) => el.textContent ?? "")
const editor = (container: HTMLElement) => container.querySelector<HTMLElement>("[tabindex]")!
const highlighted = (container: HTMLElement) =>
  container.querySelector(".bg-bg-secondary")?.querySelector('[data-testid="block-body"]')
    ?.textContent ?? null

/** A note someone shared with the reader: the note page's read-only editor. */
function renderShared(onChange = vi.fn()) {
  const rendered = render(
    <BlockNoteEditor doc={parse(DEEP)} onChange={onChange} noteId="theirs" readOnly browse />,
  )
  return { onChange, ...rendered }
}

describe("a shared note (read-only, browsed)", () => {
  it("opens folded to the default depth, like the reader's own notes", () => {
    const { container } = renderShared()
    expect(rows(container)).toEqual(["one", "two", "five"])
  })

  it("moves through the rows and folds them from the keyboard", () => {
    const { container, onChange } = renderShared()
    const root = editor(container)
    // The first row starts highlighted, as in the reader's own notes.
    expect(highlighted(container)).toBe("one")
    fireEvent.keyDown(root, { key: "ArrowDown" })
    expect(highlighted(container)).toBe("two")
    fireEvent.keyDown(root, { key: "ArrowRight" }) // unfold two
    expect(rows(container)).toEqual(["one", "two", "three", "five"])
    fireEvent.keyDown(root, { key: " " }) // fold it again
    expect(rows(container)).toEqual(["one", "two", "five"])
    expect(onChange).not.toHaveBeenCalled()
  })

  it("a click highlights a row, its bullet zooms; nothing edits or removes", () => {
    const { container, getByText, onChange } = renderShared()
    fireEvent.click(getByText("five"))
    expect(highlighted(container)).toBe("five")
    // A leaf's bullet is the zoom target it is in an editable note.
    expect(
      getByText("five")
        .closest("[data-block-row]")
        ?.querySelector('[aria-label="Zoom into block"]'),
    ).not.toBeNull()
    const root = editor(container)
    fireEvent.keyDown(root, { key: "Enter" })
    expect(container.querySelector("textarea")).toBeNull()
    fireEvent.keyDown(root, { key: "Backspace" })
    fireEvent.keyDown(root, { key: "Tab" })
    expect(rows(container)).toEqual(["one", "two", "five"])
    expect(onChange).not.toHaveBeenCalled()
  })

  it("the reader's folds are their own, kept per device", () => {
    const first = renderShared()
    fireEvent.click(first.container.querySelectorAll('[aria-label="Collapse"]')[0])
    expect(rows(first.container)).toEqual(["one", "five"])
    cleanup()
    const again = renderShared()
    expect(rows(again.container)).toEqual(["one", "five"])
  })
})
