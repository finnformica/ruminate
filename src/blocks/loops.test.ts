// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { basketDoc, basketRootIds } from "../data/basket"
import { buildGraphSnapshot, docFromGraph, pageDoc, rollup } from "../data/graph"
import { applyOps, docToOps } from "../data/ops"
import { indexNoteBlocks } from "../utils/block-search"
import { buildOutline } from "../utils/note-outline"
import { richClipboardFormats, extractClipboardBlocks } from "../utils/rich-clipboard"
import { defaultCollapsedKeys } from "./default-collapsed"
import { duplicateBlocks, subtreeIds } from "./ops"
import { parse } from "./parse"
import { serialize } from "./serialize"
import { toDisplayMarkdown } from "./to-display-markdown"
import type { BlockDoc } from "./types"
import { buildRows, occurrenceKeys, walkDoc } from "./view"

/**
 * The loop corpus: every walk over a doc or the graph, run over shapes that
 * hold loops (docs/graph-schema-v2.md, "Loops"). Each must end where the
 * loop closes — showing the closing block once, as a leaf — and never hang.
 */

/** a → b → a, with a sibling c under a: `a / b / (a) , c`. */
const looped = (): BlockDoc => ({
  props: null,
  rootBlockIds: ["a"],
  blocks: {
    a: { id: "a", type: "h1", text: "A", children: ["b", "c"] },
    b: { id: "b", type: "ul", text: "B", children: ["a"] },
    c: { id: "c", type: "text", text: "C", children: [] },
  },
})

/** A page whose graph holds the same loop, built through the app's own path. */
function loopedGraph() {
  let snapshot = buildGraphSnapshot([], [])
  snapshot = applyOps(
    snapshot,
    docToOps("n", parse("# A\n  id:: a\n  - B\n    id:: b\n  C\n    id:: c\n"), snapshot),
    1,
  )
  // b → a closes the loop.
  return applyOps(snapshot, [{ op: "link", source: "b", destination: "a", sortKey: "a0" }], 2)
}

describe("a doc that holds a loop", () => {
  it("walks every occurrence once, the closing one as a leaf", () => {
    const steps: string[] = []
    walkDoc(looped(), ["a"], ({ key, looped }) => {
      steps.push(looped ? `${key}↻` : key)
    })
    expect(steps).toEqual(["a", "a/b", "a/b/a↻", "a/c"])
    expect(occurrenceKeys(looped())).toEqual(["a", "a/b", "a/b/a", "a/c"])
  })

  it("renders the closing row without children or a toggle", () => {
    const rows = buildRows(looped(), { folds: new Set() })
    expect(rows.map((r) => [r.key, r.hasChildren, r.looped ?? false])).toEqual([
      ["a", true, false],
      ["a/b", true, false],
      ["a/b/a", false, true],
      ["a/c", false, false],
    ])
    // Zooming into the closing block starts a fresh path: one more turn.
    const zoomed = buildRows(looped(), { zoomRootId: "a", folds: new Set() })
    expect(zoomed.map((r) => r.key)).toEqual(["a", "a/b", "a/b/a", "a/c"])
  })

  it("serialises and displays to where the loop closes, and no further", () => {
    expect(serialize(looped())).toBe(
      "# A\n  id:: a\n  - B\n    id:: b\n    # A\n      id:: a\n  C\n    id:: c\n",
    )
    // Prose keeps the margin; the closing heading sits inside B's item.
    expect(toDisplayMarkdown(serialize(looped()))).toBe("# A\n- B\n  # A\nC")
  })

  it("folds, outlines, indexes and copies without hanging", () => {
    expect(defaultCollapsedKeys(looped(), 1)).toEqual(["a/b"])
    // The outline lists a heading once: the closing occurrence is the same
    // heading again.
    expect(buildOutline(looped()).map((i) => i.id)).toEqual(["a"])
    expect(subtreeIds(looped(), "a").sort()).toEqual(["a", "b", "c"])
    // A copy is a tree and ends where the loop closes: the payload holds A
    // once, B beneath it with nothing beneath B, and C.
    const formats = richClipboardFormats("# A\n  id:: a\n  - B\n    id:: b\n  C\n    id:: c\n")
    const payload = extractClipboardBlocks(formats.html)!
    expect(payload[0].children.map((b) => [b.id, b.children.length])).toEqual([
      ["b", 0],
      ["c", 0],
    ])
  })

  it("duplicates a loop as a loop among the copies", () => {
    const result = duplicateBlocks(looped(), ["a"], "below")!
    const copyId = result.copies[0]
    const copy = result.doc.blocks[copyId]
    const copyB = result.doc.blocks[copy.children[0]]
    expect(copyB.children).toEqual([copyId])
    expect(Object.keys(result.doc.blocks)).toHaveLength(6)
  })
})

describe("a graph that holds a loop", () => {
  it("is kept on save, walked to where it closes, and rolled up", () => {
    const snapshot = loopedGraph()
    const doc = pageDoc("n", snapshot)!
    expect(doc.blocks.b.children).toEqual(["a"])
    expect(rollup("n", snapshot)).toBe(
      "# A\n  id:: a\n  - B\n    id:: b\n    # A\n      id:: a\n  C\n    id:: c\n",
    )
    // Saving the walk back is the identity: the loop survives the round trip.
    expect(docToOps("n", doc, snapshot)).toEqual([])
    expect(docFromGraph(["b"], snapshot).blocks.a.children).toEqual(["b", "c"])
  })

  it("refuses only a block under itself", () => {
    const snapshot = loopedGraph()
    const doc = pageDoc("n", snapshot)!
    const selfish = { ...doc, blocks: { ...doc.blocks, c: { ...doc.blocks.c, children: ["c"] } } }
    expect(docToOps("n", selfish, snapshot)).toEqual([])
  })

  it("indexes each block of the page once, the loop's closing occurrence skipped", () => {
    const snapshot = loopedGraph()
    const note = { id: "n" } as Parameters<typeof indexNoteBlocks>[0]
    const { hits } = indexNoteBlocks(note, snapshot)
    expect(hits.map((h) => h.blockId)).toEqual(["a", "b", "c"])
  })

  it("shows a detached loop in the basket via a promoted root", () => {
    const snapshot = loopedGraph()
    const detached = applyOps(snapshot, [{ op: "unlink", source: "n", destination: "a" }], 3)
    expect(basketRootIds("n", detached)).toEqual(["a"])
    expect(Object.keys(basketDoc("n", detached).blocks).sort()).toEqual(["a", "b", "c"])
  })
})
