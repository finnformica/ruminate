// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { parse } from "../../blocks/parse"
import type { BlockDoc } from "../../blocks/types"
import { BlockEditor } from "./block-editor"

afterEach(cleanup)

function Harness({ initial }: { initial: string }) {
  const [doc, setDoc] = useState<BlockDoc>(() => parse(initial))
  return <BlockEditor doc={doc} onChange={setDoc} />
}

const root = (container: HTMLElement) => container.querySelector<HTMLElement>('[tabindex="-1"]')!
/** The highlight surface (the line) of the row whose body reads `text`. */
function lineOf(container: HTMLElement, text: string): HTMLElement {
  const body = Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="block-body"]'),
  ).find((el) => el.textContent?.trim() === text)!
  return body.closest<HTMLElement>("[data-block-line]")!
}
const classes = (el: HTMLElement) => Array.from(el.classList)
/** Select from the row reading `from` down `steps` rows with Shift+Down. */
function selectDown(container: HTMLElement, from: string, steps: number) {
  fireEvent.click(lineOf(container, from).querySelector('[data-testid="block-body"]')!)
  for (let i = 0; i < steps; i++)
    fireEvent.keyDown(root(container), { key: "ArrowDown", shiftKey: true })
}

/**
 * How the highlight surfaces of a multi-row selection meet
 * (`selectionRunEdges`, `JoinEdge`): the classes each side takes decide
 * whether the ring stays, which corners square, and how far the surface
 * reaches into its neighbour — the whole difference between one outlined
 * shape and an outline that breaks at every step.
 */
describe("how selected rows' surfaces join", () => {
  it("two rows of one width merge: rings off, corners squared, the full reach", () => {
    const { container } = render(<Harness initial={"A\nB\nC"} />)
    selectDown(container, "A", 1)
    expect(classes(lineOf(container, "A"))).toEqual(
      expect.arrayContaining(["block-run-bottom", "rounded-b-none", "-mb-1"]),
    )
    expect(classes(lineOf(container, "B"))).toEqual(
      expect.arrayContaining(["block-run-top", "rounded-t-none", "-mt-1"]),
    )
    // The run's ends stay closed.
    expect(classes(lineOf(container, "A"))).not.toContain("block-run-top")
    expect(classes(lineOf(container, "B"))).not.toContain("block-run-bottom")
  })

  it("a parent over its child steps: the parent keeps its ring and its outer corner", () => {
    const { container } = render(<Harness initial={"A\n  B\nC"} />)
    selectDown(container, "A", 1)
    const parent = classes(lineOf(container, "A"))
    expect(parent).not.toContain("block-run-bottom")
    expect(parent).not.toContain("rounded-bl-none") // reaches past the child: rounds
    expect(parent).toContain("rounded-br-none") // lines up with the child: runs on
    expect(parent).toContain("-mb-0.5")
    const child = classes(lineOf(container, "B"))
    expect(child).toEqual(
      expect.arrayContaining(["block-run-top", "rounded-t-none", "-mt-[3px]", "pt-[3px]"]),
    )
  })

  it("a child over the row after its parent steps back: the child is raised over the wider row", () => {
    const { container } = render(<Harness initial={"A\n  B\nC"} />)
    selectDown(container, "B", 1)
    const child = classes(lineOf(container, "B"))
    // C is a root row that is not the first: 2px further away, so 5px reach.
    expect(child).toEqual(
      expect.arrayContaining([
        "block-run-bottom",
        "rounded-b-none",
        "-mb-[5px]",
        "pb-[5px]",
        "z-[1]",
      ]),
    )
    const next = classes(lineOf(container, "C"))
    expect(next).not.toContain("block-run-top")
    expect(next).not.toContain("rounded-tl-none") // reaches past the child: rounds
    expect(next).toContain("rounded-tr-none")
    expect(next).toContain("-mt-0.5")
  })

  it("a heading over its child keeps its ring and rounds both corners: it reaches past on both sides", () => {
    const { container } = render(<Harness initial={"# H\n  B\n  C"} />)
    selectDown(container, "H", 2)
    const heading = classes(lineOf(container, "H"))
    expect(heading).not.toContain("block-run-bottom")
    expect(heading).not.toContain("rounded-bl-none")
    expect(heading).not.toContain("rounded-br-none")
    expect(classes(lineOf(container, "B"))).toEqual(
      expect.arrayContaining(["block-run-top", "-mt-[3px]"]),
    )
    // The two children, one width, merge as before.
    expect(classes(lineOf(container, "B"))).toContain("block-run-bottom")
    expect(classes(lineOf(container, "C"))).toContain("block-run-top")
  })

  it("a heading with nothing under it, over a row wider to the left, does not join", () => {
    // Each side reaches past the other somewhere; neither can cover the
    // other's ring where they share an edge. Both stay closed.
    const { container } = render(<Harness initial={"A\n  # H\nC"} />)
    selectDown(container, "H", 1)
    expect(classes(lineOf(container, "H"))).not.toContain("block-run-bottom")
    expect(classes(lineOf(container, "H"))).not.toContain("rounded-br-none")
    expect(classes(lineOf(container, "C"))).not.toContain("block-run-top")
    expect(classes(lineOf(container, "C"))).not.toContain("rounded-tr-none")
  })

  it("a run never crosses a heading's top margin", () => {
    const { container } = render(<Harness initial={"A\n# H\nB"} />)
    selectDown(container, "A", 2)
    expect(classes(lineOf(container, "A"))).not.toContain("block-run-bottom")
    expect(classes(lineOf(container, "H"))).not.toContain("block-run-top")
    // Below the heading, its sibling is narrower: the heading's ring stays.
    expect(classes(lineOf(container, "H"))).not.toContain("block-run-bottom")
    expect(classes(lineOf(container, "B"))).toEqual(
      expect.arrayContaining(["block-run-top", "-mt-[5px]"]),
    )
  })
})
