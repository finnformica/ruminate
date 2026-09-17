// @vitest-environment jsdom
import { cleanup, render, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { parseChangelog } from "../utils/changelog"
import { ReleaseNotes } from "./release-notes"

afterEach(cleanup)

const SOURCE = `# Changelog

## 2026-W38

### Added

- Pin a block. **Pin** in a block's right-click menu lists it in the sidebar.
- <kbd>⌘</kbd> <kbd>K</kbd> searches everything. Type \`in:\` to look inside the open note.

### Fixed

- A copied to-do keeps its box.
`

const [release] = parseChangelog(SOURCE).releases

function draw() {
  return render(<ReleaseNotes release={release} />)
}

describe("a release", () => {
  it("heads itself with the dates it covers, above the categories", () => {
    const { container } = draw()
    const dates = container.querySelector("h2")
    expect(dates?.textContent).toContain("September")
    // The categories sit under it, not beside it.
    expect(container.querySelector("h2")?.compareDocumentPosition(container.querySelector("h3")!)) //
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect([...container.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "Added",
      "Fixed",
    ])
  })

  it("says which week it is and how many changes it carries", () => {
    const { getByText } = draw()
    expect(getByText(/2026-W38 · 3 changes/)).toBeTruthy()
  })

  it("counts one change in the singular", () => {
    const [one] = parseChangelog(
      "# Changelog\n\n## 2026-W38\n\n### Fixed\n\n- Just the one.\n",
    ).releases
    const { getByText } = render(<ReleaseNotes release={one} />)
    expect(getByText(/1 change$/)).toBeTruthy()
  })
})

describe("an entry", () => {
  it("heads the detail with the lead rather than running the two together", () => {
    // The lead names the change, so it is a heading of its own — not a bold
    // opening clause of the paragraph it introduces.
    const { container } = draw()
    const lead = container.querySelector("h4")
    expect(lead?.textContent).toBe("Pin a block.")
    const detail = lead?.nextElementSibling
    expect(detail?.tagName).toBe("P")
    expect(detail?.textContent).toContain("right-click menu")
    // And they are separate elements: no run-on.
    expect(lead?.textContent).not.toContain("right-click menu")
  })

  it("draws the lead above its detail for every entry", () => {
    const { container } = draw()
    expect([...container.querySelectorAll("h4")].map((h) => h.textContent)).toEqual([
      "Pin a block.",
      "⌘K searches everything.",
      "A copied to-do keeps its box.",
    ])
  })

  it("leaves an entry with no detail as a heading alone", () => {
    const { container } = draw()
    const [, , boxed] = container.querySelectorAll("h4")
    expect(boxed.nextElementSibling).toBeNull()
  })

  it("still draws keycaps and inline markdown, in the lead and the detail alike", () => {
    const { container } = draw()
    const [, shortcut] = container.querySelectorAll("h4")
    expect(within(shortcut as HTMLElement).getAllByText(/^[⌘K]$/)).toHaveLength(2)
    const detail = shortcut.nextElementSibling as HTMLElement
    expect(detail.querySelector("code")?.textContent).toBe("in:")
    // The bold in the first entry's detail survives the split.
    const [first] = container.querySelectorAll("h4")
    expect((first.nextElementSibling as HTMLElement).querySelector("strong")?.textContent).toBe(
      "Pin",
    )
  })
})
