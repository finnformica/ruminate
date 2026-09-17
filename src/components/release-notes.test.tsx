// @vitest-environment jsdom
import { cleanup, render, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { collateFiles, parseChangelog, type ChangelogRelease } from "../utils/changelog"
import { loadChangelog } from "../utils/changelog-source"
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

describe("a week collated from several files", () => {
  /** A week written by `leads.length` branches, one entry each — the ordinary
   * case (docs/changelog.md): each file's first bullet sits at the same line
   * number as every other file's. */
  const week = (name: string, leads: string[]) =>
    collateFiles(
      leads.map((lead, i) => ({
        path: `changelog/${name}/branch-${i}.md`,
        text: `### Changed\n\n- ${lead} Detail for ${lead}\n`,
      })),
    ).releases[0]

  const leadsOf = (container: HTMLElement) =>
    [...container.querySelectorAll("h4")].map((h) => h.textContent)

  /** What a release draws from a clean mount — the reference any amount of
   * switching back and forth has to agree with. */
  const drawnFresh = (release: ChangelogRelease) => {
    const { container, unmount } = render(<ReleaseNotes release={release} />)
    const leads = leadsOf(container)
    unmount()
    return leads
  }

  it("gives every entry the same line number, which is why none of them is a key", () => {
    // Not incidental: a line number is only unique within its own file, and a
    // release is many files. If this ever stops being true the note on the
    // `key` in release-notes.tsx can go.
    expect(week("2026-W38", ["Alpha.", "Beta.", "Gamma."]).sections[0].entries.map((e) => e.line)) //
      .toEqual([3, 3, 3])
  })

  it("draws each entry once", () => {
    const { container } = draw()
    const shown = week("2026-W38", ["Alpha.", "Beta.", "Gamma."])
    const drawn = render(<ReleaseNotes release={shown} />)
    expect(leadsOf(drawn.container)).toEqual(["Alpha.", "Beta.", "Gamma."])
    expect(container).toBeTruthy()
  })

  it("does not leave entries behind when the week on screen changes", () => {
    // What the page does when a week is picked in the rail, over the real
    // changelog — the shape that actually broke. Keyed by their line number
    // the outgoing week's rows stayed put and the list grew on every switch,
    // until the same change was on screen three times over, and entries from
    // one week turned up under another's date.
    const releases = loadChangelog()
    expect(releases.length).toBeGreaterThan(2)
    const newest = drawnFresh(releases[0])
    expect(newest.length).toBeGreaterThan(0)

    const { container, rerender } = render(<ReleaseNotes release={releases[0]} />)
    for (const at of [1, 0, 2, 0, releases.length - 1, 0]) {
      rerender(<ReleaseNotes release={releases[at]} />)
    }
    const shown = leadsOf(container)
    expect(shown).toEqual(newest)
    expect(new Set(shown).size).toBe(shown.length)
  })
})
