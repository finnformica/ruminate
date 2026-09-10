import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { buildGraphSnapshot, docToGraph } from "../data/graph"
import { resolveBlockSubtrees } from "./resolve-blocks"

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

const SNAPSHOT = graphOf({
  a: [
    "- top",
    "  id:: blk_top0000000",
    "  - inner",
    "    id:: blk_inner00000",
    "- other",
    "  id:: blk_other00000",
    "",
  ].join("\n"),
  b: "- b only\n  id:: blk_bonly00000\n",
})

describe("resolveBlockSubtrees", () => {
  it("returns each id's whole live subtree as block markdown, ids intact", () => {
    const out = resolveBlockSubtrees(SNAPSHOT, ["blk_top0000000", "blk_bonly00000"])
    expect(out["blk_top0000000"]).toBe(
      "- top\n  id:: blk_top0000000\n  - inner\n    id:: blk_inner00000\n",
    )
    expect(out["blk_bonly00000"]).toBe("- b only\n  id:: blk_bonly00000\n")
    // Round-trip: parse rebuilds the subtree under the original ids.
    const doc = parse(out["blk_top0000000"] as string)
    expect(doc.rootBlockIds).toEqual(["blk_top0000000"])
    expect(doc.blocks["blk_top0000000"].children).toEqual(["blk_inner00000"])
  })

  it("maps ids the graph does not hold to null (deleted since copy)", () => {
    expect(resolveBlockSubtrees(SNAPSHOT, ["blk_missing000"])).toEqual({ blk_missing000: null })
  })
})
