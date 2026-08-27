import { describe, expect, it } from "vitest"
import {
  ancestorsOf,
  duplicateBlocks,
  emptyBlock,
  indentBlock,
  insertAfter,
  insertBefore,
  insertBlocksAfter,
  moveBlocks,
  outdentBlock,
  remintCollidingIds,
  removeBlock,
  spliceBlocks,
  subtreeIds,
  updateContent,
} from "./ops"
import { parse } from "./parse"
import type { BlockDoc } from "./types"

/**
 * A small fixture:
 *   - a
 *   - b
 *     - b1
 *   - c
 */
function fixture(): BlockDoc {
  return {
    frontmatter: "title: t",
    rootBlockIds: ["a", "b", "c"],
    blocks: {
      a: { id: "a", content: "A", children: [] },
      b: { id: "b", content: "B", children: ["b1"] },
      b1: { id: "b1", content: "B1", children: [] },
      c: { id: "c", content: "C", children: [] },
    },
  }
}

/** A deeper fixture for tree queries:
 *   - a
 *   - b
 *     - b1
 *       - b1a
 *     - b2
 *   - c
 */
function deepFixture(): BlockDoc {
  return {
    frontmatter: null,
    rootBlockIds: ["a", "b", "c"],
    blocks: {
      a: { id: "a", content: "A", children: [] },
      b: { id: "b", content: "B", children: ["b1", "b2"] },
      b1: { id: "b1", content: "B1", children: ["b1a"] },
      b1a: { id: "b1a", content: "B1a", children: [] },
      b2: { id: "b2", content: "B2", children: [] },
      c: { id: "c", content: "C", children: [] },
    },
  }
}

describe("subtreeIds", () => {
  it("returns the block plus every descendant, depth-first", () => {
    expect(subtreeIds(deepFixture(), "b")).toEqual(["b", "b1", "b1a", "b2"])
  })

  it("returns just the block for a leaf", () => {
    expect(subtreeIds(deepFixture(), "b1a")).toEqual(["b1a"])
  })
})

describe("ancestorsOf", () => {
  it("lists ancestors nearest-first up to the root", () => {
    expect(ancestorsOf(deepFixture(), "b1a")).toEqual(["b1", "b"])
  })

  it("is empty for a root block", () => {
    expect(ancestorsOf(deepFixture(), "a")).toEqual([])
  })

  it("is empty for an unknown block", () => {
    expect(ancestorsOf(deepFixture(), "nope")).toEqual([])
  })
})

describe("emptyBlock", () => {
  it("mints a block with a fresh id and empty content by default", () => {
    const block = emptyBlock()
    expect(block.id).toMatch(/^blk_[0-9a-z]{10}$/)
    expect(block.content).toBe("")
    expect(block.children).toEqual([])
  })

  it("accepts initial content", () => {
    expect(emptyBlock("hello").content).toBe("hello")
  })

  it("mints a distinct id each call", () => {
    expect(emptyBlock().id).not.toBe(emptyBlock().id)
  })
})

describe("updateContent", () => {
  it("updates a block's content immutably", () => {
    const doc = fixture()
    const next = updateContent(doc, "a", "A!")
    expect(next.blocks["a"].content).toBe("A!")
    // Original untouched.
    expect(doc.blocks["a"].content).toBe("A")
    expect(next).not.toBe(doc)
  })

  it("returns the same doc for an unknown id", () => {
    const doc = fixture()
    expect(updateContent(doc, "nope", "x")).toBe(doc)
  })

  it("carries frontmatter through", () => {
    expect(updateContent(fixture(), "a", "A!").frontmatter).toBe("title: t")
  })
})

describe("insertAfter", () => {
  it("inserts a sibling after a root block", () => {
    const doc = fixture()
    const fresh = { id: "x", content: "X", children: [] }
    const next = insertAfter(doc, "a", fresh)
    expect(next.rootBlockIds).toEqual(["a", "x", "b", "c"])
    expect(next.blocks["x"]).toEqual(fresh)
    // Original untouched.
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
  })

  it("inserts a sibling after a nested block", () => {
    const doc = fixture()
    const fresh = { id: "b2", content: "B2", children: [] }
    const next = insertAfter(doc, "b1", fresh)
    expect(next.blocks["b"].children).toEqual(["b1", "b2"])
    // Original child list untouched.
    expect(doc.blocks["b"].children).toEqual(["b1"])
  })

  it("appends when inserting after the last sibling", () => {
    const next = insertAfter(fixture(), "c", { id: "x", content: "X", children: [] })
    expect(next.rootBlockIds).toEqual(["a", "b", "c", "x"])
  })

  it("returns the same doc for an unknown refId", () => {
    const doc = fixture()
    expect(insertAfter(doc, "nope", { id: "x", content: "", children: [] })).toBe(doc)
  })
})

