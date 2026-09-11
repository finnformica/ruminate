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

  it("puts a blank line only where markdown would otherwise merge two blocks", () => {
    // Quote, bullet, todo, numbered, heading, code: none of these run into the
    // one before, so the copy is as tight as the outline — and nothing trails.
    const stored = ["> quote", "- bullet", "[ ] todo", "1. ordered", "# heading", "```", "x", "```"]
    expect(toDisplayMarkdown(stored.join("\n"))).toBe(
      ["> quote", "- bullet", "- [ ] todo", "1. ordered", "# heading", "```", "x", "```"].join(
        "\n",
      ),
    )
    // A paragraph would lazily continue a quote or a list item; a quote would
    // continue a quote.
    expect(toDisplayMarkdown("> quote\npara")).toBe("> quote\n\npara")
    expect(toDisplayMarkdown("- item\npara")).toBe("- item\n\npara")
    expect(toDisplayMarkdown("> one\n> two")).toBe("> one\n\n> two")
    // A heading is one line: what follows it needs no gap.
    expect(toDisplayMarkdown("# heading\npara")).toBe("# heading\npara")
  })

  it("keeps prose under the list item it sits in", () => {
    const stored = ["- parent", "  # heading", "  [ ] task", "  para"].join("\n")
    expect(toDisplayMarkdown(stored)).toBe(
      ["- parent", "  # heading", "  - [ ] task", "", "  para"].join("\n"),
    )
    // …but prose under prose has no shape of its own: it follows at the same
    // depth rather than indenting into a merged paragraph.
    expect(toDisplayMarkdown("para\n  child para")).toBe("para\n\nchild para")
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
