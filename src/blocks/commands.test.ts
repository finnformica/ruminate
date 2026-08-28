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

describe("wasd sibling traversal (treePrev / treeNext break out of the level)", () => {
  /** A deeper fixture:
   *   - a  "A"
   *   - b  "B"
   *     - b1 "B1"
   *       - b2 "B2"
   *   - c  "C"
   */
  function deep(): BlockDoc {
    return {
      frontmatter: null,
      rootBlockIds: ["a", "b", "c"],
      blocks: {
        a: { id: "a", content: "A", children: [] },
        b: { id: "b", content: "B", children: ["b1"] },
        b1: { id: "b1", content: "B1", children: ["b2"] },
        b2: { id: "b2", content: "B2", children: [] },
        c: { id: "c", content: "C", children: [] },
      },
    }
  }

  it("moves across siblings mid-level, skipping descendants", () => {
    const doc = fixture()
    expect(runCommand("treeNext", input(doc, "b")).focus).toEqual({ mode: "select", id: "c" })
    expect(runCommand("treePrev", input(doc, "c")).focus).toEqual({ mode: "select", id: "b" })
  })

  it("treePrev at the first sibling of a level breaks out to the parent", () => {
    const doc = fixture()
    expect(runCommand("treePrev", input(doc, "b1")).focus).toEqual({ mode: "select", id: "b" })
  })

  it("treePrev on the first root block no-ops (nothing above)", () => {
    const doc = fixture()
    const result = runCommand("treePrev", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.focus).toBeUndefined()
  })

  it("treeNext at the last sibling continues at the ancestor's next sibling", () => {
    const doc = fixture()
    expect(runCommand("treeNext", input(doc, "b1")).focus).toEqual({ mode: "select", id: "c" })
  })

  it("treeNext walks multiple levels up to find the next block", () => {
    const doc = deep()
    // b2 → b1 (last) → b (has next sibling c): two levels up.
    expect(runCommand("treeNext", input(doc, "b2")).focus).toEqual({ mode: "select", id: "c" })
  })

  it("treeNext no-ops at the true end of the document", () => {
    const doc = fixture()
    expect(runCommand("treeNext", input(doc, "c")).focus).toBeUndefined()
    // Deep last block with no ancestor-next anywhere: also a no-op.
    const noTail = deep()
    noTail.rootBlockIds = ["a", "b"]
    expect(runCommand("treeNext", input(noTail, "b2")).focus).toBeUndefined()
  })

  it("clamps at the zoom boundary (never escapes the zoomed subtree)", () => {
    const doc = deep()
    const zoomed = (id: string): Parameters<typeof runCommand>[1] =>
      input(doc, id, { visibleOrder: ["b", "b1", "b2"], zoomRootId: "b" })
    // The title's own siblings are outside the view: both no-op on the title
    // (w does NOT zoom out — that stays `a`'s job).
    for (const name of ["treePrev", "treeNext"] as const) {
      const result = runCommand(name, zoomed("b"))
      expect(result.handled).toBe(true)
      expect(result.focus).toBeUndefined()
      expect(result.zoom).toBeUndefined()
    }
    // w on a direct child of the zoom root breaks out to the title (in view).
    expect(runCommand("treePrev", zoomed("b1")).focus).toEqual({ mode: "select", id: "b" })
    // s at the end of the zoomed subtree would have to climb past the title
    // to reach c — clamp instead.
    expect(runCommand("treeNext", zoomed("b2")).focus).toBeUndefined()
    expect(runCommand("treeNext", zoomed("b1")).focus).toBeUndefined()
  })
})

