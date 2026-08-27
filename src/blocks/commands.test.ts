import { describe, expect, it } from "vitest"
import { runCommand, type CaretInput, type CommandInput, type Mode } from "./commands"
import type { BlockDoc } from "./types"

/**
 * A small fixture:
 *   - a  "A"
 *   - b  "B"
 *     - b1 "B1"
 *   - c  "C"
 */
function fixture(): BlockDoc {
  return {
    frontmatter: null,
    rootBlockIds: ["a", "b", "c"],
    blocks: {
      a: { id: "a", content: "A", children: [] },
      b: { id: "b", content: "B", children: ["b1"] },
      b1: { id: "b1", content: "B1", children: [] },
      c: { id: "c", content: "C", children: [] },
    },
  }
}

function input(
  doc: BlockDoc,
  id: string,
  over: Partial<Omit<CommandInput, "doc" | "id">> = {},
): CommandInput {
  return { doc, id, mode: "select", visibleOrder: ["a", "b", "b1", "c"], ...over }
}

function caret(value: string, start: number, end = start, lines = {}): CaretInput {
  return { value, start, end, atFirstLine: false, atLastLine: false, ...lines }
}

/** The id present in `after` but not `before` (a freshly minted block). */
function newBlockId(before: BlockDoc, after: BlockDoc): string {
  const id = Object.keys(after.blocks).find((k) => !(k in before.blocks))
  if (!id) throw new Error("no new block")
  return id
}

describe("indent / outdent", () => {
  it("indents a block under its previous sibling, keeping select focus", () => {
    const doc = fixture()
    const result = runCommand("indent", input(doc, "c", { mode: "select" }))
    expect(result.handled).toBe(true)
    expect(result.doc!.blocks.b.children).toEqual(["b1", "c"])
    expect(result.doc!.rootBlockIds).toEqual(["a", "b"])
    expect(result.focus).toEqual({ mode: "select", id: "c" })
  })

  it("keeps edit focus and the caret position when indenting in edit mode", () => {
    const doc = fixture()
    const result = runCommand("indent", input(doc, "c", { mode: "edit", caret: caret("C", 1) }))
    // The caret rides along with the block rather than jumping to its end.
    expect(result.focus).toEqual({ mode: "edit", id: "c", caret: 1 })
  })

  it("consumes the key but does nothing when it cannot indent", () => {
    const doc = fixture()
    const result = runCommand("indent", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.doc).toBeUndefined()
  })

  it("outdents a nested block to sibling of its parent", () => {
    const doc = fixture()
    const result = runCommand("outdent", input(doc, "b1", { mode: "select" }))
    expect(result.doc!.blocks.b.children).toEqual([])
    expect(result.doc!.rootBlockIds).toEqual(["a", "b", "b1", "c"])
  })
})

describe("selection movement", () => {
  it("moves the highlight down the visible order", () => {
    const doc = fixture()
    const result = runCommand("moveSelectionDown", input(doc, "b"))
    expect(result.focus).toEqual({ mode: "select", id: "b1" })
  })

  it("signals exitTop when moving up past the first block", () => {
    const doc = fixture()
    const result = runCommand("moveSelectionUp", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.focus).toBeUndefined()
    expect(result.exitTop).toBe(true)
  })

  it("consumes the key at the bottom without moving or exiting", () => {
    const doc = fixture()
    const result = runCommand("moveSelectionDown", input(doc, "c"))
    expect(result.handled).toBe(true)
    expect(result.focus).toBeUndefined()
    expect(result.exitTop).toBeUndefined()
  })

  it("arrow-out of edit mode commits the edit and selects the neighbour", () => {
    const doc = fixture()
    expect(runCommand("moveEditFocusUp", input(doc, "b", { mode: "edit" })).focus).toEqual({
      mode: "select",
      id: "a",
    })
    expect(runCommand("moveEditFocusDown", input(doc, "b", { mode: "edit" })).focus).toEqual({
      mode: "select",
      id: "b1",
    })
  })

  it("arrow-down on the very last block exits edit and selects it", () => {
    const doc = fixture()
    expect(runCommand("moveEditFocusDown", input(doc, "c", { mode: "edit" })).focus).toEqual({
      mode: "select",
      id: "c",
    })
  })

  it("arrow-up on the very first block still exits to the title", () => {
    const doc = fixture()
    const result = runCommand("moveEditFocusUp", input(doc, "a", { mode: "edit" }))
    expect(result.exitTop).toBe(true)
  })

  it("recovers onto the nearest visible ancestor when the block is hidden", () => {
    // b collapsed: b1 no longer in visibleOrder but is still selected.
    const doc = fixture()
    const result = runCommand(
      "moveSelectionDown",
      input(doc, "b1", { visibleOrder: ["a", "b", "c"] }),
    )
    expect(result.handled).toBe(true)
    expect(result.focus).toEqual({ mode: "select", id: "b" })
  })
})

