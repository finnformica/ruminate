import { describe, expect, it } from "vitest"
import { updateText } from "../blocks/ops"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { buildGraphSnapshot, pageDoc, type GraphSnapshot } from "./graph"
import { basketDoc, basketRootIds, basketToOps, unassignedIds } from "./basket"
import { applyOps, deleteBlockOps, docToOps } from "./ops"

const NOW = 1000

/** A graph built the way the app builds one — through `docToOps`, so every
 * block carries its page's id as `notes_id`. */
function graphOf(pages: Record<string, string>): GraphSnapshot {
  let snapshot = buildGraphSnapshot([], [])
  for (const [id, markdown] of Object.entries(pages)) {
    snapshot = applyOps(snapshot, docToOps(id, parse(markdown), snapshot), NOW)
  }
  return snapshot
}

const A =
  "- one\n  id:: blk_one0000000\n  - under one\n    id:: blk_under00000\n    - deeper\n      id:: blk_deeper0000\n- two\n  id:: blk_two0000000\n"

describe("the Unassigned basket", () => {
  it("is empty while every block is reached", () => {
    const snapshot = graphOf({ a: A })
    expect(unassignedIds(snapshot).size).toBe(0)
    expect(basketRootIds("a", snapshot)).toEqual([])
  })

  it("holds what a deleted block held, nested as it was, keyed by its notes_id", () => {
    const snapshot = graphOf({ a: A, b: "- b\n  id:: blk_b000000000\n" })
    const next = applyOps(snapshot, deleteBlockOps("blk_one0000000", snapshot), NOW + 1)
    expect([...unassignedIds(next)].sort()).toEqual(["blk_deeper0000", "blk_under00000"])
    // `deeper` is still under `under`, so the basket has one root.
    expect(basketRootIds("a", next)).toEqual(["blk_under00000"])
    expect(serialize(basketDoc("a", next))).toBe(
      "- under one\n  id:: blk_under00000\n  - deeper\n    id:: blk_deeper0000\n",
    )
    // It is a's basket, not b's: `notes_id` decides.
    expect(basketRootIds("b", next)).toEqual([])
    // The outline is untouched.
    expect(serialize(pageDoc("a", next)!)).toBe("- two\n  id:: blk_two0000000\n")
  })

  it("shows a loop that nothing reaches, promoting one member as its root", () => {
    const snapshot = graphOf({ a: A })
    // deeper → under: a loop below `one`.
    const looped = applyOps(
      snapshot,
      [{ op: "link", source: "blk_deeper0000", destination: "blk_under00000", sortKey: "a0" }],
      NOW,
    )
    const next = applyOps(looped, deleteBlockOps("blk_one0000000", looped), NOW + 1)
    expect([...unassignedIds(next)].sort()).toEqual(["blk_deeper0000", "blk_under00000"])
    expect(basketRootIds("a", next)).toEqual(["blk_deeper0000"])
    const doc = basketDoc("a", next)
    expect(doc.rootBlockIds).toEqual(["blk_deeper0000"])
    expect(Object.keys(doc.blocks).sort()).toEqual(["blk_deeper0000", "blk_under00000"])
  })

  it("lists roots most recently changed first", () => {
    const snapshot = graphOf({ a: A })
    const next = applyOps(
      snapshot,
      [
        {
          op: "create",
          id: "blk_old0000000",
          type: "text",
          text: "old",
          props: null,
          notesId: "a",
        },
      ],
      NOW - 10,
    )
    const later = applyOps(
      next,
      [
        {
          op: "create",
          id: "blk_new0000000",
          type: "text",
          text: "new",
          props: null,
          notesId: "a",
        },
      ],
      NOW + 10,
    )
    expect(basketRootIds("a", later)).toEqual(["blk_new0000000", "blk_old0000000"])
  })

  it("leaves the basket once something links it again", () => {
    const snapshot = graphOf({ a: A })
    const dropped = applyOps(snapshot, deleteBlockOps("blk_one0000000", snapshot), NOW + 1)
    expect(basketRootIds("a", dropped)).toEqual(["blk_under00000"])
    // Paste-as-link puts `under` beneath `two`.
    const relinked = applyOps(
      dropped,
      [{ op: "link", source: "blk_two0000000", destination: "blk_under00000", sortKey: "a0" }],
      NOW + 2,
    )
    expect(basketRootIds("a", relinked)).toEqual([])
    expect(serialize(pageDoc("a", relinked)!)).toContain("  - under one")
  })
})

describe("basketToOps", () => {
  const basketed = () => {
    const snapshot = graphOf({ a: A })
    return applyOps(snapshot, deleteBlockOps("blk_one0000000", snapshot), NOW + 1)
  }

  it("an unchanged basket is no ops at all", () => {
    const snapshot = basketed()
    expect(basketToOps("a", basketDoc("a", snapshot), snapshot)).toEqual([])
  })

  it("typing in the basket is one setText, and never touches the outline", () => {
    const snapshot = basketed()
    const doc = updateText(basketDoc("a", snapshot), "blk_under00000", "edited")
    const ops = basketToOps("a", doc, snapshot)
    expect(ops).toEqual([{ op: "setText", id: "blk_under00000", text: "edited" }])
    const next = applyOps(snapshot, ops, NOW + 2)
    expect(serialize(pageDoc("a", next)!)).toBe("- two\n  id:: blk_two0000000\n")
  })

  it("deleting a basket root deletes it; what it held stays in the basket", () => {
    const snapshot = basketed()
    const ops = basketToOps("a", parse(""), snapshot)
    expect(ops).toEqual([{ op: "delete", id: "blk_under00000" }])
    const next = applyOps(snapshot, ops, NOW + 2)
    expect(next.nodes.has("blk_deeper0000")).toBe(true)
    expect(basketRootIds("a", next)).toEqual(["blk_deeper0000"])
  })

  it("a block written in the basket is created with the page as its note, hanging from nothing", () => {
    const snapshot = basketed()
    const doc = parse(serialize(basketDoc("a", snapshot)) + "- fresh\n  id:: blk_fresh00000\n")
    const ops = basketToOps("a", doc, snapshot)
    expect(ops).toEqual([
      { op: "create", id: "blk_fresh00000", type: "ul", text: "fresh", props: null, notesId: "a" },
    ])
    const next = applyOps(snapshot, ops, NOW + 2)
    expect(basketRootIds("a", next).sort()).toEqual(["blk_fresh00000", "blk_under00000"])
    expect(serialize(pageDoc("a", next)!)).toBe("- two\n  id:: blk_two0000000\n")
  })
})
