import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { keysOfEvents, patchGraph } from "./graph-patch"
import type { GraphSnapshot } from "./graph"
import { deleteBlockOps, deleteNoteOps, docToOps, type Op } from "./ops"
import { createNodeSqlDriver } from "./sql-node-test-driver"
import { openSqlNoteStore } from "./sql-note-store"
import { applyOpsToStore } from "./store-test-support"

const NOTE_A =
  "- A\n  id:: blk_a000000000\n" +
  "  - A1\n    id:: blk_a100000000\n" +
  "- B\n  id:: blk_b000000000\n"
const NOTE_C = "- C\n  id:: blk_c000000000\n"

async function seeded() {
  const store = await openSqlNoteStore(createNodeSqlDriver())
  for (const [id, markdown] of Object.entries({ "note-a": NOTE_A, "note-c": NOTE_C })) {
    await applyOpsToStore(store, docToOps(id, parse(markdown), await store.getGraph()))
  }
  return store
}

describe("patchGraph", () => {
  const cases: [string, (graph: GraphSnapshot) => Op[]][] = [
    ["a text edit", () => [{ op: "setText", id: "blk_b000000000", text: "B edited" }]],
    [
      "a new block",
      (graph) => [
        { op: "create", id: "blk_n000000000", type: "text", text: "N", props: null },
        {
          op: "link",
          source: "blk_a000000000",
          destination: "blk_n000000000",
          sortKey: `${graph.childLinks.get("blk_a000000000")?.at(-1)?.sort_key}0`,
        },
      ],
    ],
    ["a block delete", (graph) => deleteBlockOps("blk_a000000000", graph)],
    [
      "a move",
      () => [
        { op: "unlink", source: "blk_a000000000", destination: "blk_a100000000" },
        { op: "link", source: "note-c", destination: "blk_a100000000", sortKey: "b0" },
      ],
    ],
    ["a note delete", (graph) => deleteNoteOps("note-a", graph)],
  ]

  for (const [name, change] of cases) {
    it(`reads what ${name} names, and the graph equals a whole read`, async () => {
      const store = await seeded()
      const before = await store.getGraph()
      const events = await applyOpsToStore(store, change(before))

      const patched = await patchGraph(store, before, keysOfEvents(events))

      expect(patched).toEqual(await store.getGraph())
    })
  }

  it("keeps the object of every row the page does not name", async () => {
    const store = await seeded()
    const before = await store.getGraph()
    const events = await applyOpsToStore(store, [
      { op: "setText", id: "blk_b000000000", text: "B edited" },
    ])

    const patched = await patchGraph(store, before, keysOfEvents(events))

    expect(patched.nodes.get("blk_c000000000")).toBe(before.nodes.get("blk_c000000000"))
    expect(patched.childLinks.get("note-c")?.[0]).toBe(before.childLinks.get("note-c")?.[0])
    expect(patched.nodes.get("blk_b000000000")?.text).toBe("B edited")
  })
})