describe("sibling & level navigation", () => {
  it("jumps to the previous / next sibling, skipping nested blocks", () => {
    const doc = fixture()
    expect(runCommand("nextSibling", input(doc, "b")).focus).toEqual({ mode: "select", id: "c" })
    expect(runCommand("prevSibling", input(doc, "b")).focus).toEqual({ mode: "select", id: "a" })
  })

  it("stops at the ends of a sibling group", () => {
    const doc = fixture()
    expect(runCommand("prevSibling", input(doc, "a")).focus).toBeUndefined()
    // b1 is an only child, so it has no siblings to move to.
    expect(runCommand("nextSibling", input(doc, "b1")).focus).toBeUndefined()
  })

  it("jumps to the top of the level, then up to the parent", () => {
    const doc = fixture()
    expect(runCommand("jumpLevelTop", input(doc, "c")).focus).toEqual({ mode: "select", id: "a" })
    // b1's level has one item; already at top, so step up to parent b.
    expect(runCommand("jumpLevelTop", input(doc, "b1")).focus).toEqual({ mode: "select", id: "b" })
    // a is already the first root block — nowhere further up.
    expect(runCommand("jumpLevelTop", input(doc, "a")).focus).toBeUndefined()
  })

  it("jumps to the bottom of the level", () => {
    const doc = fixture()
    expect(runCommand("jumpLevelBottom", input(doc, "a")).focus).toEqual({
      mode: "select",
      id: "c",
    })
  })
})

describe("moveBlock", () => {
  it("reorders a block among its siblings, keeping focus on it", () => {
    const doc = fixture()
    const result = runCommand("moveBlockDown", input(doc, "a", { mode: "select" }))
    expect(result.doc!.rootBlockIds).toEqual(["b", "a", "c"])
    expect(result.focus).toEqual({ mode: "select", id: "a" })
  })

  it("consumes the key but does nothing at the boundary", () => {
    const doc = fixture()
    const result = runCommand("moveBlockUp", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.doc).toBeUndefined()
  })
})

describe("duplicate", () => {
  it("duplicateBelow copies the subtree below and selects the copy", () => {
    const doc = fixture()
    const result = runCommand("duplicateBelow", input(doc, "b", { mode: "select" }))
    expect(result.doc!.rootBlockIds).toHaveLength(4)
    const copyId = result.doc!.rootBlockIds[2]
    expect(result.doc!.rootBlockIds).toEqual(["a", "b", copyId, "c"])
    expect(result.doc!.blocks[copyId].content).toBe("B")
    // The subtree came along, with a fresh id of its own.
    const childCopy = result.doc!.blocks[copyId].children[0]
    expect(childCopy).not.toBe("b1")
    expect(result.doc!.blocks[childCopy].content).toBe("B1")
    // The original is untouched.
    expect(result.doc!.blocks.b.children).toEqual(["b1"])
    expect(result.focus).toEqual({ mode: "select", id: copyId })
  })

  it("duplicateAbove inserts the copy before the original and selects it", () => {
    const doc = fixture()
    const result = runCommand("duplicateAbove", input(doc, "a", { mode: "select" }))
    const copyId = result.doc!.rootBlockIds[0]
    expect(result.doc!.rootBlockIds).toEqual([copyId, "a", "b", "c"])
    expect(result.doc!.blocks[copyId].content).toBe("A")
    expect(result.focus).toEqual({ mode: "select", id: copyId })
  })

  it("keeps editing the copy (caret preserved) in edit mode", () => {
    const doc = fixture()
    const result = runCommand(
      "duplicateBelow",
      input(doc, "a", { mode: "edit", caret: caret("A", 1) }),
    )
    const copyId = result.doc!.rootBlockIds[1]
    expect(result.focus).toEqual({ mode: "edit", id: copyId, caret: 1 })
  })
})

describe("deleteBlock", () => {
  it("removes a block and highlights the previous sibling", () => {
    const doc = fixture()
    const result = runCommand("deleteBlock", input(doc, "c"))
    expect(result.doc!.blocks.c).toBeUndefined()
    expect(result.doc!.rootBlockIds).toEqual(["a", "b"])
    expect(result.focus).toEqual({ mode: "select", id: "b" })
  })

  it("refuses to delete the only block", () => {
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["only"],
      blocks: { only: { id: "only", content: "", children: [] } },
    }
    const result = runCommand("deleteBlock", input(doc, "only", { visibleOrder: ["only"] }))
    expect(result.handled).toBe(true)
    expect(result.doc).toBeUndefined()
  })
})

describe("toggleTodo", () => {
  it("checks an unchecked todo", () => {
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["t"],
      blocks: { t: { id: "t", content: "[ ] task", children: [] } },
    }
    const result = runCommand("toggleTodo", input(doc, "t", { visibleOrder: ["t"] }))
    expect(result.doc!.blocks.t.content).toBe("[x] task")
  })

  it("ignores non-todo blocks", () => {
    const doc = fixture()
    expect(runCommand("toggleTodo", input(doc, "a")).handled).toBe(false)
  })
})

