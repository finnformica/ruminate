import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { getHeadings } from "./headings"
import { buildOutline, filterOutline } from "./note-outline"

describe("buildOutline", () => {
  it("finds nested (indented) headings that the on-disk regex misses", () => {
    // In the block format, a nested heading is indented — getHeadings' regex
    // is anchored at column 0 and misses it, which is exactly why the palette
    // builds its outline from the live doc instead.
    const content = "# Top\n  ## Nested\n    para\n  ## Second"
    expect(getHeadings(content).map((h) => h.text)).toEqual(["Top"])
    expect(buildOutline(parse(content)).map((item) => item.text)).toEqual([
      "Top",
      "Nested",
      "Second",
    ])
  })

  it("gives duplicate heading texts distinct block ids", () => {
    const items = buildOutline(parse("# Same\n# Same"))
    expect(items).toHaveLength(2)
    expect(items[0].text).toBe("Same")
    expect(items[1].text).toBe("Same")
    expect(items[0].id).not.toBe(items[1].id)
  })

  it("counts depth as ancestor headings, not raw tree depth", () => {
    // A heading under a bullet is tree-depth 1 but has no heading ancestors —
    // the outline should read as heading nesting.
    const items = buildOutline(parse("- bullet\n  # Under bullet\n    # Deeper"))
    expect(items.map(({ text, depth }) => ({ text, depth }))).toEqual([
      { text: "Under bullet", depth: 0 },
      { text: "Deeper", depth: 1 },
    ])
  })

  it("skips non-heading blocks and empty headings", () => {
    const items = buildOutline(parse("# Real\nparagraph\n- bullet\n[ ] todo\n> quote\n# "))
    expect(items.map((item) => item.text)).toEqual(["Real"])
  })

  it("keeps document order across a mixed tree", () => {
    const doc = parse(["# A", "  text", "  # B", "# C", "  - item", "    # D"].join("\n"))
    expect(buildOutline(doc).map(({ text, depth }) => `${text}:${depth}`)).toEqual([
      "A:0",
      "B:1",
      "C:0",
      "D:1",
    ])
  })
})

describe("filterOutline", () => {
  const items = buildOutline(
    parse(["# Setup", "  # Install", "    # Homebrew", "  # Configure", "# Usage"].join("\n")),
  )

  it("returns every heading in document order (with ancestor paths) for an empty query", () => {
    const results = filterOutline(items, "")
    expect(results.map((r) => r.text)).toEqual([
      "Setup",
      "Install",
      "Homebrew",
      "Configure",
      "Usage",
    ])
    expect(results[2].path).toEqual(["Setup", "Install"])
    expect(results[0].path).toEqual([])
  })

  it("matches heading text case-insensitively", () => {
    const results = filterOutline(items, "homebrew")
    expect(results.map((r) => r.text)).toContain("Homebrew")
  })

  it("matches through the ancestor path", () => {
    // "install" appears in Homebrew's ancestor path, so the child is found by
    // its parent's name.
    const texts = filterOutline(items, "install").map((r) => r.text)
    expect(texts).toContain("Install")
    expect(texts).toContain("Homebrew")
  })

  it("keeps duplicate heading texts distinct through their ids", () => {
    const dup = buildOutline(parse("# Notes\n  # Ideas\n# Archive\n  # Ideas"))
    const results = filterOutline(dup, "ideas")
    const ideaResults = results.filter((r) => r.text === "Ideas")
    expect(ideaResults).toHaveLength(2)
    expect(ideaResults[0].id).not.toBe(ideaResults[1].id)
    expect(ideaResults.map((r) => r.path.join(" › ")).sort()).toEqual(["Archive", "Notes"])
  })
})
