import { describe, expect, it } from "vitest"
import { buildBlockHomesIndex } from "./block-homes"

describe("buildBlockHomesIndex", () => {
  it("maps each declared id to the notes whose content declares it, sorted by note", () => {
    const index = buildBlockHomesIndex({
      "blk_noteb.md": "- shared\n  id:: blk_shared0000\n- only in b\n  id:: blk_onlyb00000\n",
      "blk_notea.md": "- shared\n  id:: blk_shared0000\n  - child\n    id:: blk_child00000\n",
      "readme.txt": "id:: blk_notanote00",
    })
    expect(index.get("blk_shared0000")).toEqual(["blk_notea", "blk_noteb"])
    expect(index.get("blk_child00000")).toEqual(["blk_notea"])
    expect(index.get("blk_onlyb00000")).toEqual(["blk_noteb"])
    // Non-markdown entries are not notes.
    expect(index.has("blk_notanote00")).toBe(false)
  })

  it("counts a note once even when it declares the same id twice", () => {
    const index = buildBlockHomesIndex({
      "blk_notea.md": "- a\n  id:: blk_twice00000\n- b\n  id:: blk_twice00000\n",
    })
    expect(index.get("blk_twice00000")).toEqual(["blk_notea"])
  })

  it("ignores `id::` text that is not an id line", () => {
    const index = buildBlockHomesIndex({
      "blk_notea.md": "- the syntax is `id:: blk_x` on its own line\n  id:: blk_real000000\n",
    })
    expect([...index.keys()]).toEqual(["blk_real000000"])
  })
})
