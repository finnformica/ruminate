import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { blockView, buildGraphSnapshot, noteView, type LinkDirections } from "../data/graph"
import { keyOfPath, pathOfKey } from "../data/panes"
import { parse } from "./parse"
import type { BlockDoc } from "./types"
import {
  walkDoc,
  ancestorKeys,
  buildRows,
  directionOfKey,
  firstOccurrenceKey,
  hasOccurrence,
  idOfKey,
  isWithin,
  keyOf,
  landingRow,
  occurrenceKeys,
  parentKeyOf,
  pathIdsOf,
  rowsBeneath,
  siblingKey,
  focusRootKeyOf,
  type Occurrence,
} from "./view"

const NONE: ReadonlySet<string> = new Set()

const outline = parse(
  [
    "- a",
    "  id:: a",
    "  - b",
    "    id:: b",
    "    - c",
    "      id:: c",
    "  1. d",
    "    id:: d",
    "  2. e",
    "    id:: e",
    "- f",
    "  id:: f",
    "",
  ].join("\n"),
)

/** A doc where `s` hangs under both `p` and `q` — one block, two occurrences. */
const shared: BlockDoc = {
  props: null,
  rootBlockIds: ["p", "q"],
  blocks: {
    p: { id: "p", type: "ul", text: "p", children: ["s"] },
    q: { id: "q", type: "ul", text: "q", children: ["s"] },
    s: { id: "s", type: "ul", text: "shared", children: ["t"] },
    t: { id: "t", type: "ul", text: "t", children: [] },
  },
}

const summary = (rows: ReturnType<typeof buildRows>) =>
  rows.map((row) => `${"  ".repeat(row.depth)}${row.key}${row.collapsed ? " ▸" : ""}`)

describe("occurrence keys", () => {
  it("are the path of ids from the root", () => {
    expect(keyOf(null, "a")).toBe("a")
    expect(keyOf("a/b", "c")).toBe("a/b/c")
    expect(idOfKey("a/b/c")).toBe("c")
    expect(idOfKey("a")).toBe("a")
  })

  it("carry the parent and the ancestors, nearest first", () => {
    expect(parentKeyOf("a/b/c")).toBe("a/b")
    expect(parentKeyOf("a")).toBeNull()
    expect(ancestorKeys("a/b/c")).toEqual(["a/b", "a"])
    expect(ancestorKeys("a")).toEqual([])
    expect(isWithin("a/b/c", "a/b")).toBe(true)
    expect(isWithin("a/b", "a/b")).toBe(true)
    expect(isWithin("a/bc", "a/b")).toBe(false)
    expect(isWithin("a", "a/b")).toBe(false)
  })

  it("address the focused block by its first occurrence", () => {
    expect(focusRootKeyOf(shared, "s")).toBe("p/s")
    expect(focusRootKeyOf(shared, "nope")).toBe("nope")
  })

  it("enumerate every occurrence, depth-first", () => {
    expect(occurrenceKeys(outline)).toEqual(["a", "a/b", "a/b/c", "a/d", "a/e", "f"])
    expect(occurrenceKeys(shared)).toEqual(["p", "p/s", "p/s/t", "q", "q/s", "q/s/t"])
  })

  it("resolve to real paths only", () => {
    expect(hasOccurrence(outline, "a/b/c")).toBe(true)
    expect(hasOccurrence(outline, "a/c")).toBe(false)
    expect(hasOccurrence(outline, "b")).toBe(false)
    expect(hasOccurrence(outline, "a/b/c/zzz")).toBe(false)
    expect(hasOccurrence(shared, "q/s/t")).toBe(true)
  })

  it("find a block's first occurrence", () => {
    expect(firstOccurrenceKey(outline, "c")).toBe("a/b/c")
    expect(firstOccurrenceKey(shared, "t")).toBe("p/s/t")
    expect(firstOccurrenceKey(shared, "nope")).toBeNull()
  })

  it("show a loop where it closes, once, and never descend it", () => {
    const cyclic: BlockDoc = {
      props: null,
      rootBlockIds: ["x"],
      blocks: {
        x: { id: "x", type: "ul", text: "x", children: ["y"] },
        y: { id: "y", type: "ul", text: "y", children: ["x"] },
      },
    }
    expect(occurrenceKeys(cyclic)).toEqual(["x", "x/y", "x/y/x"])
    const rows = buildRows(cyclic, { folds: NONE })
    expect(summary(rows)).toEqual(["x", "  x/y", "    x/y/x"])
    // The closing row is a leaf: no children to fold, marked as the loop.
    expect(rows[2]).toMatchObject({ hasChildren: false, looped: true })
    expect(rows[0].looped).toBeUndefined()
  })
})