describe("wasd depth navigation (selectParent / selectFirstChild)", () => {
  it("selectParent steps from a nested block to its parent", () => {
    const doc = fixture()
    expect(runCommand("selectParent", input(doc, "b1")).focus).toEqual({ mode: "select", id: "b" })
  })

  it("selectParent consumes the key but stays put on a root-level block", () => {
    const doc = fixture()
    const result = runCommand("selectParent", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.focus).toBeUndefined()
    expect(result.zoom).toBeUndefined()
  })

  it("selectFirstChild steps into the first child, demanding it be expanded", () => {
    const doc = fixture()
    const result = runCommand("selectFirstChild", input(doc, "b"))
    expect(result.focus).toEqual({ mode: "select", id: "b1" })
    // A collapsed parent must open in the same keypress: the command can't see
    // collapse state, so it always demands the block be expanded.
    expect(result.expand).toBe("b")
  })

  it("selectFirstChild consumes the key but does nothing on a leaf", () => {
    const doc = fixture()
    const result = runCommand("selectFirstChild", input(doc, "b1"))
    expect(result.handled).toBe(true)
    expect(result.focus).toBeUndefined()
    expect(result.expand).toBeUndefined()
  })

  it("while zoomed, selectParent on a direct child selects the title, and on the title zooms out", () => {
    const doc = fixture()
    const zoomed = (id: string): Parameters<typeof runCommand>[1] =>
      input(doc, id, { visibleOrder: ["b", "b1"], zoomRootId: "b" })
    // Direct child of the zoom root → the zoom-root title (falls out of the
    // ordinary parent walk, since the title is the child's parent).
    expect(runCommand("selectParent", zoomed("b1")).focus).toEqual({ mode: "select", id: "b" })
    // The title itself → zoom out one level ("a always goes up the tree").
    // b is root-level, so one level out is a full exit — same as zoomOut.
    expect(runCommand("selectParent", zoomed("b")).zoom).toEqual({ id: null })
    // A nested zoom root steps out to its parent instead of exiting fully.
    const nested = input(doc, "b1", { visibleOrder: ["b1"], zoomRootId: "b1" })
    expect(runCommand("selectParent", nested).zoom).toEqual({ id: "b" })
  })

  it("while zoomed, selectFirstChild on the title selects its first child", () => {
    const doc = fixture()
    const result = runCommand(
      "selectFirstChild",
      input(doc, "b", { visibleOrder: ["b", "b1"], zoomRootId: "b" }),
    )
    expect(result.focus).toEqual({ mode: "select", id: "b1" })
  })
})

