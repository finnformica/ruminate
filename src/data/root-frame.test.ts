import { describe, expect, it } from "vitest"
import type { Note } from "../schema"
import { CORPUS_ROOT_ID } from "./graph"
import { ROOT_LABEL, isRootFrame, rootFrame, rootFrameNotes } from "./root-frame"

const note = (id: string, displayName: string) => ({ id, displayName }) as Note

describe("the Root frame (docs/graph-walk.md, decision 5)", () => {
  it("is rooted at the corpus root and called Root", () => {
    expect(rootFrame()).toEqual({ noteId: CORPUS_ROOT_ID, root: null, selected: null })
    expect(isRootFrame(rootFrame())).toBe(true)
    expect(isRootFrame({ noteId: "blk_a" })).toBe(false)
    expect(ROOT_LABEL).toBe("Root")
  })

  it("lists the notes the root links first, in their order, then the rest by title", () => {
    const notes = [note("c", "Cherry"), note("a", "apple"), note("b", "Banana"), note("d", "Date")]
    const rows = rootFrameNotes(notes, ["d", "b"])
    expect(rows.map((row) => row.id)).toEqual(["d", "b", "a", "c"])
  })

  it("skips a placed id that is no live note, and names each note once", () => {
    const notes = [note("a", "A"), note("b", "B")]
    expect(rootFrameNotes(notes, ["gone", "b", "b"]).map((row) => row.id)).toEqual(["b", "a"])
  })

  it("breaks a tie on the title by id", () => {
    const notes = [note("y", "Same"), note("x", "Same")]
    expect(rootFrameNotes(notes, []).map((row) => row.id)).toEqual(["x", "y"])
  })
})