describe("buildRows", () => {
  it("flattens the outline depth-first, indented by depth", () => {
    expect(summary(buildRows(outline, { folds: NONE }))).toEqual([
      "a",
      "  a/b",
      "    a/b/c",
      "  a/d",
      "  a/e",
      "f",
    ])
  })

  it("carries each row's place: parent, index, children, ordered number, guides", () => {
    const rows = buildRows(outline, { folds: NONE })
    const byKey = new Map(rows.map((row) => [row.key, row]))
    expect(byKey.get("a")).toMatchObject({
      id: "a",
      parentKey: null,
      index: 0,
      hasChildren: true,
      guideKeys: [],
    })
    expect(byKey.get("a/b/c")).toMatchObject({
      id: "c",
      parentKey: "a/b",
      depth: 2,
      hasChildren: false,
      guideKeys: ["a", "a/b"],
    })
    expect(byKey.get("a/d")?.olNumber).toBe(1)
    expect(byKey.get("a/e")?.olNumber).toBe(2)
    expect(byKey.get("f")?.index).toBe(1)
  })

  it("a fold hides the children and marks the row", () => {
    expect(summary(buildRows(outline, { folds: new Set(["a/b"]) }))).toEqual([
      "a",
      "  a/b ▸",
      "  a/d",
      "  a/e",
      "f",
    ])
    // A fold on a leaf means nothing.
    expect(
      buildRows(outline, { folds: new Set(["f"]) }).find((r) => r.key === "f")?.collapsed,
    ).toBe(false)
  })

  it("a shared block is two rows with two keys, folded independently", () => {
    expect(summary(buildRows(shared, { folds: new Set(["q/s"]) }))).toEqual([
      "p",
      "  p/s",
      "    p/s/t",
      "q",
      "  q/s ▸",
    ])
  })

  it("skips ids the doc does not have", () => {
    const dangling: BlockDoc = {
      ...outline,
      rootBlockIds: ["a", "ghost", "f"],
    }
    expect(buildRows(dangling, { folds: NONE }).map((row) => row.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ])
  })

  it("focused: the rows are the root's children, from depth 0 — the root is the title, not a row", () => {
    const rows = buildRows(outline, { focusRootId: "b", folds: NONE })
    expect(summary(rows)).toEqual(["a/b/c"])
    expect(rows[0]).toMatchObject({ depth: 0, parentKey: "a/b", guideKeys: [] })
    // Deeper rows count their guides from the focus root's children, not the note.
    const deep = buildRows(outline, { focusRootId: "a", folds: NONE })
    expect(deep.find((row) => row.key === "a/b/c")).toMatchObject({ depth: 1, guideKeys: ["a/b"] })
  })

  it("focused: the title is always open, and folds made here are the note's folds", () => {
    const rows = buildRows(outline, { focusRootId: "a", folds: new Set(["a", "a/b"]) })
    expect(summary(rows)).toEqual(["a/b ▸", "a/d", "a/e"])
  })

  it("untitled: the focus root leads the rows, its subtree indented beneath it", () => {
    const rows = buildRows(outline, { focusRootId: "b", focusTitled: false, folds: NONE })
    expect(summary(rows)).toEqual(["a/b", "  a/b/c"])
    // The root is the view's own: nothing above it on screen, whatever path
    // its key spells out in the document.
    expect(rows[0]).toMatchObject({
      id: "b",
      depth: 0,
      index: 0,
      parentKey: null,
      guideKeys: [],
      hasChildren: true,
      collapsed: false,
    })
    expect(rows[1]).toMatchObject({ depth: 1, parentKey: "a/b", guideKeys: ["a/b"] })
  })

  it("untitled: the leading row folds like any other, and a leaf leads alone", () => {
    expect(
      summary(
        buildRows(outline, { focusRootId: "b", focusTitled: false, folds: new Set(["a/b"]) }),
      ),
    ).toEqual(["a/b ▸"])
    const leaf = buildRows(outline, { focusRootId: "c", focusTitled: false, folds: NONE })
    expect(summary(leaf)).toEqual(["a/b/c"])
    expect(leaf[0]).toMatchObject({ hasChildren: false, collapsed: false })
  })

  it("focused on an unknown block: the whole note", () => {
    expect(buildRows(outline, { focusRootId: "nope", folds: NONE })).toHaveLength(6)
  })
})