describe("arrow-key folding (expandOrFirstChild / collapseOrParent)", () => {
  // Commands can't see collapse state; a block with children reads as
  // collapsed exactly when its first child is absent from visibleOrder.
  const collapsedB = ["a", "b", "c"] // b's child b1 is hidden

  it("→ expands a collapsed block, staying on it (an expand demand, no focus move)", () => {
    const doc = fixture()
    const result = runCommand("expandOrFirstChild", input(doc, "b", { visibleOrder: collapsedB }))
    expect(result.handled).toBe(true)
    expect(result.expand).toBe("b")
    expect(result.focus).toBeUndefined()
  })

  it("→ on an expanded block steps into the first child (no expand demand)", () => {
    const doc = fixture()
    const result = runCommand("expandOrFirstChild", input(doc, "b"))
    expect(result.focus).toEqual({ mode: "select", id: "b1" })
    expect(result.expand).toBeUndefined()
  })

  it("→ consumes the key but does nothing on a leaf", () => {
    const doc = fixture()
    const result = runCommand("expandOrFirstChild", input(doc, "b1"))
    expect(result.handled).toBe(true)
    expect(result.focus).toBeUndefined()
    expect(result.expand).toBeUndefined()
  })

  it("← collapses an expanded block, staying on it (a collapse demand, no focus move)", () => {
    const doc = fixture()
    const result = runCommand("collapseOrParent", input(doc, "b"))
    expect(result.handled).toBe(true)
    expect(result.collapse).toBe("b")
    expect(result.focus).toBeUndefined()
    // A demand, not a toggle — never the unconditional toggleCollapse channel.
    expect(result.toggleCollapse).toBeUndefined()
  })

  it("← on a leaf steps out to the parent", () => {
    const doc = fixture()
    const result = runCommand("collapseOrParent", input(doc, "b1"))
    expect(result.focus).toEqual({ mode: "select", id: "b" })
    expect(result.collapse).toBeUndefined()
  })

  it("← on a collapsed (non-root) block steps out to the parent", () => {
    // b1 gains a child of its own and is collapsed (b1a hidden from the order).
    const doc = fixture()
    doc.blocks.b1 = { id: "b1", content: "B1", children: ["b1a"] }
    doc.blocks.b1a = { id: "b1a", content: "B1a", children: [] }
    const result = runCommand("collapseOrParent", input(doc, "b1"))
    expect(result.focus).toEqual({ mode: "select", id: "b" })
    expect(result.collapse).toBeUndefined()
  })

  it("← no-ops on a root-level leaf or collapsed block", () => {
    const doc = fixture()
    for (const result of [
      runCommand("collapseOrParent", input(doc, "a")),
      runCommand("collapseOrParent", input(doc, "b", { visibleOrder: collapsedB })),
    ]) {
      expect(result.handled).toBe(true)
      expect(result.focus).toBeUndefined()
      expect(result.collapse).toBeUndefined()
    }
  })

  it("while zoomed, ← is a no-op on the title and selects the title from a direct child", () => {
    const doc = fixture()
    const zoomed = (id: string) => input(doc, id, { visibleOrder: ["b", "b1"], zoomRootId: "b" })
    // The title is pinned open and zoom-out stays `a`'s job — never collapse,
    // never zoom, never escape the subtree.
    const onTitle = runCommand("collapseOrParent", zoomed("b"))
    expect(onTitle.handled).toBe(true)
    expect(onTitle.collapse).toBeUndefined()
    expect(onTitle.focus).toBeUndefined()
    expect(onTitle.zoom).toBeUndefined()
    // A direct child's "parent" is the zoom root — its title, still in view.
    expect(runCommand("collapseOrParent", zoomed("b1")).focus).toEqual({ mode: "select", id: "b" })
  })

  it("while zoomed, → on the title steps into its first child (children always render)", () => {
    const doc = fixture()
    const result = runCommand(
      "expandOrFirstChild",
      input(doc, "b", { visibleOrder: ["b", "b1"], zoomRootId: "b" }),
    )
    expect(result.focus).toEqual({ mode: "select", id: "b1" })
    expect(result.expand).toBeUndefined()
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

describe("turn into (select-mode marker keys)", () => {
  function docOf(content: string): BlockDoc {
    return {
      frontmatter: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", content, children: [] } },
    }
  }
  const turn = (name: Parameters<typeof runCommand>[0], content: string) =>
    runCommand(name, input(docOf(content), "x", { visibleOrder: ["x"] }))

  it("toggles each type on from a paragraph, and back off to a paragraph", () => {
    const cases: [Parameters<typeof runCommand>[0], string][] = [
      ["turnIntoHeading", "# A"],
      ["turnIntoBullet", "- A"],
      ["turnIntoTodo", "[ ] A"],
      ["turnIntoQuote", "> A"],
      ["turnIntoOrdered", "1. A"],
    ]
    for (const [name, marked] of cases) {
      expect(turn(name, "A").doc!.blocks.x.content).toBe(marked)
      expect(turn(name, marked).doc!.blocks.x.content).toBe("A")
    }
  })

  it("swaps the marker when the block is another type, body byte-exact", () => {
    expect(turn("turnIntoHeading", "- hello  world").doc!.blocks.x.content).toBe("# hello  world")
    expect(turn("turnIntoTodo", "# hello  world").doc!.blocks.x.content).toBe("[ ] hello  world")
    expect(turn("turnIntoBullet", "3) counted").doc!.blocks.x.content).toBe("- counted")
  })

  it("a checked todo is still a todo: [ strips it, x keeps toggling the check", () => {
    expect(turn("turnIntoTodo", "[x] done").doc!.blocks.x.content).toBe("done")
    expect(turn("toggleTodo", "[x] done").doc!.blocks.x.content).toBe("[ ] done")
  })

  it("ordered toggles off from any number", () => {
    expect(turn("turnIntoOrdered", "7. seventh").doc!.blocks.x.content).toBe("seventh")
  })

  it("stays selected on a block with content, as one structural undo step", () => {
    const result = turn("turnIntoHeading", "A")
    expect(result.focus).toEqual({ mode: "select", id: "x" })
    expect(result.op).toEqual({ type: "structural" })
  })

  it("an empty block applies the marker AND opens editing", () => {
    const result = turn("turnIntoBullet", "")
    expect(result.doc!.blocks.x.content).toBe("- ")
    expect(result.focus).toEqual({ mode: "edit", id: "x" })
    // Swapping one empty marker for another stays in edit too.
    const swapped = turn("turnIntoTodo", "- ")
    expect(swapped.doc!.blocks.x.content).toBe("[ ] ")
    expect(swapped.focus).toEqual({ mode: "edit", id: "x" })
  })

  it("never touches children (marker swap only)", () => {
    const doc = fixture() // b "B" has child b1
    const result = runCommand("turnIntoQuote", input(doc, "b"))
    expect(result.doc!.blocks.b.content).toBe("> B")
    expect(result.doc!.blocks.b.children).toEqual(["b1"])
    expect(result.doc!.blocks.b1.content).toBe("B1")
  })

  it("works on the zoomed title (a content-type change stays in view)", () => {
    const doc = fixture()
    const result = runCommand(
      "turnIntoHeading",
      input(doc, "b", { visibleOrder: ["b", "b1"], zoomRootId: "b" }),
    )
    expect(result.doc!.blocks.b.content).toBe("# B")
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

describe("zoom", () => {
  /** Command input as seen while zoomed into `b` (visible: b as title, then b1). */
  function zoomed(doc: BlockDoc, id: string, over: Partial<CommandInput> = {}): CommandInput {
    return { doc, id, mode: "select", visibleOrder: ["b", "b1"], zoomRootId: "b", ...over }
  }

  it("zoomIn requests a zoom into the block", () => {
    const doc = fixture()
    expect(runCommand("zoomIn", input(doc, "b")).zoom).toEqual({ id: "b" })
  })

  it("zoomIn on the zoom root itself is a no-op", () => {
    const doc = fixture()
    const result = runCommand("zoomIn", zoomed(doc, "b"))
    expect(result.handled).toBe(true)
    expect(result.zoom).toBeUndefined()
  })

  it("zoomOut steps to the parent, and to null from a root-level zoom", () => {
    const doc = fixture()
    // Zoomed into b1 (a nested block): out lands on its parent b.
    expect(
      runCommand("zoomOut", input(doc, "b1", { visibleOrder: ["b1"], zoomRootId: "b1" })).zoom,
    ).toEqual({ id: "b" })
    // Zoomed into b (a root block): out exits fully.
    expect(runCommand("zoomOut", zoomed(doc, "b1")).zoom).toEqual({ id: null })
  })

  it("zoomOut / zoomExit are ignored when not zoomed", () => {
    const doc = fixture()
    expect(runCommand("zoomOut", input(doc, "b")).handled).toBe(false)
    expect(runCommand("zoomExit", input(doc, "b")).handled).toBe(false)
  })

  it("zoomExit requests a full exit", () => {
    const doc = fixture()
    expect(runCommand("zoomExit", zoomed(doc, "b1")).zoom).toEqual({ id: null })
  })

  it("outdent refuses at the zoom boundary (root and its direct children)", () => {
    const doc = fixture()
    for (const id of ["b", "b1"]) {
      const result = runCommand("outdent", zoomed(doc, id))
      expect(result.handled).toBe(true)
      expect(result.doc).toBeUndefined()
    }
    // The same block outdents fine when not zoomed.
    expect(runCommand("outdent", input(doc, "b1")).doc).toBeDefined()
  })

  it("indent refuses on the zoom root", () => {
    const doc = fixture()
    expect(runCommand("indent", zoomed(doc, "b")).doc).toBeUndefined()
  })

  it("delete and backspace refuse on the zoom root, but children still delete", () => {
    const doc = fixture()
    expect(runCommand("deleteBlock", zoomed(doc, "b")).doc).toBeUndefined()
    expect(runCommand("backspaceEmpty", zoomed(doc, "b", { mode: "edit" })).doc).toBeUndefined()
    // Deleting the last child is allowed — the title alone is a valid view.
    const result = runCommand("deleteBlock", zoomed(doc, "b1"))
    expect(result.doc!.blocks.b1).toBeUndefined()
    expect(result.focus).toEqual({ mode: "select", id: "b" })
  })

  it("move / duplicate are no-ops on the zoom root", () => {
    const doc = fixture()
    for (const name of [
      "moveBlockUp",
      "moveBlockDown",
      "duplicateAbove",
      "duplicateBelow",
    ] as const) {
      const result = runCommand(name, zoomed(doc, "b"))
      expect(result.handled).toBe(true)
      expect(result.doc).toBeUndefined()
    }
  })

  it("level and sibling jumps clamp at the zoom root", () => {
    const doc = fixture()
    for (const name of ["jumpLevelTop", "jumpLevelBottom", "prevSibling", "nextSibling"] as const) {
      const result = runCommand(name, zoomed(doc, "b"))
      expect(result.handled).toBe(true)
      expect(result.focus).toBeUndefined()
    }
    // A child can still jump up to the (visible) zoom root.
    expect(runCommand("jumpLevelTop", zoomed(doc, "b1")).focus).toEqual({
      mode: "select",
      id: "b",
    })
  })

  it("Enter variants on the zoom root create its FIRST child, not a sibling", () => {
    const doc = fixture()
    for (const name of ["insertBelow", "insertSiblingBelow"] as const) {
      const result = runCommand(name, zoomed(doc, "b"))
      const id = newBlockId(doc, result.doc!)
      expect(result.doc!.blocks.b.children).toEqual([id, "b1"])
      expect(result.doc!.rootBlockIds).toEqual(["a", "b", "c"])
      expect(result.focus).toEqual({ mode: "edit", id })
    }
    // Splitting the title mid-line drops the tail into the first child too.
    const split = runCommand(
      "splitContinuingList",
      zoomed(doc, "b", { mode: "edit", caret: caret("B", 1) }),
    )
    const id = newBlockId(doc, split.doc!)
    expect(split.doc!.blocks.b.children).toEqual([id, "b1"])
  })

  it("swallows upward exits at the top of the zoomed view (never the note title)", () => {
    const doc = fixture()
    // Select mode on the title (visibleOrder[0]).
    const select = runCommand("moveSelectionUp", zoomed(doc, "b"))
    expect(select.handled).toBe(true)
    expect(select.exitTop).toBeUndefined()
    // Edit mode on the title: commit the edit, stay on the title.
    const edit = runCommand("moveEditFocusUp", zoomed(doc, "b", { mode: "edit" }))
    expect(edit.exitTop).toBeUndefined()
    expect(edit.focus).toEqual({ mode: "select", id: "b" })
    // Arrow-up from the first child selects the title.
    expect(runCommand("moveSelectionUp", zoomed(doc, "b1")).focus).toEqual({
      mode: "select",
      id: "b",
    })
  })

  it("pins the zoomed title open (Space cannot collapse the whole view)", () => {
    const doc = fixture()
    const result = runCommand("toggleCollapse", zoomed(doc, "b"))
    expect(result.handled).toBe(true)
    expect(result.toggleCollapse).toBeUndefined()
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
