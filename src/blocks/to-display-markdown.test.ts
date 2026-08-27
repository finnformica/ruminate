import { describe, expect, it } from "vitest"
import { getBlockType } from "./block-type"
import { parse } from "./parse"
import { toDisplayMarkdown } from "./to-display-markdown"

describe("toDisplayMarkdown", () => {
  it("drops id:: lines and turns todos into GFM task items", () => {
    const stored = ["# 20-08-2026", "  id:: blk_a", "[x] Spider diagram", "  id:: blk_b"].join("\n")
    const md = toDisplayMarkdown(stored)
    expect(md).not.toContain("id::")
    expect(md).not.toContain("blk_")
    expect(md).toContain("# 20-08-2026")
    expect(md).toContain("- [x] Spider diagram")
  })

  it("keeps frontmatter and preserves list nesting", () => {
    const stored = [
      "---",
      "title: t",
      "---",
      "- parent",
      "  id:: blk_a",
      "  - child",
      "    id:: blk_b",
    ].join("\n")
    const md = toDisplayMarkdown(stored)
    expect(md.startsWith("---\ntitle: t\n---")).toBe(true)
    expect(md).toContain("- parent")
    expect(md).toContain("  - child")
  })

  it("separates prose blocks with a blank line", () => {
    const stored = ["First para", "  id:: blk_a", "Second para", "  id:: blk_b"].join("\n")
    expect(toDisplayMarkdown(stored)).toContain("First para\n\nSecond para")
  })
})

describe("copy → paste round-trip preserves block types", () => {
  // Every block type must survive copy (display markdown) → paste (parse):
  // the GFM `- [ ] task` a copy emits must come back a todo, not a bullet
  // with literal "[ ] task" text.
  const cases: [string, string][] = [
    ["# Heading", "heading"],
    ["[ ] task", "todo"],
    ["[x] done", "todo"],
    ["- bullet", "bullet"],
    ["* starred", "bullet"],
    ["1. first", "ordered"],
    ["> quote", "quote"],
    ["plain paragraph", "paragraph"],
  ]
  it.each(cases)("%s stays a %s", (content, kind) => {
    const display = toDisplayMarkdown(content)
    const doc = parse(display)
    expect(doc.rootBlockIds).toHaveLength(1)
    const parsed = doc.blocks[doc.rootBlockIds[0]].content
    expect(getBlockType(parsed).kind).toBe(kind)
    // A checked todo keeps its checked state through the trip.
    expect(getBlockType(parsed)).toEqual(getBlockType(content))
  })

  it("normalizes GFM task items (`- [ ]` / `* [x]`) to todo blocks on parse", () => {
    const doc = parse("- [ ] open\n* [x] closed")
    const [a, b] = doc.rootBlockIds.map((id) => doc.blocks[id].content)
    expect(a).toBe("[ ] open")
    expect(b).toBe("[x] closed")
    expect(getBlockType(a)).toEqual({ kind: "todo", checked: false })
    expect(getBlockType(b)).toEqual({ kind: "todo", checked: true })
  })

  it("keeps nested todo indentation through the trip", () => {
    const stored = ["- parent", "  id:: blk_a", "  [ ] child task", "    id:: blk_b"].join("\n")
    const doc = parse(toDisplayMarkdown(stored))
    const parent = doc.blocks[doc.rootBlockIds[0]]
    expect(parent.content).toBe("- parent")
    const child = doc.blocks[parent.children[0]]
    expect(getBlockType(child.content)).toEqual({ kind: "todo", checked: false })
  })
})
