import { describe, expect, it } from "vitest"
import { parse } from "./parse"
import type { BlockType } from "./types"
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

  it("drops frontmatter and preserves list nesting", () => {
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
    expect(md).not.toContain("---")
    expect(md).not.toContain("title")
    expect(md).toContain("- parent")
    expect(md).toContain("  - child")
  })

  it("writes a code block as its fence, language and lines verbatim", () => {
    const stored = [
      "```py",
      "print(1)",
      "  x",
      "```",
      "  id:: blk_a",
      "- after",
      "  id:: blk_b",
    ].join("\n")
    const md = toDisplayMarkdown(stored)
    expect(md).toContain("```py\nprint(1)\n  x\n```")
    expect(md).not.toContain("id::")
    const back = parse(md)
    const code = back.blocks[back.rootBlockIds[0]]
    expect(code.type).toBe("code")
    expect(code.props).toEqual({ language: "py" })
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
  const cases: [string, BlockType][] = [
    ["# Heading", "h1"],
    ["[ ] task", "todo"],
    // A checked todo keeps its checked state through the trip.
    ["[x] done", "done"],
    ["- bullet", "ul"],
    ["* starred", "ul"],
    ["1. first", "ol"],
    ["> quote", "quote"],
    ["plain paragraph", "text"],
  ]
  it.each(cases)("%s stays a %s", (content, type) => {
    const display = toDisplayMarkdown(content)
    const doc = parse(display)
    expect(doc.rootBlockIds).toHaveLength(1)
    expect(doc.blocks[doc.rootBlockIds[0]].type).toBe(type)
  })

  it("normalizes GFM task items (`- [ ]` / `* [x]`) to todo blocks on parse", () => {
    const doc = parse("- [ ] open\n* [x] closed")
    const [a, b] = doc.rootBlockIds.map((id) => doc.blocks[id])
    expect([a.type, a.text]).toEqual(["todo", "open"])
    expect([b.type, b.text]).toEqual(["done", "closed"])
  })

  it("keeps nested todo indentation through the trip", () => {
    const stored = ["- parent", "  id:: blk_a", "  [ ] child task", "    id:: blk_b"].join("\n")
    const doc = parse(toDisplayMarkdown(stored))
    const parent = doc.blocks[doc.rootBlockIds[0]]
    expect(parent.type).toBe("ul")
    expect(parent.text).toBe("parent")
    const child = doc.blocks[parent.children[0]]
    expect(child.type).toBe("todo")
    expect(child.text).toBe("child task")
  })
})
