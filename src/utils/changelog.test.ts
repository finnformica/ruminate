import { describe, expect, test } from "vitest"
import {
  parseChangelog,
  parseFragment,
  renderRelease,
  splitLead,
  toReleaseWeek,
  visibleLength,
} from "./changelog"

const WELL_FORMED = `# Changelog

## 2026-W38

### Added

- A thing you can do now. And what it means for you.

### Fixed

- A thing that used to go wrong.

## 2026-W37

### Changed

- Something works differently.
`

describe("splitLead", () => {
  test("takes the first sentence, and leaves the rest as detail", () => {
    expect(splitLead("One thing. Then another. And a third.")).toEqual({
      lead: "One thing.",
      detail: "Then another. And a third.",
    })
  })

  test("a single sentence has no detail", () => {
    expect(splitLead("Only this.")).toEqual({ lead: "Only this.", detail: "" })
  })

  test("a full stop inside a code span does not end the lead", () => {
    expect(splitLead("`node.js` stays a word. Detail.")).toEqual({
      lead: "`node.js` stays a word.",
      detail: "Detail.",
    })
  })

  test("text with no full stop is all lead, so the rule can catch it", () => {
    expect(splitLead("No full stop here")).toEqual({ lead: "No full stop here", detail: "" })
  })
})

describe("visibleLength", () => {
  test("keycaps, emphasis and code marks do not count", () => {
    expect(visibleLength("<kbd>a</kbd>")).toBe(1)
    expect(visibleLength("**bold** and `code`")).toBe(13)
  })

  test("a link counts as the words it shows, not its address", () => {
    expect(visibleLength("[example](https://example.com/a/b/c)")).toBe(7)
  })
})

describe("parseChangelog", () => {
  test("reads a well-formed file with nothing to report", () => {
    const { releases, problems } = parseChangelog(WELL_FORMED)
    expect(problems).toEqual([])
    expect(releases.map((release) => release.week)).toEqual(["2026-W38", "2026-W37"])
    expect(releases[0].sections.map((section) => section.category)).toEqual(["Added", "Fixed"])
    expect(releases[0].sections[0].entries[0]).toMatchObject({
      lead: "A thing you can do now.",
      detail: "And what it means for you.",
    })
  })

  test("catches a category used twice in one release", () => {
    const { problems } = parseChangelog(
      "# Changelog\n\n## 2026-W38\n\n### Added\n\n- One.\n\n### Added\n\n- Two.\n",
    )
    expect(problems).toHaveLength(1)
    expect(problems[0].message).toContain("more than one")
  })

  test("catches releases out of order, and a week listed twice", () => {
    const older =
      "# Changelog\n\n## 2026-W37\n\n### Added\n\n- One.\n\n## 2026-W38\n\n### Added\n\n- Two.\n"
    expect(parseChangelog(older).problems[0].message).toContain("newest first")
    const twice =
      "# Changelog\n\n## 2026-W38\n\n### Added\n\n- One.\n\n## 2026-W38\n\n### Added\n\n- Two.\n"
    expect(parseChangelog(twice).problems[0].message).toContain("more than once")
  })

  test("catches a category that is not one of ours, and keeps parsing", () => {
    const { releases, problems } = parseChangelog(
      "# Changelog\n\n## 2026-W38\n\n### Improved\n\n- One.\n\n### Fixed\n\n- Two.\n",
    )
    expect(problems[0].message).toContain("is not a category")
    expect(releases[0].sections.map((section) => section.category)).toEqual(["Fixed"])
  })

  test("catches categories written out of order", () => {
    const { problems } = parseChangelog(
      "# Changelog\n\n## 2026-W38\n\n### Fixed\n\n- One.\n\n### Added\n\n- Two.\n",
    )
    expect(problems[0].message).toContain("sits below")
  })

  test("catches a blank line splitting one category's entries in two", () => {
    const { problems } = parseChangelog(
      "# Changelog\n\n## 2026-W38\n\n### Added\n\n- One.\n\n- Two.\n",
    )
    expect(problems).toHaveLength(1)
    expect(problems[0].message).toContain("blank line")
  })

  test("catches an entry with no category above it", () => {
    const { problems } = parseChangelog("# Changelog\n\n## 2026-W38\n\n- One.\n")
    expect(problems[0].message).toContain("outside a category")
  })

  test("catches a missing title", () => {
    const { problems } = parseChangelog("## 2026-W38\n\n### Added\n\n- One.\n")
    expect(problems.some((problem) => problem.message.includes("# Changelog"))).toBe(true)
  })
})

describe("parseFragment", () => {
  test("reads a branch's entries, with no week of their own", () => {
    const { sections, problems } = parseFragment("### Added\n\n- One thing. Detail.\n")
    expect(problems).toEqual([])
    expect(sections).toHaveLength(1)
    expect(sections[0].category).toBe("Added")
    expect(sections[0].entries[0].lead).toBe("One thing.")
  })

  test("holds a fragment to the changelog's own rules", () => {
    const { problems } = parseFragment("### Improved\n\n- One thing.\n")
    expect(problems[0].message).toContain("is not a category")
  })

  test("points a fault at the fragment's own lines", () => {
    const { problems } = parseFragment("### Added\n\n- One.\n\n### Added\n\n- Two.\n")
    expect(problems[0].line).toBe(5)
  })
})

describe("toReleaseWeek", () => {
  test("names the ISO week a date falls in", () => {
    expect(toReleaseWeek(new Date(2026, 8, 16))).toBe("2026-W38")
    expect(toReleaseWeek(new Date(2026, 0, 1))).toBe("2026-W01")
  })

  test("a year's last days can belong to the next year's first week", () => {
    // 2025-12-29 is the Monday of the week holding 2026-01-01.
    expect(toReleaseWeek(new Date(2025, 11, 29))).toBe("2026-W01")
  })
})

describe("renderRelease", () => {
  test("writes a release back out, categories in their canonical order", () => {
    const { releases } = parseChangelog(
      "# Changelog\n\n## 2026-W38\n\n### Added\n\n- One.\n\n### Fixed\n\n- Two.\n",
    )
    expect(renderRelease({ ...releases[0], sections: [...releases[0].sections].reverse() })).toBe(
      "## 2026-W38\n\n### Added\n\n- One.\n\n### Fixed\n\n- Two.\n",
    )
  })

  test("what it writes reads back as what it was given", () => {
    const source = "# Changelog\n\n## 2026-W38\n\n### Added\n\n- One. Detail.\n- Two.\n"
    const { releases } = parseChangelog(source)
    expect(parseChangelog(`# Changelog\n\n${renderRelease(releases[0])}`).problems).toEqual([])
  })
})
