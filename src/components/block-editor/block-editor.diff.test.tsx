// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Block, BlockDoc } from "../../blocks/types"
import type { DiffMark } from "../../data/day-changes"
import { BlockEditor } from "./block-editor"

Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup)

const block = (id: string, text: string, children: string[] = []): Block => ({
  id,
  type: "text",
  text,
  children,
})

/** The outline a past day leaves (`src/data/day-changes.ts`): one row kept,
 * one reworded, one removed, one added beneath it, and a fold at the end. */
const doc: BlockDoc = {
  props: null,
  rootBlockIds: ["keep", "changed", "gone", "new", "fold:root:x"],
  blocks: {
    keep: block("keep", "Call the bank"),
    changed: block("changed", "Buy sourdough"),
    gone: block("gone", "Call mum"),
    new: block("new", "Walk along the canal", ["deep"]),
    deep: block("deep", "Take the camera"),
    "fold:root:x": block("fold:root:x", ""),
  },
}
const marks = new Map<string, DiffMark>([
  [
    "changed",
    {
      kind: "changed",
      words: [
        { kind: "same", text: "Buy " },
        { kind: "removed", text: "bread" },
        { kind: "added", text: "sourdough" },
      ],
    },
  ],
  ["gone", { kind: "removed" }],
  ["new", { kind: "added" }],
  ["deep", { kind: "added" }],
  ["fold:root:x", { kind: "fold", count: 4, hidden: ["x", "y"] }],
])

const signsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-testid=diff-sign]")).map(
    (sign) => `${sign.getAttribute("data-diff")} ${sign.textContent}`,
  )

const rowOf = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-block-row="${id}"]`)!

describe("the block editor drawing a diff", () => {
  it("puts a sign at the edge of every row, in the one column whatever the depth", () => {
    const { container } = render(
      <BlockEditor doc={doc} onChange={() => {}} readOnly browse diff={{ marks }} />,
    )
    expect(signsOf(container)).toEqual([
      "same ",
      "changed ~",
      "removed −",
      "added +",
      "added +",
      "fold ⋯",
    ])
    // The sign hangs in the gutter of its own row, which indents inside of
    // it, so the nested row's sign is where the root rows' are.
    const deepSign = rowOf(container, "deep").querySelector("[data-testid=diff-sign]")!
    expect(deepSign.className).toContain("-left-6")
    expect(rowOf(container, "deep").style.paddingLeft).not.toBe("0px")
  })

  it("tints a whole row added or removed, and says a changed row in its words", () => {
    const { container } = render(
      <BlockEditor doc={doc} onChange={() => {}} readOnly browse diff={{ marks }} />,
    )
    expect(rowOf(container, "new").innerHTML).toContain("bg-bg-added")
    expect(rowOf(container, "gone").innerHTML).toContain("bg-bg-removed")
    const changed = rowOf(container, "changed")
    expect(changed.innerHTML).not.toContain("bg-bg-added ")
    expect(changed.querySelector("del")?.textContent).toBe("bread")
    expect(changed.querySelector("ins")?.textContent).toBe("sourdough")
    expect(changed.textContent).toContain("Buy breadsourdough")
    expect(rowOf(container, "keep").querySelector("del, ins")).toBeNull()
  })

  it("draws a fold as one quiet row that opens on a click", () => {
    const expandFold = vi.fn()
    const { container } = render(
      <BlockEditor doc={doc} onChange={() => {}} readOnly browse diff={{ marks, expandFold }} />,
    )
    const fold = container.querySelector<HTMLElement>("[data-testid=diff-fold]")!
    expect(fold.textContent).toBe("4 unchanged rows")
    fireEvent.click(fold)
    expect(expandFold).toHaveBeenCalledWith("fold:root:x")
  })

  it("leaves the gutter alone when the outline is not a diff", () => {
    const { container } = render(<BlockEditor doc={doc} onChange={() => {}} readOnly />)
    expect(container.querySelector("[data-testid=diff-sign]")).toBeNull()
    expect(container.querySelector("[data-testid=diff-fold]")).toBeNull()
  })
})
