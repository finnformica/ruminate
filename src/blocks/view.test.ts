import { describe, expect, it } from "vitest"
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
  occurrenceKeys,
  parentKeyOf,
  pathIdsOf,
  rowsBeneath,
  siblingKey,
  zoomRootKey,
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

  it("address the zoomed block by its first occurrence", () => {
    expect(zoomRootKey(shared, "s")).toBe("p/s")
    expect(zoomRootKey(shared, "nope")).toBe("nope")
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

  it("zoomed: the rows are the root's children, from depth 0 — the root is the title, not a row", () => {
    const rows = buildRows(outline, { zoomRootId: "b", folds: NONE })
    expect(summary(rows)).toEqual(["a/b/c"])
    expect(rows[0]).toMatchObject({ depth: 0, parentKey: "a/b", guideKeys: [] })
    // Deeper rows count their guides from the zoom root's children, not the note.
    const deep = buildRows(outline, { zoomRootId: "a", folds: NONE })
    expect(deep.find((row) => row.key === "a/b/c")).toMatchObject({ depth: 1, guideKeys: ["a/b"] })
  })

  it("zoomed: the title is always open, and folds made here are the note's folds", () => {
    const rows = buildRows(outline, { zoomRootId: "a", folds: new Set(["a", "a/b"]) })
    expect(summary(rows)).toEqual(["a/b ▸", "a/d", "a/e"])
  })

  it("zoomed into an unknown block: the whole note", () => {
    expect(buildRows(outline, { zoomRootId: "nope", folds: NONE })).toHaveLength(6)
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

  it("rowsBeneath: children first, then the parents not already on the path", () => {
    expect(rowsBeneath(graphed, graphed.blocks.s, new Set(["n", "a", "s"]))).toEqual([
      { id: "p", direction: "up" },
    ])
    expect(rowsBeneath(graphed, graphed.blocks.a, new Set(["n", "a"]))).toEqual([
      { id: "s", direction: "down" },
    ])
    expect(rowsBeneath(graphed, null, new Set(["n"]))).toEqual([
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

  it("buildRows folds an upstream row like any other, and zoomed shows the root's parents", () => {
    const folded = buildRows(graphed, { folds: new Set(["a/s/^p"]), rootId: "n" })
    expect(summary(folded)).toEqual(["a", "  a/s", "    a/s/^p ▸", "b"])
    // Zoomed into s: its parents are all the rows, a and p alike, each with
    // its note beneath — a fresh path starts at the zoom root. Beneath the
    // note, the row it was reached up from (a) is not listed, its other
    // block (b) is: the graph around the block, as far as it is open.
    const zoomed = buildRows(graphed, { folds: NONE, zoomRootId: "s" })
    expect(summary(zoomed)).toEqual([
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
      null,
      0,
      new Set(["n"]),
    )
    expect(seen).toEqual(["a", "a/s", "↑a/s/^p", "↑a/s/^p/^q", "b"])
    expect(occurrenceKeys({ ...graphed, upstream: ["q"] })).toContain("^q")
  })
})
