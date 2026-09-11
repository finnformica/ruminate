import { describe, expect, it } from "vitest"
import {
  duplicateBlocks,
  emptyBlock,
  indentBlock,
  insertAfter,
  insertBefore,
  insertBlocksAfter,
  insertBlocksAsFirstChildren,
  insertFirstChild,
  moveBlocks,
  outdentBlock,
  remintCollidingIds,
  removeBlock,
  siblingsOf,
  spliceBlocks,
  subtreeIds,
  updateBlock,
  updateText,
} from "./ops"
import { parse } from "./parse"
import type { Block, BlockDoc } from "./types"

/**
 * A small fixture:
 *   - a
 *   - b
 *     - b1
 *   - c
 */
function fixture(): BlockDoc {
  return {
    props: { title: "t" },
    rootBlockIds: ["a", "b", "c"],
    blocks: {
      a: { id: "a", type: "text", text: "A", children: [] },
      b: { id: "b", type: "text", text: "B", children: ["b1"] },
      b1: { id: "b1", type: "text", text: "B1", children: [] },
      c: { id: "c", type: "text", text: "C", children: [] },
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
    props: null,
    rootBlockIds: ["a", "b", "c"],
    blocks: {
      a: { id: "a", type: "text", text: "A", children: [] },
      b: { id: "b", type: "text", text: "B", children: ["b1", "b2"] },
      b1: { id: "b1", type: "text", text: "B1", children: ["b1a"] },
      b1a: { id: "b1a", type: "text", text: "B1a", children: [] },
      b2: { id: "b2", type: "text", text: "B2", children: [] },
      c: { id: "c", type: "text", text: "C", children: [] },
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

describe("siblingsOf", () => {
  it("reads a row's parent and siblings off its key", () => {
    expect(siblingsOf(deepFixture(), "b/b1")).toEqual({
      parentKey: "b",
      parentId: "b",
      siblings: ["b1", "b2"],
      index: 0,
    })
    expect(siblingsOf(deepFixture(), "c")).toEqual({
      parentKey: null,
      parentId: null,
      siblings: ["a", "b", "c"],
      index: 2,
    })
  })

  it("is null for a key the document does not have", () => {
    expect(siblingsOf(deepFixture(), "a/b1")).toBeNull()
    expect(siblingsOf(deepFixture(), "nope")).toBeNull()
  })
})

describe("emptyBlock", () => {
  it("mints a block with a fresh id and empty content by default", () => {
    const block = emptyBlock()
    expect(block.id).toMatch(/^blk_[0-9a-z]{10}$/)
    expect(block.text).toBe("")
    expect(block.children).toEqual([])
  })

  it("accepts initial content", () => {
    expect(emptyBlock("text", "hello").text).toBe("hello")
  })

  it("mints a distinct id each call", () => {
    expect(emptyBlock().id).not.toBe(emptyBlock().id)
  })
})

describe("updateText", () => {
  it("updates a block's content immutably", () => {
    const doc = fixture()
    const next = updateText(doc, "a", "A!")
    expect(next.blocks["a"].text).toBe("A!")
    // Original untouched.
    expect(doc.blocks["a"].text).toBe("A")
    expect(next).not.toBe(doc)
  })

  it("returns the same doc for an unknown id", () => {
    const doc = fixture()
    expect(updateText(doc, "nope", "x")).toBe(doc)
  })

  it("carries the page props through", () => {
    expect(updateText(fixture(), "a", "A!").props).toEqual({ title: "t" })
  })
})

describe("updateBlock", () => {
  it("sets and clears a block's props alongside text and type", () => {
    const doc = fixture()
    const coded = updateBlock(doc, "a", { type: "code", text: "x = 1", props: { language: "js" } })
    expect(coded.blocks["a"]).toEqual({
      id: "a",
      type: "code",
      text: "x = 1",
      props: { language: "js" },
      children: [],
    })
    // Untouched props ride along; null clears them.
    expect(updateBlock(coded, "a", { text: "y" }).blocks["a"].props).toEqual({ language: "js" })
    expect(updateBlock(coded, "a", { props: null }).blocks["a"].props).toBeUndefined()
    // Nothing to change: the same doc.
    expect(updateBlock(coded, "a", { text: "x = 1" })).toBe(coded)
  })
})

describe("insertAfter", () => {
  it("inserts a sibling after a root block", () => {
    const doc = fixture()
    const fresh: Block = { id: "x", type: "text", text: "X", children: [] }
    const next = insertAfter(doc, "a", fresh)
    expect(next.rootBlockIds).toEqual(["a", "x", "b", "c"])
    expect(next.blocks["x"]).toEqual(fresh)
    // Original untouched.
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
  })

  it("inserts a sibling after a nested block", () => {
    const doc = fixture()
    const fresh: Block = { id: "b2", type: "text", text: "B2", children: [] }
    const next = insertAfter(doc, "b/b1", fresh)
    expect(next.blocks["b"].children).toEqual(["b1", "b2"])
    // Original child list untouched.
    expect(doc.blocks["b"].children).toEqual(["b1"])
  })

  it("appends when inserting after the last sibling", () => {
    const next = insertAfter(fixture(), "c", { id: "x", type: "text", text: "X", children: [] })
    expect(next.rootBlockIds).toEqual(["a", "b", "c", "x"])
  })

  it("returns the same doc for an unknown refId", () => {
    const doc = fixture()
    expect(insertAfter(doc, "nope", { id: "x", type: "text", text: "", children: [] })).toBe(doc)
  })
})

describe("insertBefore", () => {
  it("inserts a sibling before a root block", () => {
    const doc = fixture()
    const fresh: Block = { id: "x", type: "text", text: "X", children: [] }
    const next = insertBefore(doc, "b", fresh)
    expect(next.rootBlockIds).toEqual(["a", "x", "b", "c"])
    // Original untouched.
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
  })

  it("inserts before the first child of a parent", () => {
    const doc = fixture()
    const fresh: Block = { id: "b0", type: "text", text: "B0", children: [] }
    const next = insertBefore(doc, "b/b1", fresh)
    expect(next.blocks["b"].children).toEqual(["b0", "b1"])
  })

  it("prepends when inserting before the first sibling", () => {
    const next = insertBefore(fixture(), "a", { id: "x", type: "text", text: "X", children: [] })
    expect(next.rootBlockIds).toEqual(["x", "a", "b", "c"])
  })

  it("returns the same doc for an unknown refId", () => {
    const doc = fixture()
    expect(insertBefore(doc, "nope", { id: "x", type: "text", text: "", children: [] })).toBe(doc)
  })
})

describe("spliceBlocks", () => {
  it("replaces a block with the parsed blocks, in order", () => {
    const doc = fixture()
    const sub = parse("one\ntwo\nthree")
    const result = spliceBlocks(doc, "b", sub)
    expect(result).not.toBeNull()
    const contents = result!.doc.rootBlockIds.map((id) => result!.doc.blocks[id].text)
    expect(contents).toEqual(["A", "one", "two", "three", "C"])
    // The replaced block is gone.
    expect(result!.doc.blocks["b"]).toBeUndefined()
    // lastId points at the final inserted block.
    expect(result!.doc.blocks[result!.lastId].text).toBe("three")
  })

  it("re-parents the replaced block's children onto the last inserted block", () => {
    const doc = fixture() // b has child b1
    const sub = parse("x\ny")
    const result = spliceBlocks(doc, "b", sub)!
    expect(result.doc.blocks[result.lastId].text).toBe("y")
    expect(result.doc.blocks[result.lastId].children).toContain("b1")
  })

  it("splices into a nested sibling list", () => {
    const doc = fixture()
    const sub = parse("p\nq")
    const result = spliceBlocks(doc, "b/b1", sub)!
    const childContents = result.doc.blocks["b"].children.map((id) => result.doc.blocks[id].text)
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
    const contents = result.doc.rootBlockIds.map((id) => result.doc.blocks[id].text)
    expect(contents).toEqual(["A", "B", "one", "two", "C"])
    // Unlike spliceBlocks, the target block (and its id) survives.
    expect(result.doc.blocks["b"]).toBeDefined()
    expect(result.doc.blocks["b"].children).toEqual(["b1"])
    expect(result.doc.blocks[result.lastId].text).toBe("two")
  })

  it("inserts as siblings inside a nested list", () => {
    const doc = fixture()
    const sub = parse("x")
    const result = insertBlocksAfter(doc, "b/b1", sub)!
    const childContents = result.doc.blocks["b"].children.map((id) => result.doc.blocks[id].text)
    expect(childContents).toEqual(["B1", "x"])
  })

  it("returns null for an unknown target or empty sub-doc", () => {
    const doc = fixture()
    expect(insertBlocksAfter(doc, "nope", parse("x"))).toBeNull()
    expect(insertBlocksAfter(doc, "a", parse(""))).toBeNull()
  })
})

describe("insertFirstChild", () => {
  it("inserts the block at the head of the parent's children", () => {
    const doc = fixture()
    const fresh = emptyBlock("text", "new")
    const next = insertFirstChild(doc, "b", fresh)
    expect(next.blocks["b"].children).toEqual([fresh.id, "b1"])
    expect(next.blocks[fresh.id].text).toBe("new")
    // Immutable: the original doc is untouched.
    expect(doc.blocks["b"].children).toEqual(["b1"])
  })

  it("is a no-op for an unknown parent", () => {
    const doc = fixture()
    expect(insertFirstChild(doc, "nope", emptyBlock("text", "x"))).toBe(doc)
  })
})

describe("insertBlocksAsFirstChildren", () => {
  it("inserts the parsed blocks as the parent's leading children", () => {
    const doc = fixture()
    const result = insertBlocksAsFirstChildren(doc, "b", parse("one\ntwo"))!
    const childContents = result.doc.blocks["b"].children.map((id) => result.doc.blocks[id].text)
    expect(childContents).toEqual(["one", "two", "B1"])
    expect(result.doc.blocks[result.lastId].text).toBe("two")
  })

  it("returns null for an unknown parent or empty sub-doc", () => {
    const doc = fixture()
    expect(insertBlocksAsFirstChildren(doc, "nope", parse("x"))).toBeNull()
    expect(insertBlocksAsFirstChildren(doc, "b", parse(""))).toBeNull()
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
    expect(reminted.blocks[rootId].text).toBe("stolen")
    // Child references follow the remap.
    const childId = reminted.blocks[rootId].children[0]
    expect(reminted.blocks[childId].type).toBe("ul")
    expect(reminted.blocks[childId].text).toBe("nested child")
  })

  it("pasting an id-carrying fragment never clobbers the existing block", () => {
    const doc = fixture()
    const sub = remintCollidingIds(parse("stolen\n  id:: b"), doc)
    const result = insertBlocksAfter(doc, "c", sub)!
    // The original block b is untouched.
    expect(result.doc.blocks["b"].text).toBe("B")
    expect(result.doc.blocks["b"].children).toEqual(["b1"])
    // The pasted copy exists under a fresh id.
    expect(result.doc.blocks[result.lastId].text).toBe("stolen")
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
    expect(result.doc.blocks[copy].text).toBe("B")
    const childCopy = result.doc.blocks[copy].children[0]
    expect(childCopy).not.toBe("b1")
    expect(result.doc.blocks[childCopy].text).toBe("B1")
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
    expect(result.doc.blocks[copyA].text).toBe("A")
    expect(result.doc.blocks[copyB].text).toBe("B")
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

  it("names the copies by their keys under the anchor's parent", () => {
    const result = duplicateBlocks(fixture(), ["b/b1"], "below")!
    expect(result.copies).toHaveLength(1)
    expect(result.copies[0].startsWith("b/")).toBe(true)
    const copyId = result.copies[0].slice(2)
    expect(result.doc.blocks["b"].children).toEqual(["b1", copyId])
    expect(result.doc.blocks[copyId].text).toBe("B1")
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
    expect(moveBlocks(doc, ["b/b1", "c"], "down")).toBe(doc)
  })

  it("is a no-op when the siblings are not contiguous", () => {
    const doc = fixture()
    expect(moveBlocks(doc, ["a", "c"], "down")).toBe(doc)
  })
})

describe("removeBlock", () => {
  it("removes a middle root and focuses the previous sibling", () => {
    const { doc, focusKey } = removeBlock(fixture(), "c")
    expect(doc.rootBlockIds).toEqual(["a", "b"])
    expect(focusKey).toBe("b")
  })

  it("removes a block and its whole subtree from the blocks map", () => {
    const { doc } = removeBlock(fixture(), "b")
    expect(doc.rootBlockIds).toEqual(["a", "c"])
    expect(doc.blocks["b"]).toBeUndefined()
    expect(doc.blocks["b1"]).toBeUndefined()
  })

  it("focuses the parent when removing a first child", () => {
    const { doc, focusKey } = removeBlock(fixture(), "b/b1")
    expect(doc.blocks["b"].children).toEqual([])
    expect(focusKey).toBe("b")
  })

  it("focuses null when removing the first root", () => {
    const { focusKey } = removeBlock(fixture(), "a")
    expect(focusKey).toBeNull()
  })

  it("removes one row of a shared block and keeps the block in the other", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["p", "q"],
      blocks: {
        p: { id: "p", type: "ul", text: "p", children: ["s"] },
        q: { id: "q", type: "ul", text: "q", children: ["s"] },
        s: { id: "s", type: "ul", text: "shared", children: ["t"] },
        t: { id: "t", type: "ul", text: "t", children: [] },
      },
    }
    const once = removeBlock(doc, "q/s")
    expect(once.doc.blocks["q"].children).toEqual([])
    expect(once.doc.blocks["p"].children).toEqual(["s"])
    expect(once.doc.blocks["s"]).toBeDefined()
    expect(once.doc.blocks["t"]).toBeDefined()
    expect(once.focusKey).toBe("q")
    // The last row takes the subtree with it.
    const twice = removeBlock(once.doc, "p/s")
    expect(twice.doc.blocks["s"]).toBeUndefined()
    expect(twice.doc.blocks["t"]).toBeUndefined()
  })

  it("leaves the original doc untouched", () => {
    const doc = fixture()
    removeBlock(doc, "b")
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
    expect(doc.blocks["b1"]).toBeDefined()
  })

  it("returns the same doc and null focus for an unknown key", () => {
    const doc = fixture()
    for (const key of ["nope", "a/b1"]) {
      const result = removeBlock(doc, key)
      expect(result.doc).toBe(doc)
      expect(result.focusKey).toBeNull()
    }
  })
})

describe("indentBlock", () => {
  it("makes a block the last child of its previous sibling, and says where it went", () => {
    const next = indentBlock(fixture(), "c")
    expect(next.doc.rootBlockIds).toEqual(["a", "b"])
    expect(next.doc.blocks["b"].children).toEqual(["b1", "c"])
    expect(next.key).toBe("b/c")
  })

  it("carries a block's own subtree when indenting", () => {
    const next = indentBlock(fixture(), "b").doc
    expect(next.rootBlockIds).toEqual(["a", "c"])
    expect(next.blocks["a"].children).toEqual(["b"])
    // b keeps its child.
    expect(next.blocks["b"].children).toEqual(["b1"])
  })

  it("is a no-op for the first block in its list", () => {
    const doc = fixture()
    expect(indentBlock(doc, "a")).toEqual({ doc, key: "a" })
  })

  it("is a no-op for a first child", () => {
    const doc = fixture()
    expect(indentBlock(doc, "b/b1").doc).toBe(doc)
  })

  it("is a no-op when the previous sibling already holds the block", () => {
    // s hangs under p, and beside p at the root: indenting the root row would
    // put s under p twice.
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["p", "s"],
      blocks: {
        p: { id: "p", type: "ul", text: "p", children: ["s"] },
        s: { id: "s", type: "ul", text: "s", children: [] },
      },
    }
    expect(indentBlock(doc, "s").doc).toBe(doc)
  })

  it("leaves the original doc untouched", () => {
    const doc = fixture()
    indentBlock(doc, "c")
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
    expect(doc.blocks["b"].children).toEqual(["b1"])
  })
})

describe("outdentBlock", () => {
  it("lifts a block to be a sibling of its parent, just after it, and says where", () => {
    const next = outdentBlock(fixture(), "b/b1")
    expect(next.doc.rootBlockIds).toEqual(["a", "b", "b1", "c"])
    expect(next.doc.blocks["b"].children).toEqual([])
    expect(next.key).toBe("b1")
  })

  it("is a no-op for a top-level block", () => {
    const doc = fixture()
    expect(outdentBlock(doc, "a")).toEqual({ doc, key: "a" })
  })

  it("returns the same doc for an unknown key", () => {
    const doc = fixture()
    expect(outdentBlock(doc, "nope").doc).toBe(doc)
  })

  it("leaves the original doc untouched", () => {
    const doc = fixture()
    outdentBlock(doc, "b/b1")
    expect(doc.rootBlockIds).toEqual(["a", "b", "c"])
    expect(doc.blocks["b"].children).toEqual(["b1"])
  })

  it("preserves a deeper subtree when outdenting", () => {
    // a > b > b1 > b1a; outdent b1 -> a > [b, b1>b1a]
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["a"],
      blocks: {
        a: { id: "a", type: "text", text: "A", children: ["b"] },
        b: { id: "b", type: "text", text: "B", children: ["b1"] },
        b1: { id: "b1", type: "text", text: "B1", children: ["b1a"] },
        b1a: { id: "b1a", type: "text", text: "B1A", children: [] },
      },
    }
    const next = outdentBlock(doc, "a/b/b1")
    expect(next.doc.blocks["a"].children).toEqual(["b", "b1"])
    expect(next.doc.blocks["b"].children).toEqual([])
    expect(next.doc.blocks["b1"].children).toEqual(["b1a"])
    expect(next.key).toBe("a/b1")
  })
})
