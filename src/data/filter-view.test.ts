import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { buildRows } from "../blocks/view"
import type { BlockDoc } from "../blocks/types"
import type { ViewNarrowing } from "../utils/view-narrowing"
import { filteredRollup, filteredView, isNarrowed } from "./filter-view"
import {
  buildGraphSnapshot,
  docToGraph,
  noteDoc,
  noteView,
  rollup,
  type GraphSnapshot,
} from "./graph"

/**
 * The SHAPE of a narrowed view — what survives the prune, what is kept as
 * dimmed context, and where a sort is applied. What a query *means* is not
 * decided here: it arrives already resolved as a `ViewNarrowing`, which is
 * why these tests hand one over directly. The vocabulary itself is held by
 * the search engine's own tests, and end to end in `hooks/note-doc.test.tsx`.
 */

/** A note's graph from markdown: the note `note`, its outline the rows. */
function graphOf(markdown: string): GraphSnapshot {
  const { nodes, links } = docToGraph("note", markdown, 0)
  return buildGraphSnapshot(nodes, links)
}

/** The note's doc, every row open — what a test names its rows from. */
function docOf(graph: GraphSnapshot): BlockDoc {
  return noteDoc("note", graph)!
}

/** The note's view, narrowed by the lazy walk. */
function narrowed(
  graph: GraphSnapshot,
  narrowing: ViewNarrowing,
  options?: Parameters<typeof filteredView>[4],
  focusBlockId: string | null = null,
) {
  return filteredView(graph, "note", focusBlockId, narrowing, options)!
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
  it("is the plain walk when nothing is narrowed", () => {
    const graph = graphOf(NOTE)
    const result = narrowed(graph, NOTHING)
    expect(result.doc).toEqual(noteView("note", graph)!.doc)
    expect(result.matches).toBe(null)
    expect(result.context.size).toBe(0)
  })

  it("keeps matches with their ancestors, and dims the ancestors", () => {
    const graph = graphOf(NOTE)
    const { doc, context, matches } = narrowed(graph, matching(docOf(graph), ["milk", "hoover"]))
    expect(outline(doc, context)).toEqual(["~Shopping", "  milk", "~Chores", "  hoover"])
    // The two rows matched; the headings above them are context only.
    expect(matches).toBe(2)
  })

  it("drops a branch that holds no match", () => {
    const graph = graphOf(NOTE)
    const { doc, context } = narrowed(graph, matching(docOf(graph), ["milk"]))
    expect(outline(doc, context).join("\n")).not.toContain("Reading")
    expect(outline(doc, context).join("\n")).not.toContain("a book")
  })

  it("keeps a match's own children, as context rather than matches", () => {
    const graph = graphOf(`- pack
  - passport
  - tickets
- a bullet
`)
    const { doc, context, matches } = narrowed(graph, matching(docOf(graph), ["pack"]))
    expect(outline(doc, context)).toEqual(["pack", "  ~passport", "  ~tickets"])
    // Only the row itself is a match; what hangs beneath it is its content.
    expect(matches).toBe(1)
  })

  it("keeps a row it is told to, as a match but not counted as one", () => {
    const graph = graphOf(NOTE)
    const bread = Object.values(docOf(graph).blocks).find((b) => b.text === "bread")!
    const { doc, context, matches } = narrowed(graph, matching(docOf(graph), ["milk"]), {
      keep: new Set([bread.id]),
    })
    // The row being edited stands whatever the filter says, its ancestors
    // with it as context, and is drawn as a match rather than dimmed.
    expect(outline(doc, context)).toEqual(["~Shopping", "  milk", "  bread"])
    expect(matches).toBe(1)
    // Let go of, it is the filter's to judge again.
    expect(outline(narrowed(graph, matching(docOf(graph), ["milk"])).doc, new Set())).toEqual([
      "Shopping",
      "  milk",
    ])
  })

  it("folds what survived by the rule it is given, and nothing without one", () => {
    const graph = graphOf(NOTE)
    expect(narrowed(graph, matching(docOf(graph), ["milk"])).collapsed.size).toBe(0)
    // A rule closing the Shopping row folds it; leaves are never folded.
    const shopping = docOf(graph).rootBlockIds[0]
    const rule = (key: string) => key !== shopping
    const { collapsed } = narrowed(graph, matching(docOf(graph), ["milk", "hoover"]), {
      expanded: rule,
    })
    expect([...collapsed]).toEqual([shopping])
    // Sorted only, the same: the rule runs over the sorted rows.
    expect([...narrowed(graph, byText(docOf(graph)), { expanded: rule }).collapsed]).toEqual([
      shopping,
    ])
  })

  it("empties the view when nothing matched", () => {
    const graph = graphOf(NOTE)
    const { doc, matches } = narrowed(graph, matching(docOf(graph), []))
    expect(matches).toBe(0)
    expect(doc.rootBlockIds).toEqual([])
  })

  it("keeps a focused root the filter emptied", () => {
    const graph = graphOf(NOTE)
    const shopping = docOf(graph).rootBlockIds[0]
    const { doc, context } = narrowed(graph, matching(docOf(graph), ["hoover"]), {}, shopping)
    // The root stands, with nothing beneath it — a focused page keeps its
    // title even when the filter found nothing inside it.
    expect(doc.rootBlockIds).toEqual([shopping])
    expect(outline(doc, context)).toEqual(["~Shopping"])
  })
})

