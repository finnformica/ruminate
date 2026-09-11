import { describe, expect, it } from "vitest"
import { parse } from "./parse"
import type { BlockDoc } from "./types"
import {
  ancestorKeys,
  buildRows,
  firstOccurrenceKey,
  hasOccurrence,
  idOfKey,
  isWithin,
  keyOf,
  occurrenceKeys,
  parentKeyOf,
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
    expect(rows.every((row) => !row.zoomTitle)).toBe(true)
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

  it("zoomed: the root leads as the title and its children start at depth 0", () => {
    const rows = buildRows(outline, { zoomRootId: "b", folds: NONE })
    expect(summary(rows)).toEqual(["a/b", "a/b/c"])
    expect(rows[0]).toMatchObject({ zoomTitle: true, depth: 0, collapsed: false, guideKeys: [] })
    expect(rows[1]).toMatchObject({ zoomTitle: false, depth: 0, parentKey: "a/b", guideKeys: [] })
    // Deeper rows count their guides from the zoom root's children, not the page.
    const deep = buildRows(outline, { zoomRootId: "a", folds: NONE })
    expect(deep.find((row) => row.key === "a/b/c")).toMatchObject({ depth: 1, guideKeys: ["a/b"] })
  })

  it("zoomed: the title is always open, and folds made here are the page's folds", () => {
    const rows = buildRows(outline, { zoomRootId: "a", folds: new Set(["a", "a/b"]) })
    expect(summary(rows)).toEqual(["a", "a/b ▸", "a/d", "a/e"])
  })

  it("zoomed into an unknown block: the whole page", () => {
    expect(buildRows(outline, { zoomRootId: "nope", folds: NONE })).toHaveLength(6)
  })
})
