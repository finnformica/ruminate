import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { buildGraphSnapshot, childIdsOf, parentIdsOf } from "./graph"
import { patchSnapshot } from "./graph-patch"

const node = (id: string, text = id): NodeRow => ({
  id,
  type: id === "n" ? "note" : "text",
  text,
  props: null,
  updated_at: 1,
})
const link = (source: string, destination: string, sortKey: string): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: "child",
  sort_key: sortKey,
  updated_at: 1,
})

const graph = () =>
  buildGraphSnapshot(
    [node("n"), node("a"), node("b"), node("c")],
    [link("n", "a", "a0"), link("n", "b", "a1"), link("a", "c", "a0")],
  )

const keys = (blocks: string[] = [], links: string[] = []) => ({
  blocks: new Set(blocks),
  links: new Set(links),
})

describe("patchSnapshot", () => {
  it("replaces a touched node and leaves the rest as they were", () => {
    const before = graph()
    const after = patchSnapshot(before, keys(["a"]), {
      nodes: [node("a", "A edited")],
      links: [link("n", "a", "a0"), link("a", "c", "a0")],
    })
    expect(after.nodes.get("a")?.text).toBe("A edited")
    expect(after.nodes.get("b")).toBe(before.nodes.get("b"))
    expect(childIdsOf(after, "n")).toEqual(["a", "b"])
    expect(childIdsOf(after, "a")).toEqual(["c"])
  })

  it("a touched block the store no longer holds goes, with every link at it", () => {
    const after = patchSnapshot(graph(), keys(["a"]), { nodes: [], links: [] })
    expect(after.nodes.has("a")).toBe(false)
    expect(childIdsOf(after, "n")).toEqual(["b"])
    expect(after.childLinks.has("a")).toBe(false)
    expect(parentIdsOf(after, "c")).toEqual([])
  })

  it("a revived block brings its live links back, in sibling order", () => {
    const without = patchSnapshot(graph(), keys(["a"]), { nodes: [], links: [] })
    const after = patchSnapshot(without, keys(["a"]), {
      nodes: [node("a")],
      links: [link("n", "a", "a0"), link("a", "c", "a0")],
    })
    expect(childIdsOf(after, "n")).toEqual(["a", "b"])
    expect(childIdsOf(after, "a")).toEqual(["c"])
    expect(parentIdsOf(after, "c")).toEqual(["a"])
  })

  it("a touched link lands, moves or goes on its own", () => {
    const moved = patchSnapshot(graph(), keys([], ["n|b|child"]), {
      nodes: [],
      links: [link("n", "b", "a5")],
    })
    expect(childIdsOf(moved, "n")).toEqual(["a", "b"])
    expect(moved.childLinks.get("n")?.[1].sort_key).toBe("a5")
    const reordered = patchSnapshot(graph(), keys([], ["n|b|child"]), {
      nodes: [],
      links: [link("n", "b", "00")],
    })
    expect(childIdsOf(reordered, "n")).toEqual(["b", "a"])
    const gone = patchSnapshot(graph(), keys([], ["n|b|child"]), { nodes: [], links: [] })
    expect(childIdsOf(gone, "n")).toEqual(["a"])
    expect(parentIdsOf(gone, "b")).toEqual([])
  })

  it("keeps a link only when both ends are in the graph, and only a child link", () => {
    const after = patchSnapshot(graph(), keys([], ["n|x|child", "n|a|other"]), {
      nodes: [],
      links: [link("n", "x", "a2"), { ...link("n", "a", "a9"), kind: "other" }],
    })
    expect(childIdsOf(after, "n")).toEqual(["a", "b"])
  })

  it("does not touch the maps it was given", () => {
    const before = graph()
    patchSnapshot(before, keys(["a"], ["n|b|child"]), { nodes: [], links: [] })
    expect(childIdsOf(before, "n")).toEqual(["a", "b"])
    expect(before.nodes.has("a")).toBe(true)
  })
})