describe("toggleCollapse", () => {
  it("requests a toggle for a block with children", () => {
    const doc = fixture()
    expect(runCommand("toggleCollapse", input(doc, "b")).toggleCollapse).toBe("b")
  })

  it("consumes the key but toggles nothing for a leaf (space must never scroll)", () => {
    const doc = fixture()
    const result = runCommand("toggleCollapse", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.toggleCollapse).toBeUndefined()
  })
})

describe("insertBelow", () => {
  it("adds an unordered-list continuation block by default", () => {
    const doc = fixture()
    const result = runCommand("insertBelow", input(doc, "a", { mode: "edit" }))
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks[id].content).toBe("- ")
    expect(result.doc!.rootBlockIds).toEqual(["a", id, "b", "c"])
    expect(result.focus).toEqual({ mode: "edit", id })
  })

  it("nests the new block under a heading", () => {
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["h"],
      blocks: { h: { id: "h", content: "# Title", children: [] } },
    }
    const result = runCommand("insertBelow", input(doc, "h", { mode: "edit", visibleOrder: ["h"] }))
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.rootBlockIds).toEqual(["h"])
    expect(result.doc!.blocks.h.children).toEqual([id])
    expect(result.doc!.blocks[id].content).toBe("- ")
  })
})

describe("insertSiblingBelow", () => {
  it("keeps the block's own type (heading stays a heading, sibling not nested)", () => {
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["h"],
      blocks: { h: { id: "h", content: "# Title", children: [] } },
    }
    const result = runCommand("insertSiblingBelow", input(doc, "h", { visibleOrder: ["h"] }))
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.rootBlockIds).toEqual(["h", id])
    expect(result.doc!.blocks[id].content).toBe("# ")
  })

  it("keeps a todo a todo", () => {
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["t"],
      blocks: { t: { id: "t", content: "[x] done", children: [] } },
    }
    const result = runCommand("insertSiblingBelow", input(doc, "t", { visibleOrder: ["t"] }))
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks[id].content).toBe("[ ] ")
  })
})

describe("split", () => {
  it("splits a list item at the caret, continuing the marker", () => {
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", content: "- hello", children: [] } },
    }
    const result = runCommand(
      "splitContinuingList",
      input(doc, "x", { mode: "edit", visibleOrder: ["x"], caret: caret("hello", 2) }),
    )
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks.x.content).toBe("- he")
    expect(result.doc!.blocks[id].content).toBe("- llo")
    expect(result.focus).toEqual({ mode: "edit", id, atStart: true })
  })

  it("shift-enter splits carrying the same block type", () => {
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", content: "- hello", children: [] } },
    }
    const result = runCommand(
      "splitPlain",
      input(doc, "x", { mode: "edit", visibleOrder: ["x"], caret: caret("hello", 2) }),
    )
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks.x.content).toBe("- he")
    expect(result.doc!.blocks[id].content).toBe("- llo")
  })

  it("shift-enter on a heading makes another heading", () => {
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", content: "# Title", children: [] } },
    }
    const result = runCommand(
      "splitPlain",
      input(doc, "x", { mode: "edit", visibleOrder: ["x"], caret: caret("Title", 5) }),
    )
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks[id].content).toBe("# ")
  })
})

describe("marker editing", () => {
  it("exitList clears an empty list item to a paragraph", () => {
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", content: "- ", children: [] } },
    }
    const result = runCommand("exitList", input(doc, "x", { mode: "edit", visibleOrder: ["x"] }))
    expect(result.doc!.blocks.x.content).toBe("")
  })

  it("stripMarker removes the leading marker", () => {
    const doc: BlockDoc = {
      frontmatter: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", content: "# Heading", children: [] } },
    }
    const result = runCommand("stripMarker", input(doc, "x", { mode: "edit", visibleOrder: ["x"] }))
    expect(result.doc!.blocks.x.content).toBe("Heading")
    expect(result.focus).toEqual({ mode: "edit", id: "x", atStart: true })
  })

  it("backspaceEmpty removes an empty block and edits the previous one", () => {
    const doc = fixture()
    const result = runCommand("backspaceEmpty", input(doc, "c", { mode: "edit" }))
    expect(result.doc!.blocks.c).toBeUndefined()
    // removeBlock hands focus to the previous *sibling* (b), not b1.
    expect(result.focus).toEqual({ mode: "edit", id: "b" })
  })
})

describe("mode toggles", () => {
  const doc = fixture()
  const cases: [Parameters<typeof runCommand>[0], Mode, Mode][] = [
    ["enterEdit", "select", "edit"],
    ["exitEdit", "edit", "select"],
  ]
  it.each(cases)("%s focuses %s → %s", (name, from, to) => {
    const result = runCommand(name, input(doc, "a", { mode: from }))
    expect(result.focus).toEqual({ mode: to, id: "a" })
  })

  it("deselect clears the highlight entirely", () => {
    const result = runCommand("deselect", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.focus).toEqual({ mode: "select", id: null })
  })
})
