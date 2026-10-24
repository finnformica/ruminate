import { describe, expect, it } from "vitest"
import { CORPUS_ROOT_ID } from "./graph"
import { ROOT_LABEL, isRootFrame, rootFrame } from "./root-frame"

describe("the Root frame (docs/graph-walk.md, decision 5)", () => {
  it("is rooted at the corpus root and called Root", () => {
    expect(rootFrame()).toEqual({ noteId: CORPUS_ROOT_ID, root: null, selected: null })
    expect(isRootFrame(rootFrame())).toBe(true)
    expect(isRootFrame({ noteId: "blk_a" })).toBe(false)
    expect(ROOT_LABEL).toBe("Root")
  })
})