describe("filteredView, lazy (docs/graph-walk.md, 4.5)", () => {
  const DEEP = `- a
  - b
    - c
      - match
    - d
- e
`

  it("does not walk beneath a closed row, and keeps it for the match beneath", () => {
    const graph = graphOf(DEEP)
    const doc = docOf(graph)
    const [a] = doc.rootBlockIds
    // Only the first level opens: B is closed.
    const rule = (_key: string, level: number) => level < 2
    const view = narrowed(graph, matching(doc, ["match"]), { expanded: rule })
    const b = doc.blocks[a].children[0]
    expect(view.collapsed).toEqual(new Set([`${a}/${b}`]))
    // B lists only the child that reaches the match; nothing beneath B is
    // walked, so C and the match are not in the doc.
    expect(view.doc.blocks[b].children).toEqual([doc.blocks[b].children[0]])
    expect(Object.values(view.doc.blocks).map((block) => block.text)).toEqual(["a", "b"])
    expect(outline(view.doc, view.context)).toEqual(["~a", "  ~b"])
  })

  it("opened, gives the rows the eager walk gave", () => {
    const graph = graphOf(DEEP)
    const view = narrowed(graph, matching(docOf(graph), ["match"]))
    expect(outline(view.doc, view.context)).toEqual(["~a", "  ~b", "    ~c", "      match"])
  })

  it("ends a loop under a filter, and drops a row the loop alone kept", () => {
    // N > A > B > A, and A > M (the match). B reaches M only through A, on
    // the path: B has nothing to stand for.
    const graph = buildGraphSnapshot(
      [
        { id: "note", type: "note", text: "N", props: null, updated_at: 0 },
        { id: "blk_a", type: "ul", text: "a", props: null, updated_at: 0 },
        { id: "blk_b", type: "ul", text: "b", props: null, updated_at: 0 },
        { id: "blk_m", type: "ul", text: "m", props: null, updated_at: 0 },
      ],
      [
        {
          source_id: "note",
          destination_id: "blk_a",
          kind: "child",
          sort_key: "a0",
          updated_at: 0,
        },
        {
          source_id: "blk_a",
          destination_id: "blk_b",
          kind: "child",
          sort_key: "a0",
          updated_at: 0,
        },
        {
          source_id: "blk_b",
          destination_id: "blk_a",
          kind: "child",
          sort_key: "a0",
          updated_at: 0,
        },
        {
          source_id: "blk_a",
          destination_id: "blk_m",
          kind: "child",
          sort_key: "a1",
          updated_at: 0,
        },
      ],
    )
    const { doc, context } = narrowed(graph, { matched: new Set(["blk_m"]), compare: null })
    expect(outline(doc, context)).toEqual(["~a", "  m"])
    expect(doc.blocks.blk_a.children).toEqual(["blk_m"])
    expect(doc.blocks.blk_b).toBeUndefined()
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
    const graph = graphOf(TREE)
    const { doc, context } = narrowed(graph, byText(docOf(graph)))
    expect(outline(doc, context)).toEqual(["damson", "fig", "pear", "  apple", "  cherry"])
  })

  it("reverses on desc", () => {
    const graph = graphOf(TREE)
    const { doc, context } = narrowed(graph, byText(docOf(graph), "desc"))
    expect(outline(doc, context)).toEqual(["pear", "  cherry", "  apple", "fig", "damson"])
  })

  it("sorts and filters together, the tree surviving both", () => {
    const graph = graphOf(NOTE)
    const doc0 = docOf(graph)
    const { doc, context } = narrowed(graph, {
      ...matching(doc0, ["milk", "bread", "hoover"]),
      compare: byText(doc0).compare,
    })
    expect(outline(doc, context)).toEqual(["~Chores", "  hoover", "~Shopping", "  bread", "  milk"])
  })
})

