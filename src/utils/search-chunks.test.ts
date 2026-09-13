import { describe, expect, test } from "vitest"
import { buildGraphSnapshot, docToGraph } from "../data/graph"
import type { Note } from "../schema"
import { indexNoteBlocks } from "./block-search"
import { chunkId, MAX_CHUNKS_PER_NOTE, parseChunkId, sectionChunks } from "./search-chunks"

function makeNote(id: string, overrides: Partial<Note> = {}): Note {
  return {
    id,
    type: "note",
    displayName: id,
    props: {},
    title: "",
    pinned: false,
    updatedAt: null,
    dates: [],
    tags: [],
    tasks: [],
    headings: [],
    text: "",
    ...overrides,
  }
}

const md = (...lines: string[]) => lines.join("\n") + "\n"

/** The note's blocks, walked exactly as the block index walks them. */
function hitsOf(id: string, markdown: string) {
  const graph = docToGraph(id, markdown, 1)
  const snapshot = buildGraphSnapshot(graph.nodes, graph.links)
  return indexNoteBlocks(makeNote(id), snapshot).hits
}

describe("sectionChunks", () => {
  test("starts a new chunk at every heading", () => {
    const hits = hitsOf(
      "n",
      md(
        "- # Sync",
        "  id:: blk_a",
        "  - Row diffs push through the Worker",
        "    id:: blk_b",
        "  - Last writer wins per row",
        "    id:: blk_c",
        "- # Editor",
        "  id:: blk_d",
        "  - Every edit is a batch of ops",
        "    id:: blk_e",
      ),
    )
    const chunks = sectionChunks("Ruminate", hits)

    expect(chunks.map((chunk) => chunk.blockIds)).toEqual([
      ["blk_a", "blk_b", "blk_c"],
      ["blk_d", "blk_e"],
    ])
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1])
  })

  test("the note's title leads every chunk, and the blocks follow in order", () => {
    const hits = hitsOf(
      "n",
      md("- # Bake", "  id:: blk_a", "  - Cold retard overnight", "    id:: blk_b"),
    )
    expect(sectionChunks("Sourdough", hits)[0].text).toBe("Sourdough\nBake\nCold retard overnight")
  })

  test("blocks before the first heading are their own chunk", () => {
    const hits = hitsOf(
      "n",
      md("- A loose opening line", "  id:: blk_a", "- # Later", "  id:: blk_b"),
    )
    expect(sectionChunks("Note", hits).map((chunk) => chunk.blockIds)).toEqual([
      ["blk_a"],
      ["blk_b"],
    ])
  })

  test("a note with no headings is one chunk until it overflows", () => {
    // Each line is ~60 characters, so 1,500 characters is about 25 of them:
    // well under one chunk at 10 lines, and more than one at 60.
    const line = (index: number) =>
      `- Line ${index} of a note that has no headings in it whatsoever\n  id:: blk_${index}`
    const short = hitsOf("s", md(...Array.from({ length: 10 }, (_, i) => line(i))))
    const long = hitsOf("l", md(...Array.from({ length: 60 }, (_, i) => line(i))))

    expect(sectionChunks("Note", short)).toHaveLength(1)
    expect(sectionChunks("Note", long).length).toBeGreaterThan(1)
    // Nothing is dropped by splitting: every block is in exactly one chunk.
    const covered = sectionChunks("Note", long).flatMap((chunk) => chunk.blockIds)
    expect(covered).toHaveLength(long.length)
    expect(new Set(covered).size).toBe(long.length)
  })

  test("never exceeds the delete window, however many headings there are", () => {
    const heading = (index: number) => `- # Section ${index}\n  id:: blk_${index}`
    const hits = hitsOf(
      "n",
      md(...Array.from({ length: MAX_CHUNKS_PER_NOTE + 20 }, (_, i) => heading(i))),
    )
    const chunks = sectionChunks("Note", hits)

    expect(chunks.length).toBe(MAX_CHUNKS_PER_NOTE)
    // The tail is swallowed by the last chunk rather than lost — which is what
    // makes the fixed-size delete window safe.
    expect(chunks.flatMap((chunk) => chunk.blockIds)).toHaveLength(hits.length)
  })

  test("an empty note has nothing to embed", () => {
    expect(sectionChunks("Note", [])).toEqual([])
  })
})

describe("chunkId", () => {
  test("round-trips", () => {
    expect(parseChunkId(chunkId("blk_note01", 7))).toEqual({ noteId: "blk_note01", ordinal: 7 })
  })

  test("a note id containing a hash still round-trips", () => {
    expect(parseChunkId(chunkId("a#b", 2))).toEqual({ noteId: "a#b", ordinal: 2 })
  })

  test("refuses an id it did not mint rather than guessing", () => {
    expect(parseChunkId("no-hash")).toBeNull()
    expect(parseChunkId("#3")).toBeNull()
    expect(parseChunkId("note#not-a-number")).toBeNull()
    expect(parseChunkId("note#-1")).toBeNull()
  })
})
