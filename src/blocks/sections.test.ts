import { describe, expect, it } from "vitest"
import { parseWithLevels } from "./parse"
import { lastBlockPath, sectionUnderHeadings } from "./sections"
import type { BlockDoc } from "./types"

/** The doc as indented lines, `#` for a heading of any level. */
function outline(doc: BlockDoc): string[] {
  const lines: string[] = []
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      const marker = block.type.startsWith("h") ? "# " : block.type === "ul" ? "- " : ""
      lines.push("  ".repeat(depth) + marker + block.text)
      walk(block.children, depth + 1)
    }
  }
  walk(doc.rootBlockIds, 0)
  return lines
}

/** Parse markdown and section it, as paste does. */
function sectioned(markdown: string): string[] {
  const { doc, headingLevels } = parseWithLevels(markdown)
  return outline(sectionUnderHeadings(doc, headingLevels))
}

describe("sectionUnderHeadings", () => {
  it("nests what follows a heading under it, up to the next heading", () => {
    expect(
      sectioned(
        [
          "### Launch Plan",
          "- Go-live target",
          "  - Window: 7–9 AM UK",
          "- Soft go-live first",
          "### Next Steps",
          "- Make copy changes",
        ].join("\n"),
      ),
    ).toEqual([
      "# Launch Plan",
      "  - Go-live target",
      "    - Window: 7–9 AM UK",
      "  - Soft go-live first",
      "# Next Steps",
      "  - Make copy changes",
    ])
  })

  it("leaves a heading that already has children as the source wrote it", () => {
    expect(sectioned(["# Plan", "  - inside", "- after"].join("\n"))).toEqual([
      "# Plan",
      "  - inside",
      "- after",
    ])
  })

  it("nests a deeper heading in the section above it, with its own section", () => {
    expect(
      sectioned(
        [
          "## Launch",
          "### Timing",
          "- 7–9 AM",
          "### Copy",
          "- remove line",
          "## Marketing",
          "- SEO",
        ].join("\n"),
      ),
    ).toEqual([
      "# Launch",
      "  # Timing",
      "    - 7–9 AM",
      "  # Copy",
      "    - remove line",
      "# Marketing",
      "  - SEO",
    ])
  })

  it("treats a skipped level as any deeper heading", () => {
    expect(sectioned(["# Top", "### Deep", "- a", "# Next"].join("\n"))).toEqual([
      "# Top",
      "  # Deep",
      "    - a",
      "# Next",
    ])
  })

  it("ends a deeper section at a shallower heading even with no section above it", () => {
    expect(sectioned(["### Small", "- a", "## Bigger", "- b"].join("\n"))).toEqual([
      "# Small",
      "  - a",
      "# Bigger",
      "  - b",
    ])
  })

  it("levels past three (`####`) still nest under shallower ones", () => {
    expect(sectioned(["### Three", "#### Four", "- a"].join("\n"))).toEqual([
      "# Three",
      "  # Four",
      "    - a",
    ])
  })

  it("keeps content before the first heading where it was", () => {
    expect(sectioned(["intro", "- point", "# Section", "- a"].join("\n"))).toEqual([
      "intro",
      "- point",
      "# Section",
      "  - a",
    ])
  })

  it("gives consecutive headings of one level nothing, and the last one what follows", () => {
    expect(sectioned(["# One", "# Two", "- a"].join("\n"))).toEqual(["# One", "# Two", "  - a"])
  })

  it("leaves a heading at the very end with nothing to gather", () => {
    expect(sectioned(["- a", "# Last"].join("\n"))).toEqual(["- a", "# Last"])
  })

  it("lets a heading with children still end an open section of its level", () => {
    expect(sectioned(["# A", "- a", "# B", "  - own", "- after"].join("\n"))).toEqual([
      "# A",
      "  - a",
      "# B",
      "  - own",
      "- after",
    ])
  })

  it("ends every open section at a thematic break, which stays as written", () => {
    expect(sectioned(["# A", "## B", "- b", "---", "- after"].join("\n"))).toEqual([
      "# A",
      "  # B",
      "    - b",
      "---",
      "- after",
    ])
    expect(sectioned(["# A", "- a", "***", "x", "___", "y"].join("\n"))).toEqual([
      "# A",
      "  - a",
      "***",
      "x",
      "___",
      "y",
    ])
  })

  it("only gathers siblings: a heading inside a list never reaches its parent's level", () => {
    expect(sectioned(["- parent", "  - # Inner", "  - child", "- next"].join("\n"))).toEqual([
      "- parent",
      "  # Inner",
      "    - child",
      "- next",
    ])
  })

  it("sections inside a heading's own children too", () => {
    expect(
      sectioned(["- wrapper", "  # Part", "  - a", "  # Part two", "  - b"].join("\n")),
    ).toEqual(["- wrapper", "  # Part", "    - a", "  # Part two", "    - b"])
  })

  it("does not read `#` lines inside a code fence as headings", () => {
    const { doc, headingLevels } = parseWithLevels(
      ["# Code", "```sh", "# comment", "```", "- after"].join("\n"),
    )
    const out = sectionUnderHeadings(doc, headingLevels)
    expect(out.rootBlockIds).toHaveLength(1)
    const heading = out.blocks[out.rootBlockIds[0]]
    expect(heading.children.map((id) => out.blocks[id].type)).toEqual(["code", "ul"])
    expect(out.blocks[heading.children[0]].text).toBe("# comment")
  })

  it("leaves a paste with no headings exactly as it was", () => {
    const { doc, headingLevels } = parseWithLevels(["a", "- b", "  - c"].join("\n"))
    expect(sectionUnderHeadings(doc, headingLevels)).toEqual(doc)
  })

  it("never opens a section on a heading named closed", () => {
    const { doc, headingLevels } = parseWithLevels(["# Mine", "- a", "# Pasted", "- b"].join("\n"))
    const out = sectionUnderHeadings(doc, headingLevels, new Set([doc.rootBlockIds[0]]))
    expect(outline(out)).toEqual(["# Mine", "- a", "# Pasted", "  - b"])
  })

  it("reads a heading's level from its type when the levels are not given", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a", "b", "c"],
      blocks: {
        a: { id: "a", type: "h2", text: "Two", children: [] },
        b: { id: "b", type: "h3", text: "Three", children: [] },
        c: { id: "c", type: "text", text: "x", children: [] },
      },
    }
    expect(outline(sectionUnderHeadings(doc))).toEqual(["# Two", "  # Three", "    x"])
  })

  it("does not change the doc it was given", () => {
    const { doc, headingLevels } = parseWithLevels(["# A", "- a"].join("\n"))
    const before = structuredClone(doc)
    sectionUnderHeadings(doc, headingLevels)
    expect(doc).toEqual(before)
  })
})

describe("lastBlockPath", () => {
  it("follows the last child down to the last block in reading order", () => {
    const { doc, headingLevels } = parseWithLevels(["# A", "- a", "# B", "- b", "- c"].join("\n"))
    const out = sectionUnderHeadings(doc, headingLevels)
    const path = lastBlockPath(out, out.rootBlockIds[1])
    expect(path.map((id) => out.blocks[id].text)).toEqual(["B", "c"])
  })

  it("is just the root for a leaf", () => {
    const { doc } = parseWithLevels("solo")
    expect(lastBlockPath(doc, doc.rootBlockIds[0])).toEqual(doc.rootBlockIds)
  })
})