/**
 * A doc walked both ways (`walkGraph`, directions "both") from note `n`:
 *   n > a > s        s is also held by p (in another note), and p by q.
 *   n > b
 * Every block carries its parents; `n` itself is the doc's root and is on
 * the path, so it is never listed beneath its own children.
 */
const graphed: BlockDoc = {
  props: null,
  rootBlockIds: ["a", "b"],
  upstream: [],
  blocks: {
    n: { id: "n", type: "note", text: "Note", children: ["a", "b"], upstream: [] },
    a: { id: "a", type: "ul", text: "a", children: ["s"], upstream: ["n"] },
    b: { id: "b", type: "ul", text: "b", children: [], upstream: ["n"] },
    s: { id: "s", type: "todo", text: "shared", children: [], upstream: ["a", "p"] },
    p: { id: "p", type: "ul", text: "p", children: ["s"], upstream: ["q"] },
    q: { id: "q", type: "note", text: "Other", children: ["p"], upstream: [] },
  },
}

describe("upstream occurrences", () => {
  it("mark the segment, and every helper reads the direction off the key", () => {
    expect(keyOf("a/s", "p", "up")).toBe("a/s/^p")
    expect(keyOf(null, "p", "up")).toBe("^p")
    expect(idOfKey("a/s/^p")).toBe("p")
    expect(idOfKey("^p")).toBe("p")
    expect(parentKeyOf("a/s/^p")).toBe("a/s")
    expect(directionOfKey("a/s/^p")).toBe("up")
    expect(directionOfKey("a/s")).toBe("down")
    expect(pathIdsOf("a/s/^p/^q")).toEqual(["a", "s", "p", "q"])
    // A sibling of a parent row is another parent row.
    expect(siblingKey("a/s/^p", "x")).toBe("a/s/^x")
    expect(siblingKey("a/s", "x")).toBe("a/x")
  })

  it("are real paths only when the parent's upstream names the block", () => {
    expect(hasOccurrence(graphed, "a/s/^p")).toBe(true)
    expect(hasOccurrence(graphed, "a/s/^p/^q")).toBe(true)
    expect(hasOccurrence(graphed, "a/s/p")).toBe(false)
    expect(hasOccurrence(graphed, "a/^s")).toBe(false)
    expect(hasOccurrence(graphed, "^q")).toBe(false)
    expect(hasOccurrence({ ...graphed, upstream: ["q"] }, "^q")).toBe(true)
  })

  it("rowsBeneath: children first, then the parents, less the block the row came from", () => {
    expect(rowsBeneath(graphed, graphed.blocks.s, "a")).toEqual([{ id: "p", direction: "up" }])
    expect(rowsBeneath(graphed, graphed.blocks.a, "n")).toEqual([{ id: "s", direction: "down" }])
    expect(rowsBeneath(graphed, null, "n")).toEqual([
      { id: "a", direction: "down" },
      { id: "b", direction: "down" },
    ])
  })

  it("buildRows lists a block's other parents beneath its children, with the root on the path", () => {
    const rows = buildRows(graphed, { folds: NONE, rootId: "n" })
    expect(summary(rows)).toEqual(["a", "  a/s", "    a/s/^p", "      a/s/^p/^q", "b"])
    const p = rows.find((row) => row.key === "a/s/^p")!
    expect(p.direction).toBe("up")
    expect(p.depth).toBe(2)
    expect(p.hasChildren).toBe(true)
    // The parent q, a note, has nothing beneath it here: its child p is on
    // the path, and it has no parents.
    expect(rows.find((row) => row.key === "a/s/^p/^q")!.hasChildren).toBe(false)
    // Without the root on the path, the note's own parents would be listed
    // under its children: the view's root must be named.
    expect(summary(buildRows(graphed, { folds: NONE }))).toContain("  a/^n")
  })

  it("buildRows folds an upstream row like any other, and focused shows the root's parents", () => {
    const folded = buildRows(graphed, { folds: new Set(["a/s/^p"]), rootId: "n" })
    expect(summary(folded)).toEqual(["a", "  a/s", "    a/s/^p ▸", "b"])
    // Focused on s: its parents are all the rows, a and p alike, each with
    // its note beneath — a fresh path starts at the focus root. Beneath the
    // note, the row it was reached up from (a) is not listed, its other
    // block (b) is: the graph around the block, as far as it is open.
    const focused = buildRows(graphed, { folds: NONE, focusRootId: "s" })
    expect(summary(focused)).toEqual([
      "a/s/^a",
      "  a/s/^a/^n",
      "    a/s/^a/^n/b",
      "a/s/^p",
      "  a/s/^p/^q",
    ])
  })

  it("walkDoc visits upstream occurrences after the children, marked", () => {
    const seen: string[] = []
    walkDoc(
      graphed,
      graphed.rootBlockIds,
      ({ key, direction }) => {
        seen.push(`${direction === "up" ? "↑" : ""}${key}`)
      },
      { rootId: "n" },
    )
    expect(seen).toEqual(["a", "a/s", "↑a/s/^p", "↑a/s/^p/^q", "b"])
    expect(occurrenceKeys({ ...graphed, upstream: ["q"] })).toContain("^q")
  })
})