describe("insertBefore", () => {
  it("inserts a sibling before a root block", () => {
    const doc = fixture()
    const fresh = { id: "x", content: "X", children: [] }
    const next = insertBefore(doc, "b", fresh)
    expect(next.rootBlockIds).toEqual(["a", "x", "b", "c"])
    // Original untouched.
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
  })

  it("inserts before the first child of a parent", () => {
    const doc = fixture()
    const fresh = { id: "b0", content: "B0", children: [] }
    const next = insertBefore(doc, "b1", fresh)
    expect(next.blocks["b"].children).toEqual(["b0", "b1"])
  })

  it("prepends when inserting before the first sibling", () => {
    const next = insertBefore(fixture(), "a", { id: "x", content: "X", children: [] })
    expect(next.rootBlockIds).toEqual(["x", "a", "b", "c"])
  })

  it("returns the same doc for an unknown refId", () => {
    const doc = fixture()
    expect(insertBefore(doc, "nope", { id: "x", content: "", children: [] })).toBe(doc)
  })
})

describe("spliceBlocks", () => {
  it("replaces a block with the parsed blocks, in order", () => {
    const doc = fixture()
    const sub = parse("one\ntwo\nthree")
    const result = spliceBlocks(doc, "b", sub)
    expect(result).not.toBeNull()
    const contents = result!.doc.rootBlockIds.map((id) => result!.doc.blocks[id].content)
    expect(contents).toEqual(["A", "one", "two", "three", "C"])
    // The replaced block is gone.
    expect(result!.doc.blocks["b"]).toBeUndefined()
    // lastId points at the final inserted block.
    expect(result!.doc.blocks[result!.lastId].content).toBe("three")
  })

  it("re-parents the replaced block's children onto the last inserted block", () => {
    const doc = fixture() // b has child b1
    const sub = parse("x\ny")
    const result = spliceBlocks(doc, "b", sub)!
    expect(result.doc.blocks[result.lastId].content).toBe("y")
    expect(result.doc.blocks[result.lastId].children).toContain("b1")
  })

  it("splices into a nested sibling list", () => {
    const doc = fixture()
    const sub = parse("p\nq")
    const result = spliceBlocks(doc, "b1", sub)!
    const childContents = result.doc.blocks["b"].children.map((id) => result.doc.blocks[id].content)
    expect(childContents).toEqual(["p", "q"])
  })

  it("returns null for an unknown id or empty sub-doc", () => {
    const doc = fixture()
    expect(spliceBlocks(doc, "nope", parse("x"))).toBeNull()
    expect(spliceBlocks(doc, "a", parse(""))).toBeNull()
  })
})

describe("insertBlocksAfter", () => {
  it("inserts the parsed blocks after the target, keeping the target intact", () => {
    const doc = fixture()
    const sub = parse("one\ntwo")
    const result = insertBlocksAfter(doc, "b", sub)!
    const contents = result.doc.rootBlockIds.map((id) => result.doc.blocks[id].content)
    expect(contents).toEqual(["A", "B", "one", "two", "C"])
    // Unlike spliceBlocks, the target block (and its id) survives.
    expect(result.doc.blocks["b"]).toBeDefined()
    expect(result.doc.blocks["b"].children).toEqual(["b1"])
    expect(result.doc.blocks[result.lastId].content).toBe("two")
  })

  it("inserts as siblings inside a nested list", () => {
    const doc = fixture()
    const sub = parse("x")
    const result = insertBlocksAfter(doc, "b1", sub)!
    const childContents = result.doc.blocks["b"].children.map((id) => result.doc.blocks[id].content)
    expect(childContents).toEqual(["B1", "x"])
  })

  it("returns null for an unknown target or empty sub-doc", () => {
    const doc = fixture()
    expect(insertBlocksAfter(doc, "nope", parse("x"))).toBeNull()
    expect(insertBlocksAfter(doc, "a", parse(""))).toBeNull()
  })
})