describe("filteredRollup", () => {
  // Copy markdown in a filtered view: the rows the view shows, nested as
  // shown, and nothing the filter hid.
  const graph = () => {
    const { nodes, links } = docToGraph(
      "note",
      "- Shopping\n  - [ ] milk\n    - semi-skimmed\n  - [x] bread\n- Chores\n  - [ ] laundry\n",
      0,
    )
    return buildGraphSnapshot(nodes, links)
  }
  const ids = (snapshot: ReturnType<typeof graph>, texts: string[]) =>
    new Set(
      [...snapshot.nodes.values()].filter((node) => texts.includes(node.text)).map((n) => n.id),
    )
  const visible = (markdown: string | null) =>
    (markdown ?? "").split("\n").filter((line) => line.trim() !== "" && !/id::/.test(line))

  it("copies the matches, their ancestors and what hangs beneath them, nothing else", () => {
    const snapshot = graph()
    const copied = filteredRollup("note", null, ids(snapshot, ["milk"]), snapshot)
    expect(visible(copied)).toEqual(["- Shopping", "  [ ] milk", "    - semi-skimmed"])
  })

  it("is the whole rollup when every row matches", () => {
    const snapshot = graph()
    const all = new Set([...snapshot.nodes.keys()])
    expect(filteredRollup("note", null, all, snapshot)).toBe(rollup("note", snapshot))
  })

  it("keeps the focused block, filtering what is beneath it", () => {
    const snapshot = graph()
    const [shopping] = ids(snapshot, ["Shopping"])
    const copied = filteredRollup("note", shopping, ids(snapshot, ["bread"]), snapshot)
    expect(visible(copied)).toEqual(["- Shopping", "  [x] bread"])
  })
})

