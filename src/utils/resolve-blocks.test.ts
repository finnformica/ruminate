import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { resolveBlockSubtrees } from "./resolve-blocks"

const FILES = {
  "a.md": [
    "- top",
    "  id:: blk_top0000000",
    "  - inner",
    "    id:: blk_inner00000",
    "- other",
    "  id:: blk_other00000",
    "",
  ].join("\n"),
  "b.md": "- b only\n  id:: blk_bonly00000\n",
  "not-a-note.json": '{ "id:: blk_top0000000": true }',
}

describe("resolveBlockSubtrees", () => {
  it("returns each id's whole live subtree as block markdown, ids intact", () => {
    const out = resolveBlockSubtrees(FILES, ["blk_top0000000", "blk_bonly00000"])
    expect(out["blk_top0000000"]).toBe(
      "- top\n  id:: blk_top0000000\n  - inner\n    id:: blk_inner00000\n",
    )
    expect(out["blk_bonly00000"]).toBe("- b only\n  id:: blk_bonly00000\n")
    // Round-trip: parse rebuilds the subtree under the original ids.
    const doc = parse(out["blk_top0000000"] as string)
    expect(doc.rootBlockIds).toEqual(["blk_top0000000"])
    expect(doc.blocks["blk_top0000000"].children).toEqual(["blk_inner00000"])
  })

  it("maps ids found nowhere to null (deleted since copy)", () => {
    expect(resolveBlockSubtrees(FILES, ["blk_missing000"])).toEqual({ blk_missing000: null })
  })

  it("never reads the excluded file (the note being pasted into is stale by definition)", () => {
    const out = resolveBlockSubtrees(FILES, ["blk_bonly00000"], "b.md")
    expect(out["blk_bonly00000"]).toBeNull()
  })
})
