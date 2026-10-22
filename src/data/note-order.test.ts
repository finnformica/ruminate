import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { unassignedIds } from "./basket"
import { CORPUS_ROOT_ID, ROOT_TYPE, buildGraphSnapshot, noteDoc, type GraphSnapshot } from "./graph"
import { moveNoteOps, orderedNoteIds } from "./note-order"
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

/** Move `id` so the Root frame reads `ids`, as a drag there does. */
const move = (snapshot: GraphSnapshot, id: string, ids: string[], at = NOW + 1) =>
  applyOps(snapshot, moveNoteOps(id, ids, snapshot), at)

describe("a drag in the Root frame (docs/graph-walk.md, decision 5)", () => {
  it("keys every row on the first drag, and makes the root", () => {
    const snapshot = move(graphOf(THREE), "c", ["c", "a", "b"])
    expect(orderedNoteIds(snapshot)).toEqual(["c", "a", "b"])
    expect(snapshot.nodes.get(CORPUS_ROOT_ID)?.type).toBe("corpus_root")
  })

  it("writes one link row for the note that moved, and none for the rest", () => {
    const placed = order(graphOf(THREE), ["a", "b", "c"])
    const ops = moveNoteOps("c", ["c", "a", "b"], placed)
    const links = ops.filter((op) => op.op === "link")
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ source: CORPUS_ROOT_ID, destination: "c" })
    expect(orderedNoteIds(applyOps(placed, ops, NOW + 2))).toEqual(["c", "a", "b"])
  })

  it("moves a note into the middle, and to the end", () => {
    const placed = order(graphOf(THREE), ["a", "b", "c"])
    expect(orderedNoteIds(move(placed, "a", ["b", "a", "c"], NOW + 2))).toEqual(["b", "a", "c"])
    expect(orderedNoteIds(move(placed, "a", ["b", "c", "a"], NOW + 2))).toEqual(["b", "c", "a"])
  })

  it("does nothing for a note that is not in the list", () => {
    const placed = order(graphOf(THREE), ["a", "b", "c"])
    expect(moveNoteOps("blk_nonesuch000", ["a", "b", "c"], placed)).toEqual([])
  })

  it("stamps updated_at on the note that moved, and only that one", () => {
    const placed = order(graphOf(THREE), ["a", "b", "c"])
    const moved = move(placed, "c", ["c", "a", "b"], NOW + 2)
    const stampOf = (id: string) =>
      (JSON.parse(moved.nodes.get(id)?.props ?? "{}") as { updated_at?: string }).updated_at
    expect(stampOf("c")).toBeDefined()
    expect(stampOf("a")).toBeUndefined()
    expect(stampOf("b")).toBeUndefined()
  })

  it("places a note the root did not hold yet, among the placed ones", () => {
    const placed = order(graphOf(THREE), ["a", "b"])
    expect(orderedNoteIds(move(placed, "c", ["a", "c", "b"], NOW + 2))).toEqual(["a", "c", "b"])
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
