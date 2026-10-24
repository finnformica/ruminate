import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import type { BlockDoc } from "../blocks/types"
import { BOARD_TYPE, CORPUS_ROOT_ID, NOTE_TYPE, buildGraphSnapshot, rootView } from "../data/graph"
import type { Op } from "../data/ops"
import { rootToOps } from "./results-doc"

/**
 * **The Root frame's edit** (`rootToOps`, docs/graph-walk.md, decision 5):
 * the rows beneath a note row edit as they do in the note, a note row's
 * text is the note's title, and a move of one note row is the root's link
 * to it. The notes the root does not link get no link row.
 */

const node = (id: string, text: string, type = "text"): NodeRow => ({
  id,
  type,
  text,
  props: null,
  updated_at: 0,
})
const link = (source: string, destination: string, sortKey = "a0"): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: "child",
  sort_key: sortKey,
  updated_at: 0,
})

// The root links Cherry; Apple and a board, Banana, are not placed.
const graph = buildGraphSnapshot(
  [
    node(CORPUS_ROOT_ID, "", "corpus_root"),
    node("c", "Cherry", NOTE_TYPE),
    node("a", "Apple", NOTE_TYPE),
    node("b", "Banana", BOARD_TYPE),
    node("blk_seed", "Seed"),
  ],
  [link(CORPUS_ROOT_ID, "c"), link("a", "blk_seed")],
)
const shown = rootView(graph).doc

const withBlocks = (doc: BlockDoc, patch: Partial<BlockDoc>): BlockDoc => ({ ...doc, ...patch })
const rootLinks = (ops: Op[]) =>
  ops.filter((op) => op.op === "link" && op.source === CORPUS_ROOT_ID)

describe("rootToOps", () => {
  it("writes the root's link for a moved note row", () => {
    const next = withBlocks(shown, { rootBlockIds: ["a", "c", "b"] })
    const ops = rootToOps(next, shown, graph, { movable: true })
    // The first move keys the rows in the order on screen (`moveNoteOps`).
    expect(rootLinks(ops).map((op) => op.op === "link" && op.destination)).toEqual(["a", "c", "b"])
  })

  it("writes no order when the rows may not move (a filter or a sort is on)", () => {
    const next = withBlocks(shown, { rootBlockIds: ["a", "c", "b"] })
    expect(rootToOps(next, shown, graph)).toEqual([])
  })

  it("renames a note when its row's text is retyped, and links nothing to the root", () => {
    const next = withBlocks(shown, {
      blocks: { ...shown.blocks, a: { ...shown.blocks.a, text: "Apricot" } },
    })
    expect(rootToOps(next, shown, graph, { movable: true })).toEqual([
      { op: "setText", id: "a", text: "Apricot" },
    ])
  })

  it("makes a new block in the note it sits in", () => {
    const next = withBlocks(shown, {
      blocks: {
        ...shown.blocks,
        a: { ...shown.blocks.a, children: ["blk_seed", "blk_new"] },
        blk_new: { id: "blk_new", type: "text", text: "New", children: [] },
      },
    })
    const ops = rootToOps(next, shown, graph)
    expect(ops).toContainEqual(
      expect.objectContaining({ op: "create", id: "blk_new", notesId: "a" }),
    )
    expect(ops).toContainEqual(
      expect.objectContaining({ op: "link", source: "a", destination: "blk_new" }),
    )
    expect(rootLinks(ops)).toEqual([])
  })

  it("leaves a block the filter hid in its note", () => {
    // Filtered, Apple's row showed none of its blocks.
    const filtered = withBlocks(shown, {
      blocks: { ...shown.blocks, a: { ...shown.blocks.a, children: [] } },
    })
    const next = withBlocks(filtered, {
      blocks: { ...filtered.blocks, c: { ...filtered.blocks.c, text: "Cherries" } },
    })
    expect(rootToOps(next, filtered, graph)).toEqual([{ op: "setText", id: "c", text: "Cherries" }])
  })
})