describe("remintCollidingIds", () => {
  it("mints fresh ids for pasted blocks whose id already exists in the doc", () => {
    const doc = fixture()
    // Clipboard content carrying an id:: that matches an existing block.
    const sub = parse("stolen\n  id:: b\n  - nested child")
    const reminted = remintCollidingIds(sub, doc)
    expect(reminted.blocks["b"]).toBeUndefined()
    const rootId = reminted.rootBlockIds[0]
    expect(rootId).not.toBe("b")
    expect(reminted.blocks[rootId].content).toBe("stolen")
    // Child references follow the remap.
    const childId = reminted.blocks[rootId].children[0]
    expect(reminted.blocks[childId].content).toBe("- nested child")
  })

  it("pasting an id-carrying fragment never clobbers the existing block", () => {
    const doc = fixture()
    const sub = remintCollidingIds(parse("stolen\n  id:: b"), doc)
    const result = insertBlocksAfter(doc, "c", sub)!
    // The original block b is untouched.
    expect(result.doc.blocks["b"].content).toBe("B")
    expect(result.doc.blocks["b"].children).toEqual(["b1"])
    // The pasted copy exists under a fresh id.
    expect(result.doc.blocks[result.lastId].content).toBe("stolen")
  })

  it("returns the sub-doc unchanged when nothing collides", () => {
    const doc = fixture()
    const sub = parse("fresh\n  id:: blk_zzzzzzzzzz")
    expect(remintCollidingIds(sub, doc)).toBe(sub)
  })
})

describe("duplicateBlocks", () => {
  it("duplicates a subtree below with fresh ids throughout", () => {
    const doc = fixture()
    const result = duplicateBlocks(doc, ["b"], "below")!
    expect(result.copies).toHaveLength(1)
    const copy = result.copies[0]
    expect(result.doc.rootBlockIds).toEqual(["a", "b", copy, "c"])
    expect(result.doc.blocks[copy].content).toBe("B")
    const childCopy = result.doc.blocks[copy].children[0]
    expect(childCopy).not.toBe("b1")
    expect(result.doc.blocks[childCopy].content).toBe("B1")
    // Originals untouched.
    expect(result.doc.blocks["b"].children).toEqual(["b1"])
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
  })

  it("duplicates above, inserting the copy before the original", () => {
    const doc = fixture()
    const result = duplicateBlocks(doc, ["c"], "above")!
    const copy = result.copies[0]
    expect(result.doc.rootBlockIds).toEqual(["a", "b", copy, "c"])
  })

  it("duplicates a multi-selection as one group after the last original", () => {
    const doc = fixture()
    const result = duplicateBlocks(doc, ["a", "b"], "below")!
    const [copyA, copyB] = result.copies
    expect(result.doc.rootBlockIds).toEqual(["a", "b", copyA, copyB, "c"])
    expect(result.doc.blocks[copyA].content).toBe("A")
    expect(result.doc.blocks[copyB].content).toBe("B")
  })

  it("duplicates a multi-selection above, before the first original", () => {
    const doc = fixture()
    const result = duplicateBlocks(doc, ["b", "c"], "above")!
    const [copyB, copyC] = result.copies
    expect(result.doc.rootBlockIds).toEqual(["a", copyB, copyC, "b", "c"])
  })

  it("returns null when nothing exists to duplicate", () => {
    expect(duplicateBlocks(fixture(), ["nope"], "below")).toBeNull()
    expect(duplicateBlocks(fixture(), [], "below")).toBeNull()
  })
})

describe("moveBlocks", () => {
  it("moves a contiguous sibling group down past one sibling", () => {
    const doc = fixture()
    const next = moveBlocks(doc, ["a", "b"], "down")
    expect(next.rootBlockIds).toEqual(["c", "a", "b"])
    // Subtrees ride along.
    expect(next.blocks["b"].children).toEqual(["b1"])
  })

  it("moves a group up past one sibling", () => {
    const doc = fixture()
    const next = moveBlocks(doc, ["b", "c"], "up")
    expect(next.rootBlockIds).toEqual(["b", "c", "a"])
  })

  it("is a no-op at the boundary", () => {
    const doc = fixture()
    expect(moveBlocks(doc, ["a", "b"], "up")).toBe(doc)
    expect(moveBlocks(doc, ["b", "c"], "down")).toBe(doc)
  })

  it("is a no-op when the ids span parents", () => {
    const doc = fixture()
    expect(moveBlocks(doc, ["b1", "c"], "down")).toBe(doc)
  })

  it("is a no-op when the siblings are not contiguous", () => {
    const doc = fixture()
    expect(moveBlocks(doc, ["a", "c"], "down")).toBe(doc)
  })
})

