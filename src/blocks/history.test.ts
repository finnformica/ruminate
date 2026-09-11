import { describe, expect, it } from "vitest"
import { emptyHistory, record, redo, undo } from "./history"
import type { BlockDoc } from "./types"

/** A doc whose single block's content is `text`, for terse assertions. */
function docWith(text: string): BlockDoc {
  return {
    props: null,
    rootBlockIds: ["a"],
    blocks: { a: { id: "a", type: "text", text, children: [] } },
  }
}

describe("history", () => {
  it("undoes a single change", () => {
    const d0 = docWith("")
    const d1 = docWith("hello")

    const h = record(emptyHistory(), d0, { type: "structural" })
    const result = undo(h, d1)

    expect(result?.doc).toBe(d0)
  })

  it("returns null when there is nothing to undo", () => {
    expect(undo(emptyHistory(), docWith("x"))).toBeNull()
    expect(redo(emptyHistory(), docWith("x"))).toBeNull()
  })

  it("undoes across separate changes, most recent first", () => {
    const d0 = docWith("")
    const d1 = docWith("a")
    const d2 = docWith("ab")

    let h = record(emptyHistory(), d0, { type: "structural" })
    h = record(h, d1, { type: "structural" })

    const first = undo(h, d2)
    expect(first?.doc).toBe(d1)
    const second = undo(first!.history, first!.doc)
    expect(second?.doc).toBe(d0)
  })

  it("coalesces consecutive text edits to the same block into one step", () => {
    const d0 = docWith("")
    const d1 = docWith("h")
    const d2 = docWith("he")

    let h = record(emptyHistory(), d0, { type: "text", blockId: "a" })
    h = record(h, d1, { type: "text", blockId: "a" })

    // Only the pre-run snapshot is kept, so one undo restores the empty doc.
    expect(h.past.map((e) => e.doc)).toEqual([d0])
    const result = undo(h, d2)
    expect(result?.doc).toBe(d0)
    expect(result?.history.past).toEqual([])
  })

  it("does not coalesce text edits to different blocks", () => {
    const d0 = docWith("")
    const d1 = docWith("a")

    let h = record(emptyHistory(), d0, { type: "text", blockId: "a" })
    h = record(h, d1, { type: "text", blockId: "b" })

    expect(h.past.map((e) => e.doc)).toEqual([d0, d1])
  })

  it("does not coalesce a text edit after a structural change", () => {
    const d0 = docWith("")
    const d1 = docWith("a")

    let h = record(emptyHistory(), d0, { type: "structural" })
    h = record(h, d1, { type: "text", blockId: "a" })

    expect(h.past.map((e) => e.doc)).toEqual([d0, d1])
  })

  it("remembers what a step created, hands it back on undo, and keeps it for redo", () => {
    const d0 = docWith("")
    const d1 = docWith("a")
    const d2 = docWith("ab")

    let h = record(emptyHistory(), d0, { type: "structural" }, ["b"])
    // A coalesced run owns everything it created.
    h = record(h, d1, { type: "text", blockId: "a" }, ["c"])
    h = record(h, d2, { type: "text", blockId: "a" }, ["d"])
    expect(h.past.map((e) => e.created)).toEqual([["b"], ["c", "d"]])

    const undone = undo(h, docWith("abc"))!
    expect(undone.created).toEqual(["c", "d"])
    const redone = redo(undone.history, undone.doc)!
    // Undoing the redone step reports the same creations again.
    expect(undo(redone.history, redone.doc)?.created).toEqual(["c", "d"])
  })

  it("redoes an undone change and clears redo on a new edit", () => {
    const d0 = docWith("")
    const d1 = docWith("a")

    const h = record(emptyHistory(), d0, { type: "structural" })
    const undone = undo(h, d1)!
    expect(undone.doc).toBe(d0)

    const redone = redo(undone.history, undone.doc)
    expect(redone?.doc).toBe(d1)

    // A fresh change after an undo drops the redo stack.
    const afterEdit = record(undone.history, d0, { type: "structural" })
    expect(afterEdit.future).toEqual([])
  })
})
