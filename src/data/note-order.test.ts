import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { unassignedIds } from "./basket"
import { CORPUS_ROOT_ID, ROOT_TYPE, buildGraphSnapshot, noteDoc, type GraphSnapshot } from "./graph"
import { orderedNoteIds } from "./note-order"
import { applyOps, deleteBlockOps, deleteNoteOps, docToOps, type Op } from "./ops"

const NOW = 1000

/** A graph built the way the app builds one — through `docToOps`. */
function graphOf(notes: Record<string, string>): GraphSnapshot {
  let snapshot = buildGraphSnapshot([], [])
  for (const [id, markdown] of Object.entries(notes)) {
    snapshot = applyOps(snapshot, docToOps(id, parse(markdown), snapshot), NOW)
  }
  return snapshot
}

/** A manual order over a corpus, as the sidebar's drags once wrote one:
 * the corpus root, and a keyed link from it to each note in turn. */
const order = (snapshot: GraphSnapshot, ids: string[], at = NOW + 1) =>
  applyOps(
    snapshot,
    [
      ...(snapshot.nodes.has(CORPUS_ROOT_ID)
        ? []
        : [{ op: "create", id: CORPUS_ROOT_ID, type: ROOT_TYPE, text: "", props: null } as Op]),
      ...ids.map((id, index): Op => ({
        op: "link",
        source: CORPUS_ROOT_ID,
        destination: id,
        sortKey: `a${index}`,
      })),
    ],
    at,
  )

const THREE = { a: "- a\n", b: "- b\n", c: "- c\n" }

describe("the manual note order the graph holds", () => {
  it("is empty while nothing was ever dragged — no root row, no order", () => {
    const snapshot = graphOf(THREE)
    expect(orderedNoteIds(snapshot)).toEqual([])
    expect(snapshot.nodes.has(CORPUS_ROOT_ID)).toBe(false)
  })

  it("reads the order the notes were put in", () => {
    const snapshot = order(graphOf(THREE), ["c", "a", "b"])
    expect(orderedNoteIds(snapshot)).toEqual(["c", "a", "b"])
    expect(snapshot.nodes.get(CORPUS_ROOT_ID)?.type).toBe("corpus_root")
  })

  it("drops a deleted note from the order, leaving the rest in place", () => {
    const placed = order(graphOf(THREE), ["a", "b", "c"])
    const deleted = applyOps(placed, deleteNoteOps("b", placed), NOW + 2)
    expect(orderedNoteIds(deleted)).toEqual(["a", "c"])
  })

  it("leaves a note with no manual position out of the order", () => {
    const placed = order(graphOf(THREE), ["a", "b", "c"])
    const withNew = applyOps(placed, docToOps("d", parse("- d\n"), placed), NOW + 2)
    expect(orderedNoteIds(withNew)).toEqual(["a", "b", "c"])
  })

  it("ignores ids that are not notes", () => {
    const next = order(graphOf(THREE), ["a", "blk_nonesuch000", "b"])
    expect(orderedNoteIds(next)).toEqual(["a", "b"])
  })
})

describe("the corpus root is neither a note nor a block", () => {
  it("never lands in the Unassigned basket, though nothing reaches it", () => {
    const snapshot = order(graphOf(THREE), ["c", "b", "a"])
    expect([...unassignedIds(snapshot)]).toEqual([])
  })

  it("never shows as a note's upstream", () => {
    const snapshot = order(graphOf(THREE), ["c", "b", "a"])
    expect(noteDoc("a", snapshot)?.upstream ?? []).toEqual([])
  })

  it("does not rescue the corpus when a block is deleted", () => {
    // The root is parentless, so an unguarded delete-rescue would walk from
    // it, reach every note, and conclude that nothing may be deleted.
    const base = graphOf({
      a: "- one\n  id:: blk_one0000000\n  - under\n    id:: blk_under00000\n",
    })
    const snapshot = order(base, ["a"])
    const next = applyOps(snapshot, deleteBlockOps("blk_one0000000", snapshot), NOW + 2)
    expect(next.nodes.has("blk_one0000000")).toBe(false)
    // What it held is rescued to the basket, exactly as without a root.
    expect([...unassignedIds(next)]).toEqual(["blk_under00000"])
  })
})
