import { describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import { docToRows, extractBlockLinks, findCrossNoteIdCollisions } from "./doc-to-rows"

const OUTLINE = [
  "- Parent #project/alpha",
  "  id:: blk_par0000001",
  "  - Child [[note-b|B]] and ((blk_ref0000001))",
  "    id:: blk_chi0000001",
  "- Second ![[note-c]]",
  "  id:: blk_sec0000001",
  "",
].join("\n")

describe("docToRows", () => {
  it("flattens the outline into rows with parent and sibling position", () => {
    const { blocks } = docToRows("note-a", parse(OUTLINE))
    expect(blocks).toEqual([
      {
        id: "blk_par0000001",
        note_id: "note-a",
        parent_id: null,
        position: 0,
        content: "- Parent #project/alpha",
      },
      {
        id: "blk_chi0000001",
        note_id: "note-a",
        parent_id: "blk_par0000001",
        position: 0,
        content: "- Child [[note-b|B]] and ((blk_ref0000001))",
      },
      {
        id: "blk_sec0000001",
        note_id: "note-a",
        parent_id: null,
        position: 1,
        content: "- Second ![[note-c]]",
      },
    ])
  })

  it("extracts the block-level graph edges", () => {
    const { links } = docToRows("note-a", parse(OUTLINE))
    expect(links).toEqual([
      { from_block: "blk_par0000001", to_note: "project/alpha", to_block: null, kind: "tag" },
      { from_block: "blk_chi0000001", to_note: "note-b", to_block: null, kind: "wikilink" },
      {
        from_block: "blk_chi0000001",
        to_note: null,
        to_block: "blk_ref0000001",
        kind: "transclusion",
      },
      { from_block: "blk_sec0000001", to_note: "note-c", to_block: null, kind: "transclusion" },
    ])
  })

  it("does not emit rows for frontmatter (it stays in the note's content column)", () => {
    const markdown = ["---", "tags: [journal]", "---", "- Body", "  id:: blk_bod0000001", ""].join(
      "\n",
    )
    const { blocks, links } = docToRows("note-a", parse(markdown))
    expect(blocks.map((b) => b.id)).toEqual(["blk_bod0000001"])
    expect(links).toEqual([])
  })

  it("handles an empty note", () => {
    expect(docToRows("note-a", parse(""))).toEqual({ blocks: [], links: [] })
  })
})

describe("extractBlockLinks", () => {
  it("de-duplicates repeated edges within one block", () => {
    const links = extractBlockLinks("blk_x", "- [[note-b]] and [[note-b]] again #t #t")
    expect(links).toEqual([
      { from_block: "blk_x", to_note: "note-b", to_block: null, kind: "wikilink" },
      { from_block: "blk_x", to_note: "t", to_block: null, kind: "tag" },
    ])
  })

  it("treats a note embed and a block reference both as transclusions", () => {
    const links = extractBlockLinks("blk_x", "- ![[note-c]] ((blk_ref0000001))")
    expect(links).toEqual([
      { from_block: "blk_x", to_note: "note-c", to_block: null, kind: "transclusion" },
      { from_block: "blk_x", to_note: null, to_block: "blk_ref0000001", kind: "transclusion" },
    ])
  })

  it("returns no edges for plain text", () => {
    expect(extractBlockLinks("blk_x", "- just words")).toEqual([])
  })
})

describe("findCrossNoteIdCollisions", () => {
  it("detects the same persisted id declared by two notes", () => {
    const collisions = findCrossNoteIdCollisions({
      "note-b": "- Copied\n  id:: blk_dup0000001\n",
      "note-a": "- Original\n  id:: blk_dup0000001\n",
    })
    // Deterministic: notes sorted, first is the keeper by convention.
    expect(collisions).toEqual([{ blockId: "blk_dup0000001", noteIds: ["note-a", "note-b"] }])
  })

  it("ignores intra-note duplicates (parse already regenerates those)", () => {
    const collisions = findCrossNoteIdCollisions({
      "note-a": "- One\n  id:: blk_dup0000001\n- Two\n  id:: blk_dup0000001\n",
    })
    expect(collisions).toEqual([])
  })

  it("returns nothing when all ids are distinct", () => {
    const collisions = findCrossNoteIdCollisions({
      "note-a": "- A\n  id:: blk_aaa0000001\n",
      "note-b": "- B\n  id:: blk_bbb0000001\n",
    })
    expect(collisions).toEqual([])
  })

  it("lists every note involved in a three-way collision", () => {
    const note = "- Same\n  id:: blk_dup0000001\n"
    const collisions = findCrossNoteIdCollisions({ c: note, a: note, b: note })
    expect(collisions).toEqual([{ blockId: "blk_dup0000001", noteIds: ["a", "b", "c"] }])
  })
})