describe("rows read pivots (docs/graph-walk.md, 3)", () => {
  const node = (id: string, type: string): NodeRow => ({
    id,
    type,
    text: id,
    props: null,
    updated_at: 0,
  })
  const link = (source: string, destination: string, sortKey: string): LinkRow => ({
    source_id: source,
    destination_id: destination,
    kind: "child",
    sort_key: sortKey,
    updated_at: 0,
  })
  // N > A > X > Y, N > B and N > P; M > P > X (X has two holders, A and P),
  // P > Z; M > L > N (L holds the note N).
  const graph = buildGraphSnapshot(
    [
      node("n", "note"),
      node("m", "note"),
      ...["a", "b", "x", "y", "p", "z", "l"].map((id) => node(id, "ul")),
    ],
    [
      link("n", "a", "a0"),
      link("n", "b", "a1"),
      link("n", "p", "a2"),
      link("a", "x", "a0"),
      link("x", "y", "a0"),
      link("m", "p", "a0"),
      link("m", "l", "a1"),
      link("p", "x", "a0"),
      link("p", "z", "a1"),
      link("l", "n", "a0"),
    ],
  )
  const pivots = (entries: Record<string, "up" | "down">) => new Map(Object.entries(entries))

  /** The note's rows as the walk draws them, and the keys the walk asked the
   * fold rule about (each row with something beneath it), in order. */
  const view = (
    over: Record<string, "up" | "down">,
    directions: LinkDirections = "downstream",
    open: (key: string, level: number) => boolean = () => true,
  ) => {
    const asked: string[] = []
    const rule = (key: string, level: number) => {
      asked.push(key)
      return open(key, level)
    }
    const { doc, collapsed } = noteView("n", graph, rule, directions, pivots(over))!
    const rows = buildRows(doc, { folds: collapsed, rootId: "n", pivots: pivots(over), directions })
    return { doc, rows, asked }
  }

  it("the rows equal the walk for the same pivots", () => {
    const sets = [{}, { x: "up" }, { x: "up", p: "down" }, { a: "up" }, { n: "up" }] as const
    const rules = [
      () => true,
      (_key: string, level: number) => level < 2,
      (key: string) => key !== "a/x",
    ]
    for (const over of sets) {
      for (const directions of ["downstream", "upstream", "both"] as const) {
        for (const open of rules) {
          const { doc, rows, asked } = view(over, directions, open)
          // Each walked block is a row, and no other block is.
          expect(new Set(rows.map((row) => row.id))).toEqual(new Set(Object.keys(doc.blocks)))
          // A row has a chevron exactly where the walk asked about it.
          expect(rows.filter((row) => row.hasChildren).map((row) => row.key)).toEqual(asked)
        }
      }
    }
  })

  it("an up pivot draws the holders beneath its row, less the row it came from", () => {
    const { rows } = view({ x: "up" })
    expect(summary(rows)).toEqual([
      "a",
      "  a/x",
      "    a/x/^p",
      "      a/x/^p/^m",
      "b",
      "p",
      "  p/x",
      "    p/x/^a",
      "  p/z",
    ])
    expect(rows.filter((row) => row.pivot).map((row) => [row.key, row.pivot])).toEqual([
      ["a/x", "up"],
      ["p/x", "up"],
    ])
  })

  it("a block walked up in one row lists only what it holds in a down row", () => {
    // P is walked up beneath a/x, so it carries its holders M and N. Its own
    // row, down, follows the setting: no holders.
    const { doc, rows } = view({ x: "up" })
    expect(doc.blocks.p.upstream).toEqual(["m", "n"])
    expect(rows.map((row) => row.key)).not.toContain("p/^m")
    // Without the setting, the rows read what the doc carries (no pivots).
    const loose = buildRows(doc, { folds: NONE, rootId: "n", pivots: pivots({ x: "up" }) })
    expect(loose.map((row) => row.key)).toContain("p/^m")
  })

  it("hasChildren follows the row's query", () => {
    // A holds X, but walked up it has nothing beneath: its holder is the note.
    const a = view({ a: "up" }).rows.find((row) => row.key === "a")!
    expect(a).toMatchObject({ hasChildren: false, pivot: "up" })
    expect(view({}).rows.find((row) => row.key === "a")!.hasChildren).toBe(true)
  })

  it("an up pivot on the note root draws its holders as the rows", () => {
    expect(summary(view({ n: "up" }).rows)).toEqual(["^l", "  ^l/^m"])
  })

  it("a focused block's query is its own pivot", () => {
    const { doc } = blockView("x", graph, () => true, "downstream", pivots({ x: "up" }))!
    const rows = buildRows(doc, {
      folds: NONE,
      focusRootId: "x",
      focusTitled: false,
      pivots: pivots({ x: "up" }),
      directions: "downstream",
    })
    expect(summary(rows)).toEqual([
      "x",
      "  x/^a",
      "    x/^a/^n",
      "      x/^a/^n/^l",
      "        x/^a/^n/^l/^m",
      "  x/^p",
      "    x/^p/^m",
      "    x/^p/^n",
      "      x/^p/^n/^l",
      "        x/^p/^n/^l/^m",
    ])
    expect(rows[0].pivot).toBe("up")
  })

  it("walkDoc and the occurrence keys read the pivots", () => {
    const over = pivots({ x: "up" })
    const { doc } = noteView("n", graph, undefined, "downstream", over)!
    const rule = { pivots: over, directions: "downstream" as const, rootId: "n" }
    expect(occurrenceKeys(doc, rule)).toEqual(
      buildRows(doc, { folds: NONE, ...rule }).map((row) => row.key),
    )
    expect(firstOccurrenceKey(doc, "p", rule)).toBe("p")
    expect(firstOccurrenceKey(doc, "m", rule)).toBeNull()
  })
})

