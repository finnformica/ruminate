import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { buildGraphSnapshot, childIdsOf, noteView, walkGraph, type GraphSnapshot } from "./graph"
import { emptyLazyGraph, mergeFragment } from "./graph-patch"
import { applyOps, docToOps } from "./ops"
import { noteDoc } from "./graph"

const node = (id: string, type = "text"): NodeRow => ({
  id,
  type,
  text: id,
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

/** A lazily loaded graph: the note `n` with its first child only. */
const partial = (): GraphSnapshot =>
  mergeFragment(emptyLazyGraph(), {
    nodes: [node("n", "note"), node("a")],
    links: [link("n", "a", "a0")],
    loaded: [],
  })

describe("a lazily loaded graph", () => {
  it("the walk reports an open row whose children the graph holds in part", () => {
    const graph = partial()
    const view = noteView("n", graph)
    expect(view?.doc.rootBlockIds).toEqual(["a"])
    // The row `a`, open and not loaded, is reported too, though the graph
    // holds nothing beneath it: the load says whether it is a leaf.
    expect([...(view?.unloaded ?? [])]).toEqual(["a", "n"])
    // An open ROW beneath the root whose children are in part: reported,
    // and drawn with nothing beneath it, never the part in hand (Finn,
    // 2026-11-02). The row stays a row.
    const deeper = mergeFragment(graph, {
      nodes: [node("a"), node("a1")],
      links: [link("n", "a", "a0"), link("a", "a1", "a0")],
      loaded: ["n"],
    })
    const rows = noteView("n", deeper)
    expect([...(rows?.unloaded ?? [])]).toEqual(["a"])
    expect(rows?.doc.rootBlockIds).toEqual(["a"])
    expect(rows?.doc.blocks.a.children).toEqual([])
    // A closed row is drawn closed with what it holds, and not reported.
    const folded = walkGraph(["a"], deeper, { expanded: () => false, rootId: "n" })
    expect(folded.unloaded.size).toBe(0)
    expect(folded.doc.blocks.a.children).toEqual(["a1"])
    // Loaded whole, nothing is reported.
    const whole = mergeFragment(graph, {
      nodes: [node("a"), node("b")],
      links: [link("n", "a", "a0"), link("n", "b", "a1")],
      loaded: ["n", "a", "b"],
    })
    expect(noteView("n", whole)?.unloaded.size).toBe(0)
    expect(childIdsOf(whole, "n")).toEqual(["a", "b"])
    // A closed row is not reported: nothing beneath it is drawn.
    const closed = walkGraph(["a"], whole, { expanded: () => false, rootId: "n" })
    expect(closed.unloaded.size).toBe(0)
  })

  it("a whole graph reports nothing", () => {
    const graph = buildGraphSnapshot([node("n", "note"), node("a")], [link("n", "a", "a0")])
    expect(noteView("n", graph)?.unloaded.size).toBe(0)
  })

  it("a save never reconciles the children of a parent the graph holds in part", () => {
    const graph = partial()
    const doc = noteDoc("n", graph)!
    // The editor hands back the doc as shown, with a text edit: nothing is
    // unlinked beneath the note, though the graph holds one of its children.
    const edited = { ...doc, blocks: { ...doc.blocks, a: { ...doc.blocks.a, text: "a edited" } } }
    const ops = docToOps("n", edited, graph)
    expect(ops.map((op) => op.op)).toEqual(["setText"])
  })

  it("applyOps carries the loaded set, a created node loaded", () => {
    const graph = partial()
    const next = applyOps(
      graph,
      [
        { op: "create", id: "new", type: "text", text: "new", props: null, notesId: "n" },
        { op: "link", source: "n", destination: "new", sortKey: "a5" },
      ],
      2,
    )
    expect(next.loaded?.has("new")).toBe(true)
    expect(next.loaded?.has("n")).toBe(false)
    expect(applyOps(next, [{ op: "delete", id: "new" }], 3).loaded?.has("new")).toBe(false)
  })

  it("mergeFragment replaces a list held whole and adds to one held in part", () => {
    let graph = partial()
    graph = mergeFragment(graph, {
      nodes: [node("b")],
      links: [link("n", "b", "a1")],
      loaded: [],
    })
    expect(childIdsOf(graph, "n")).toEqual(["a", "b"])
    graph = mergeFragment(graph, {
      nodes: [node("c")],
      links: [link("n", "c", "a2")],
      loaded: ["n"],
    })
    expect(childIdsOf(graph, "n")).toEqual(["c"])
    expect(graph.loaded?.has("n")).toBe(true)
  })
})
