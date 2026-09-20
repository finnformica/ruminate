import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import type { BlockDoc } from "../blocks/types"
import type { ViewNarrowing } from "../utils/view-narrowing"
import { filteredView, isNarrowed } from "./filter-view"
import type { GraphView } from "./graph"

/**
 * The SHAPE of a narrowed view — what survives the prune, what is kept as
 * dimmed context, and where a sort is applied. What a query *means* is not
 * decided here: it arrives already resolved as a `ViewNarrowing`, which is
 * why these tests hand one over directly. The vocabulary itself is held by
 * the search engine's own tests, and end to end in `hooks/note-doc.test.tsx`.
 */

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

/** A narrowing that matches the rows whose text is in `texts`. */
function matching(doc: BlockDoc, texts: string[]): ViewNarrowing {
  const ids = Object.values(doc.blocks)
    .filter((block) => texts.includes(block.text))
    .map((block) => block.id)
  return { matched: new Set(ids), compare: null }
}

/** A narrowing that orders siblings by their text. */
function byText(doc: BlockDoc, direction: "asc" | "desc" = "asc"): ViewNarrowing {
  const sign = direction === "desc" ? -1 : 1
  return {
    matched: null,
    compare: (a, b) => sign * (doc.blocks[a]?.text ?? "").localeCompare(doc.blocks[b]?.text ?? ""),
  }
}

const NOTHING: ViewNarrowing = { matched: null, compare: null }

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
  it("is false when there is neither a filter nor a sort", () => {
    expect(isNarrowed(NOTHING)).toBe(false)
  })

  it("is true for either", () => {
    expect(isNarrowed({ matched: new Set(), compare: null })).toBe(true)
    expect(isNarrowed({ matched: null, compare: () => 0 })).toBe(true)
  })
})

describe("filteredView", () => {
  it("hands the view back untouched when nothing is narrowed", () => {
    const view = viewOf(NOTE)
    const result = filteredView(view, NOTHING)
    expect(result.doc).toBe(view.doc)
    expect(result.matches).toBe(null)
    expect(result.context.size).toBe(0)
  })

  it("keeps matches with their ancestors, and dims the ancestors", () => {
    const view = viewOf(NOTE)
    const { doc, context, matches } = filteredView(view, matching(view.doc, ["milk", "hoover"]))
    expect(outline(doc, context)).toEqual(["~Shopping", "  milk", "~Chores", "  hoover"])
    // The two rows matched; the headings above them are context only.
    expect(matches).toBe(2)
  })

  it("drops a branch that holds no match", () => {
    const view = viewOf(NOTE)
    const { doc, context } = filteredView(view, matching(view.doc, ["milk"]))
    expect(outline(doc, context).join("\n")).not.toContain("Reading")
    expect(outline(doc, context).join("\n")).not.toContain("a book")
  })

  it("keeps a match's own children, as context rather than matches", () => {
    const view = viewOf(`- pack
  - passport
  - tickets
- a bullet
`)
    const { doc, context, matches } = filteredView(view, matching(view.doc, ["pack"]))
    expect(outline(doc, context)).toEqual(["pack", "  ~passport", "  ~tickets"])
    // Only the row itself is a match; what hangs beneath it is its content.
    expect(matches).toBe(1)
  })

  it("unfolds what survived, so a match is never hidden behind a fold", () => {
    const view: GraphView = { ...viewOf(NOTE), collapsed: new Set(["some-key"]) }
    expect(filteredView(view, matching(view.doc, ["milk"])).collapsed.size).toBe(0)
  })

  it("empties the view when nothing matched", () => {
    const view = viewOf(NOTE)
    const { doc, matches } = filteredView(view, matching(view.doc, []))
    expect(matches).toBe(0)
    expect(doc.rootBlockIds).toEqual([])
  })

  it("keeps a root the filter emptied when the view is rooted on it", () => {
    const view = viewOf(NOTE)
    const { doc, context } = filteredView(view, matching(view.doc, []), { keepRoots: true })
    // The roots stand, with nothing beneath them — a focused page keeps its
    // title even when the filter found nothing inside it.
    expect(doc.rootBlockIds.length).toBe(3)
    expect(outline(doc, context)).toEqual(["~Shopping", "~Chores", "~Reading"])
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
    const view = viewOf(TREE)
    const { doc, context } = filteredView(view, byText(view.doc))
    expect(outline(doc, context)).toEqual(["damson", "fig", "pear", "  apple", "  cherry"])
  })

  it("reverses on desc", () => {
    const view = viewOf(TREE)
    const { doc, context } = filteredView(view, byText(view.doc, "desc"))
    expect(outline(doc, context)).toEqual(["pear", "  cherry", "  apple", "fig", "damson"])
  })

  it("sorts and filters together, the tree surviving both", () => {
    const view = viewOf(NOTE)
    const { doc, context } = filteredView(view, {
      ...matching(view.doc, ["milk", "bread", "hoover"]),
      compare: byText(view.doc).compare,
    })
    expect(outline(doc, context)).toEqual(["~Chores", "  hoover", "~Shopping", "  bread", "  milk"])
  })
})