describe("one guard in both directions (docs/graph-walk.md, 3.3)", () => {
  const node = (id: string): NodeRow => ({
    id,
    type: id === "n" ? "note" : "ul",
    text: id,
    props: null,
    updated_at: 0,
  })
  const link = (source: string, destination: string, sortKey: string): LinkRow => ({
    source_id: source,
    destination_id: destination,
    kind: "child",
    sort_key: sortKey,
    updated_at: 0,
  })
  // N > C, C > D and D > C (C and D hold each other); N > A > X > Y.
  const graph = buildGraphSnapshot(["n", "c", "d", "a", "x", "y"].map(node), [
    link("n", "c", "a0"),
    link("n", "a", "a1"),
    link("c", "d", "a0"),
    link("d", "c", "a0"),
    link("a", "x", "a0"),
    link("x", "y", "a0"),
  ])
  const rowsOf = (
    pivots: Map<string, "up" | "down">,
    directions: LinkDirections = "downstream",
  ) => {
    const { doc, collapsed } = noteView("n", graph, () => true, directions, pivots)!
    return buildRows(doc, { folds: collapsed, rootId: "n", pivots, directions })
  }
  const shown = (rows: Occurrence[]) =>
    rows.map((row) => `${row.key}${row.looped ? " (looped)" : ""}`)

  it("a two-block cycle walked up shows one looped leaf", () => {
    const rows = rowsOf(new Map([["c", "up"]]))
    expect(shown(rows).filter((key) => key.startsWith("c"))).toEqual([
      "c",
      "c/^d",
      "c/^d/^c (looped)",
    ])
    const looped = rows.find((row) => row.looped)!
    expect(looped.hasChildren).toBe(false)
    expect(looped.pivot).toBeUndefined()
    expect(rows.find((row) => row.key === "c/^d")!.hasChildren).toBe(true)
  })

  it("a two-block cycle walked down still shows one looped leaf", () => {
    expect(shown(rowsOf(new Map())).filter((key) => key.startsWith("c"))).toEqual([
      "c",
      "c/d",
      "c/d/c (looped)",
    ])
  })

  it("a single-homed block's rows are the tree's", () => {
    const tree = shown(rowsOf(new Map())).filter((key) => key.startsWith("a"))
    expect(tree).toEqual(["a", "a/x", "a/x/y"])
    expect(shown(rowsOf(new Map(), "both")).filter((key) => key.startsWith("a"))).toEqual(tree)
    // Up from X: A only, the row X came from, so X has nothing beneath it.
    const up = rowsOf(new Map([["x", "up"]]))
    expect(shown(up).filter((key) => key.startsWith("a"))).toEqual(["a", "a/x"])
    expect(up.find((row) => row.key === "a/x")!.hasChildren).toBe(false)
  })
})

describe("the selection as a path (docs/graph-walk.md, decision 2)", () => {
  const keys = ["a", "a/x", "a/x/^p", "b", "b/x"]

  it("crosses from a key to a path and back, in a note, a focus and an up region", () => {
    for (const key of ["a/x", "F/a/x", "a/x/^p"]) {
      expect(keyOfPath(pathOfKey(key))).toBe(key)
    }
    expect(pathIdsOf("a/x/^p")).toEqual(["a", "x", "p"])
  })

  it("lands on the row the path names", () => {
    expect(landingRow(keys, "b/x")).toBe("b/x")
    expect(landingRow(keys, "a/x/^p")).toBe("a/x/^p")
  })

  it("lands on the block's first row once it moved, and on nothing once it is gone", () => {
    expect(landingRow(keys, "c/x")).toBe("a/x")
    expect(landingRow(keys, "a/gone")).toBeNull()
  })
})
