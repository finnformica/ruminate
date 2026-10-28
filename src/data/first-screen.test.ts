import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { expandedByDepth } from "../blocks/default-collapsed"
import { FIRST_SCREEN_ROWS, framesOnScreen, loadFirstScreen } from "./first-screen"
import { CORPUS_ROOT_ID, noteView, rootView } from "./graph"
import { docToOps } from "./ops"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore } from "./sql-note-store"
import { applyOpsToStore } from "./store-test-support"

const DEEP =
  "- A\n  id:: blk_a000000000\n" +
  "  - A1\n    id:: blk_a100000000\n" +
  "    - A2\n      id:: blk_a200000000\n" +
  "      - A3\n        id:: blk_a300000000\n" +
  "- B\n  id:: blk_b000000000\n"
const OTHER = "- C\n  id:: blk_c000000000\n  - C1\n    id:: blk_c100000000\n"

async function seeded() {
  const store = await openSqlNoteStore(createNodeSqlDriver())
  for (const [id, markdown] of Object.entries({ "note-deep": DEEP, "note-other": OTHER })) {
    await applyOpsToStore(store, docToOps(id, parse(markdown), await store.getGraph()))
  }
  return store
}

describe("framesOnScreen", () => {
  it("reads the frame on top from the address", () => {
    expect(framesOnScreen({ pathname: "/", search: "" }, 2)).toEqual([
      { id: CORPUS_ROOT_ID, depth: 1 },
    ])
    expect(framesOnScreen({ pathname: "/views/corpus_root", search: "" }, 2)).toEqual([
      { id: CORPUS_ROOT_ID, depth: 1 },
    ])
    expect(framesOnScreen({ pathname: "/views/note-a", search: "" }, 2)).toEqual([
      { id: "note-a", depth: 2 },
    ])
    expect(
      framesOnScreen({ pathname: "/views/note-a", search: "?block=blk_x&depth=4" }, 2),
    ).toEqual([{ id: "blk_x", depth: 4 }])
  })

  it("has no frame on a page that is not a view", () => {
    expect(framesOnScreen({ pathname: "/calendar/2026-10-28", search: "" }, 2)).toEqual([])
    expect(framesOnScreen({ pathname: "/settings", search: "" }, 2)).toEqual([])
  })
})

describe("loadFirstScreen", () => {
  it("reads every note, and a note frame one level past its depth", async () => {
    const store = await seeded()
    const graph = await loadFirstScreen(store, [{ id: "note-deep", depth: 2 }], [])

    expect(graph.nodes.has("note-other")).toBe(true)
    expect(graph.nodes.has("blk_c000000000")).toBe(false)
    expect([...graph.nodes.keys()].filter((id) => id.startsWith("blk_a")).sort()).toEqual([
      "blk_a000000000",
      "blk_a100000000",
      "blk_a200000000",
    ])
    // The frame draws as the whole graph draws it, chevrons too.
    const whole = await store.getGraph()
    expect(noteView("note-deep", graph, expandedByDepth(2))).toEqual(
      noteView("note-deep", whole, expandedByDepth(2)),
    )
  })

  it("reads the Root frame's notes, each with the one child its chevron needs", async () => {
    const store = await seeded()
    const graph = await loadFirstScreen(store, [{ id: CORPUS_ROOT_ID, depth: 1 }], [])

    expect(graph.nodes.has("blk_a000000000")).toBe(true)
    expect(graph.nodes.has("blk_b000000000")).toBe(false)
    expect(graph.nodes.has("blk_c000000000")).toBe(true)
    expect(graph.nodes.has("blk_c100000000")).toBe(false)
    // The same rows, closed the same way, with a chevron on the same rows.
    const drawn = (view: ReturnType<typeof rootView>) => ({
      rows: view.doc.rootBlockIds,
      collapsed: [...view.collapsed],
      chevrons: view.doc.rootBlockIds.filter((id) => view.doc.blocks[id].children.length > 0),
    })
    const whole = await store.getGraph()
    expect(drawn(rootView(graph, expandedByDepth(1)))).toEqual(
      drawn(rootView(whole, expandedByDepth(1))),
    )
  })

  it("reads the Root frame whole beneath the notes when its depth opens them", async () => {
    const store = await seeded()
    const graph = await loadFirstScreen(store, [{ id: CORPUS_ROOT_ID, depth: 2 }], [])

    const whole = await store.getGraph()
    expect(rootView(graph, expandedByDepth(2))).toEqual(rootView(whole, expandedByDepth(2)))
  })

  it("reads a node twice frames walk through once, and the deeper frame wins", async () => {
    const store = await seeded()
    const graph = await loadFirstScreen(
      store,
      [
        { id: CORPUS_ROOT_ID, depth: 1 },
        { id: "note-deep", depth: 3 },
      ],
      [],
    )

    expect(graph.nodes.has("blk_a300000000")).toBe(true)
    expect(graph.childLinks.get("note-deep")?.map((link) => link.destination_id)).toEqual([
      "blk_a000000000",
      "blk_b000000000",
    ])
  })

  it("reads a long note's first rows in display order, and no more", async () => {
    const store = await openSqlNoteStore(createNodeSqlDriver())
    let markdown = "- R1\n  id:: blk_r000000001\n  - R1 child\n    id:: blk_k000000001\n"
    for (let i = 2; i <= 400; i += 1) {
      markdown += `- R${i}\n  id:: blk_r${String(i).padStart(9, "0")}\n`
    }
    await applyOpsToStore(store, docToOps("note-long", parse(markdown), await store.getGraph()))

    const graph = await loadFirstScreen(store, [{ id: "note-long", depth: 2 }], [])

    expect(graph.nodes.has("blk_r000000001")).toBe(true)
    expect(graph.nodes.has("blk_k000000001")).toBe(true)
    // The note, R1, R1's child, then R2 on: the limit falls at R298.
    expect(graph.nodes.has(`blk_r${String(FIRST_SCREEN_ROWS - 2).padStart(9, "0")}`)).toBe(true)
    expect(graph.nodes.has(`blk_r${String(FIRST_SCREEN_ROWS - 1).padStart(9, "0")}`)).toBe(false)
    expect(graph.nodes.has("blk_r000000400")).toBe(false)
  })

  it("reads the roots of the views", async () => {
    const store = await seeded()
    const graph = await loadFirstScreen(store, [], ["blk_c100000000"])

    expect(graph.nodes.has("blk_c100000000")).toBe(true)
  })
})
