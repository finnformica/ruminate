import { describe, expect, it } from "vitest"
import { buildGraphSnapshot, docToGraph } from "../data/graph"
import { applyOps } from "../data/ops"
import { buildUpstreamIndex } from "./block-upstream"

function graphOf(pages: Record<string, string>) {
  const nodes = []
  const links = []
  for (const [id, markdown] of Object.entries(pages)) {
    const g = docToGraph(id, markdown, 1)
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  return buildGraphSnapshot(nodes, links)
}

describe("buildUpstreamIndex", () => {
  it("maps each block to the pages that reach it, sorted by page", () => {
    const base = graphOf({
      blk_noteb: "- only in b\n  id:: blk_onlyb00000\n",
      blk_notea: "- shared\n  id:: blk_shared0000\n  - child\n    id:: blk_child00000\n",
    })
    // b links a's shared block too — one node, two pages upstream.
    const snapshot = applyOps(
      base,
      [{ op: "link", source: "blk_noteb", destination: "blk_shared0000", sortKey: "a1" }],
      2,
    )
    const index = buildUpstreamIndex(snapshot)
    expect([...(index.get("blk_shared0000") ?? [])].sort()).toEqual(["blk_notea", "blk_noteb"])
    expect([...(index.get("blk_child00000") ?? [])].sort()).toEqual(["blk_notea", "blk_noteb"])
    expect(index.get("blk_onlyb00000")).toEqual(["blk_noteb"])
    expect(index.has("blk_notea")).toBe(false)
  })

  it("counts a page once even when it reaches a block by two paths", () => {
    const base = graphOf({
      blk_notea: "- a\n  id:: blk_a000000000\n- b\n  id:: blk_b000000000\n",
    })
    const snapshot = applyOps(
      base,
      [{ op: "link", source: "blk_b000000000", destination: "blk_a000000000", sortKey: "a0" }],
      2,
    )
    expect(buildUpstreamIndex(snapshot).get("blk_a000000000")).toEqual(["blk_notea"])
  })
})
