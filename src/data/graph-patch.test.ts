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

  it("on a lazy graph, a touched block whose children are not in hand stays unloaded", () => {
    // Finn, 2026-11-02: on a fresh device the log pull touched every note
    // while the graph held one preview child each; the patch marked the
    // note loaded, so expanding it showed the preview alone.
    const lazy = {
      ...buildGraphSnapshot([node("n"), node("a")], [link("n", "a", "a0")]),
      loaded: new Set<string>(),
    }
    const patched = patchSnapshot(lazy, keys(["n"]), {
      nodes: [node("n", "n edited")],
      // The store knows three children; the graph holds the node of one.
      links: [link("n", "a", "a0"), link("n", "b", "a1"), link("n", "c", "a2")],
    })
    expect(patched.nodes.get("n")?.text).toBe("n edited")
    expect(patched.loaded?.has("n")).toBe(false)
    // What it showed, still live, stays; nothing new under a partial list.
    expect(childIdsOf(patched, "n")).toEqual(["a"])
    // The far ends read beside the touched block (`patchGraph`): held as
    // nodes, so the list is whole and the block loaded; they stay unloaded.
    const withFar = patchSnapshot(lazy, keys(["n"]), {
      nodes: [node("n", "n edited"), node("b"), node("c")],
      links: [link("n", "a", "a0"), link("n", "b", "a1"), link("n", "c", "a2")],
    })
    expect(withFar.loaded?.has("n")).toBe(true)
    expect(withFar.loaded?.has("b")).toBe(false)
    expect(childIdsOf(withFar, "n")).toEqual(["a", "b", "c"])
    // Every child in hand (a block created with its children in one batch):
    // loaded, and the list whole.
    const whole = patchSnapshot(lazy, keys(["n", "b", "c"]), {
      nodes: [node("n"), node("b"), node("c")],
      links: [link("n", "a", "a0"), link("n", "b", "a1"), link("n", "c", "a2")],
    })
    expect(whole.loaded?.has("n")).toBe(true)
    expect(childIdsOf(whole, "n")).toEqual(["a", "b", "c"])
    // A block loaded before stays loaded, its list rebuilt from the store.
    const kept = patchSnapshot({ ...whole, loaded: new Set(["n"]) }, keys(["n"]), {
      nodes: [node("n")],
      links: [link("n", "a", "a0"), link("n", "c", "a2")],
    })
    expect(kept.loaded?.has("n")).toBe(true)
    expect(childIdsOf(kept, "n")).toEqual(["a", "c"])
  })

  it("does not touch the maps it was given", () => {
    const before = graph()
    patchSnapshot(before, keys(["a"], ["n|b|child"]), { nodes: [], links: [] })
    expect(childIdsOf(before, "n")).toEqual(["a", "b"])
    expect(before.nodes.has("a")).toBe(true)
  })
})