describe("removeBlock", () => {
  it("removes a middle root and focuses the previous sibling", () => {
    const { doc, focusId } = removeBlock(fixture(), "c")
    expect(doc.rootBlockIds).toEqual(["a", "b"])
    expect(focusId).toBe("b")
  })

  it("removes a block and its whole subtree from the blocks map", () => {
    const { doc } = removeBlock(fixture(), "b")
    expect(doc.rootBlockIds).toEqual(["a", "c"])
    expect(doc.blocks["b"]).toBeUndefined()
    expect(doc.blocks["b1"]).toBeUndefined()
  })

  it("focuses the parent when removing a first child", () => {
    const { doc, focusId } = removeBlock(fixture(), "b1")
    expect(doc.blocks["b"].children).toEqual([])
    expect(focusId).toBe("b")
  })

  it("focuses null when removing the first root", () => {
    const { focusId } = removeBlock(fixture(), "a")
    expect(focusId).toBeNull()
  })

  it("leaves the original doc untouched", () => {
    const doc = fixture()
    removeBlock(doc, "b")
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
    expect(doc.blocks["b1"]).toBeDefined()
  })

  it("returns the same doc and null focus for an unknown id", () => {
    const doc = fixture()
    const result = removeBlock(doc, "nope")
    expect(result.doc).toBe(doc)
    expect(result.focusId).toBeNull()
  })
})

describe("indentBlock", () => {
  it("makes a block the last child of its previous sibling", () => {
    const next = indentBlock(fixture(), "c")
    expect(next.rootBlockIds).toEqual(["a", "b"])
    expect(next.blocks["b"].children).toEqual(["b1", "c"])
  })

  it("carries a block's own subtree when indenting", () => {
    const next = indentBlock(fixture(), "b")
    expect(next.rootBlockIds).toEqual(["a", "c"])
    expect(next.blocks["a"].children).toEqual(["b"])
    // b keeps its child.
    expect(next.blocks["b"].children).toEqual(["b1"])
  })

  it("is a no-op for the first block in its list", () => {
    const doc = fixture()
    expect(indentBlock(doc, "a")).toBe(doc)
  })

  it("is a no-op for a first child", () => {
    const doc = fixture()
    expect(indentBlock(doc, "b1")).toBe(doc)
  })

  it("leaves the original doc untouched", () => {
    const doc = fixture()
    indentBlock(doc, "c")
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
    expect(doc.blocks["b"].children).toEqual(["b1"])
  })
})

describe("outdentBlock", () => {
  it("lifts a block to be a sibling of its parent, just after it", () => {
    const next = outdentBlock(fixture(), "b1")
    expect(next.rootBlockIds).toEqual(["a", "b", "b1", "c"])
    expect(next.blocks["b"].children).toEqual([])
  })

  it("is a no-op for a top-level block", () => {
    const doc = fixture()
    expect(outdentBlock(doc, "a")).toBe(doc)
  })

  it("returns the same doc for an unknown id", () => {
    const doc = fixture()
    expect(outdentBlock(doc, "nope")).toBe(doc)
  })

  it("leaves the original doc untouched", () => {
    const doc = fixture()
    outdentBlock(doc, "b1")
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
    expect(doc.blocks["b"].children).toEqual(["b1"])
  })

  it("preserves a deeper subtree when outdenting", () => {
    // a > b > b1 > b1a; outdent b1 -> a > [b, b1>b1a]
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["a"],
      blocks: {
        a: { id: "a", content: "A", children: ["b"] },
        b: { id: "b", content: "B", children: ["b1"] },
        b1: { id: "b1", content: "B1", children: ["b1a"] },
        b1a: { id: "b1a", content: "B1A", children: [] },
      },
    }
    const next = outdentBlock(doc, "b1")
    expect(next.blocks["a"].children).toEqual(["b", "b1"])
    expect(next.blocks["b"].children).toEqual([])
    expect(next.blocks["b1"].children).toEqual(["b1a"])
  })
})