describe("filteredView with pivots (docs/graph-walk.md, 3.9)", () => {
  // N > A > X > Y, and N > B. X has two more holders: P (in M, which also
  // holds Z under P) and Q (in M). L in M holds the note N.
  const row = (id: string, type: string, text: string): NodeRow => ({
    id,
    type,
    text,
    props: null,
    updated_at: 0,
  })
  const edge = (source: string, destination: string, sortKey: string): LinkRow => ({
    source_id: source,
    destination_id: destination,
    kind: "child",
    sort_key: sortKey,
    updated_at: 0,
  })
  const graph = () =>
    buildGraphSnapshot(
      [
        row("n", "note", "N"),
        row("m", "note", "M"),
        row("blk_a", "ul", "a"),
        row("blk_b", "ul", "b"),
        row("blk_x", "ul", "x"),
        row("blk_y", "ul", "y"),
        row("blk_p", "ul", "p"),
        row("blk_q", "ul", "q"),
        row("blk_z", "ul", "z"),
        row("blk_l", "ul", "l"),
      ],
      [
        edge("n", "blk_a", "a0"),
        edge("n", "blk_b", "a1"),
        edge("blk_a", "blk_x", "a0"),
        edge("blk_x", "blk_y", "a0"),
        edge("m", "blk_q", "a0"),
        edge("m", "blk_p", "a1"),
        edge("m", "blk_l", "a2"),
        edge("blk_q", "blk_x", "a0"),
        edge("blk_p", "blk_x", "a0"),
        edge("blk_p", "blk_z", "a1"),
        edge("blk_l", "n", "a0"),
      ],
    )
  const pivots = (entries: Record<string, "up" | "down">) => new Map(Object.entries(entries))
  // The narrowed walk of N.
  const narrowedN = (
    narrowing: ViewNarrowing,
    options: Parameters<typeof filteredView>[4],
    snapshot = graph(),
  ) => filteredView(snapshot, "n", null, narrowing, options)!
  const byIds = (ids: string[]): ViewNarrowing => ({ matched: new Set(ids), compare: null })

  /** The rows the editor draws for `pivotMap` (`buildRows`, every row
   * open): up rows marked `^`, dimmed rows (context) `~`. */
  function rowsOf(
    doc: BlockDoc,
    context: ReadonlySet<string>,
    pivotMap: ReadonlyMap<string, "up" | "down">,
  ): string[] {
    return buildRows(doc, { folds: new Set(), pivots: pivotMap, rootId: "n" }).map(
      ({ id, depth, direction }) =>
        `${"  ".repeat(depth)}${direction === "up" ? "^" : ""}${context.has(id) ? "~" : ""}${doc.blocks[id].text}`,
    )
  }

  it("a filter does not prune an up region", () => {
    const up = pivots({ blk_x: "up" })
    const { doc, context, matches } = narrowedN(byIds(["blk_b"]), { pivots: up })
    // X stands for its region, which is kept whole and dimmed; A is its path.
    expect(rowsOf(doc, context, up)).toEqual([
      "~a",
      "  ~x",
      "    ^~p",
      "      ^~M",
      "    ^~q",
      "      ^~M",
      "b",
    ])
    expect(matches).toBe(1)
  })

  it("without the pivot, the same filter prunes the branch", () => {
    const { doc, context } = narrowedN(byIds(["blk_b"]), {})
    expect(rowsOf(doc, context, new Map())).toEqual(["b"])
  })

  it("keeps the note's holders whole under a pivot on the note", () => {
    const up = pivots({ n: "up" })
    const { doc, context } = narrowedN(byIds([]), { pivots: up })
    expect(rowsOf(doc, context, up)).toEqual(["^~l", "  ^~M"])
  })

  it("keeps an up loop's closing row under a filter", () => {
    // C and D hold each other, and N holds C and B. Pivot C up.
    const looped = buildGraphSnapshot(
      [
        row("n", "note", "N"),
        row("blk_b", "ul", "b"),
        row("blk_c", "ul", "c"),
        row("blk_d", "ul", "d"),
      ],
      [
        edge("n", "blk_c", "a0"),
        edge("n", "blk_b", "a1"),
        edge("blk_c", "blk_d", "a0"),
        edge("blk_d", "blk_c", "a0"),
      ],
    )
    const up = pivots({ blk_c: "up" })
    const base = noteView("n", looped, undefined, "downstream", up)!
    const { doc, context } = narrowedN(byIds(["blk_b"]), { pivots: up }, looped)
    // Beneath C: D, its holder. Beneath D: C closes the loop, as a leaf.
    expect(rowsOf(doc, context, up)).toEqual(["~c", "  ^~d", "    ^~c", "b"])
    expect(rowsOf(doc, context, up)).toEqual(rowsOf(base.doc, context, up))
  })

  it("a sort leaves up rows in holder order", () => {
    const up = pivots({ blk_x: "up" })
    const base = noteView("n", graph(), undefined, "downstream", up)!
    const compare = (a: string, b: string) =>
      (base.doc.blocks[b]?.text ?? "").localeCompare(base.doc.blocks[a]?.text ?? "")
    const { doc } = narrowedN({ matched: null, compare }, { pivots: up })
    // The down rows sort (descending): b before a.
    expect(doc.rootBlockIds).toEqual(["blk_b", "blk_a"])
    // The holders keep the order the graph gives them, p then q, where a
    // descending sort puts q first.
    expect(doc.blocks.blk_x.upstream).toEqual(["blk_a", "blk_p", "blk_q"])
    expect(rowsOf(doc, new Set(), up)).toEqual([
      "b",
      "a",
      "  x",
      "    ^p",
      "      ^M",
      "    ^q",
      "      ^M",
    ])
  })

  it("folds as the lazy walk folds, the depth count starting again at a pivot", () => {
    const up = pivots({ blk_x: "up" })
    // Two levels, and X opened by the reader (setting a pivot opens a row).
    const byDepth = (key: string, level: number) => level < 2 || key === "blk_a/blk_x"
    const all = Object.keys(noteView("n", graph(), undefined, "downstream", up)!.doc.blocks)
    const { collapsed } = narrowedN(byIds(all), { pivots: up, expanded: byDepth })
    const lazy = noteView("n", graph(), byDepth, "downstream", up)!
    expect([...collapsed].sort()).toEqual([...lazy.collapsed].sort())
    // The holders sit at level 1 beneath the pivot, so they open: M shows
    // beneath each. Counted from the note, they are at level 3 and close.
    expect(collapsed.size).toBe(0)
  })
})
