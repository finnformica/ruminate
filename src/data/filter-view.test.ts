import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import type { BlockDoc } from "../blocks/types"
import { filteredView, isNarrowed, parseSort } from "./filter-view"
import type { GraphView } from "./graph"

/** A view over a parsed outline, nothing folded — what an eager walk hands
 * `filteredView` on the page. */
function viewOf(markdown: string): GraphView {
  return { doc: parse(markdown), collapsed: new Set() }
}

/** The view as an indented outline, so a test reads like the rows do. The
 * dimmed rows (context) are marked with a leading `~`. */
function outline(doc: BlockDoc, context: ReadonlySet<string>): string[] {
  const lines: string[] = []
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block) continue
      lines.push(`${"  ".repeat(depth)}${context.has(id) ? "~" : ""}${block.text}`)
      walk(block.children, depth + 1)
    }
  }
  walk(doc.rootBlockIds, 0)
  return lines
}

const NOTE = `# Shopping
  - [ ] milk
  - [x] bread
# Chores
  - [ ] hoover
  - notes about chores
# Reading
  - a book
`

describe("isNarrowed", () => {
  it("is false for nothing, whitespace, or both absent", () => {
    expect(isNarrowed({})).toBe(false)
    expect(isNarrowed({ filter: "", sort: "" })).toBe(false)
    expect(isNarrowed({ filter: "   " })).toBe(false)
  })

  it("is true for a filter or a sort", () => {
    expect(isNarrowed({ filter: "type:todo" })).toBe(true)
    expect(isNarrowed({ sort: "text" })).toBe(true)
  })
})

describe("filteredView", () => {
  it("hands the view back untouched when nothing is narrowed", () => {
    const view = viewOf(NOTE)
    const result = filteredView(view, {})
    expect(result.doc).toBe(view.doc)
    expect(result.matches).toBe(null)
    expect(result.context.size).toBe(0)
  })

  it("keeps matches with their ancestors, and dims the ancestors", () => {
    const { doc, context, matches } = filteredView(viewOf(NOTE), { filter: "type:todo" })
    expect(outline(doc, context)).toEqual(["~Shopping", "  milk", "~Chores", "  hoover"])
    // The two to-dos matched; the headings above them are context only.
    expect(matches).toBe(2)
  })

  it("drops a branch that holds no match", () => {
    const { doc, context } = filteredView(viewOf(NOTE), { filter: "type:todo" })
    // "Reading" holds a bullet, never a to-do, so the whole branch goes.
    expect(outline(doc, context).join("\n")).not.toContain("Reading")
    expect(outline(doc, context).join("\n")).not.toContain("a book")
  })

  it("excludes with -type:", () => {
    const { doc, context } = filteredView(viewOf(NOTE), { filter: "type:task -type:done" })
    expect(outline(doc, context)).toEqual(["~Shopping", "  milk", "~Chores", "  hoover"])
  })

  it("matches either value in a comma list", () => {
    const { doc, context, matches } = filteredView(viewOf(NOTE), { filter: "type:todo,done" })
    expect(matches).toBe(3)
    expect(outline(doc, context)).toEqual(["~Shopping", "  milk", "  bread", "~Chores", "  hoover"])
  })

  it("keeps a match's own children, as context rather than matches", () => {
    const { doc, context, matches } = filteredView(
      viewOf(`- [ ] pack
  - passport
  - tickets
- a bullet
`),
      { filter: "type:todo" },
    )
    expect(outline(doc, context)).toEqual(["pack", "  ~passport", "  ~tickets"])
    // Only the to-do itself is a match; what hangs beneath it is its content.
    expect(matches).toBe(1)
  })

  it("narrows by text as well as type", () => {
    const { doc, context, matches } = filteredView(viewOf(NOTE), { filter: "type:todo milk" })
    expect(matches).toBe(1)
    expect(outline(doc, context)).toEqual(["~Shopping", "  milk"])
  })

  it("unfolds what survived, so a match is never hidden behind a fold", () => {
    const view: GraphView = { ...viewOf(NOTE), collapsed: new Set(["some-key"]) }
    expect(filteredView(view, { filter: "type:todo" }).collapsed.size).toBe(0)
  })

  it("matches nothing when the filter names a type the view has none of", () => {
    const { doc, matches } = filteredView(viewOf(NOTE), { filter: "type:quote" })
    expect(matches).toBe(0)
    expect(doc.rootBlockIds).toEqual([])
  })
})

describe("filteredView sorting", () => {
  const TREE = `- pear
  - cherry
  - apple
- fig
- damson
`

  it("orders siblings and leaves the nesting alone", () => {
    const { doc, context } = filteredView(viewOf(TREE), { sort: "text" })
    expect(outline(doc, context)).toEqual(["damson", "fig", "pear", "  apple", "  cherry"])
  })

  it("reverses on :desc", () => {
    const { doc, context } = filteredView(viewOf(TREE), { sort: "text:desc" })
    expect(outline(doc, context)).toEqual(["pear", "  cherry", "  apple", "fig", "damson"])
  })

  it("sorts and filters together, the tree surviving both", () => {
    const { doc, context } = filteredView(viewOf(NOTE), { filter: "type:task", sort: "text" })
    expect(outline(doc, context)).toEqual(["~Chores", "  hoover", "~Shopping", "  bread", "  milk"])
  })

  it("leaves a sort that names nothing alone", () => {
    const view = viewOf(TREE)
    expect(filteredView(view, { sort: "   " }).doc).toBe(view.doc)
  })
})

describe("parseSort", () => {
  it("reads a bare key, a direction, and a comma list", () => {
    expect(parseSort("text")).toEqual([{ key: "text", direction: "asc" }])
    expect(parseSort("text:desc")).toEqual([{ key: "text", direction: "desc" }])
    expect(parseSort("type,text:desc")).toEqual([
      { key: "type", direction: "asc" },
      { key: "text", direction: "desc" },
    ])
  })

  it("accepts the query language's own sort: form", () => {
    expect(parseSort("sort:text:desc")).toEqual([{ key: "text", direction: "desc" }])
  })

  it("reads nothing out of nothing", () => {
    expect(parseSort("")).toEqual([])
    expect(parseSort("  ")).toEqual([])
  })
})
