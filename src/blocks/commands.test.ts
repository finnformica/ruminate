import { describe, expect, it } from "vitest"
import {
  linkSelection,
  runCommand,
  wrapSelection,
  type CaretInput,
  type CommandInput,
  type Mode,
} from "./commands"
import { parseLine } from "./parse"
import type { BlockDoc, BlockType } from "./types"

/**
 * A small fixture:
 *   - a  "A"
 *   - b  "B"
 *     - b1 "B1"
 *   - c  "C"
 */
function fixture(): BlockDoc {
  return {
    props: null,
    rootBlockIds: ["a", "b", "c"],
    blocks: {
      a: { id: "a", type: "text", text: "A", children: [] },
      b: { id: "b", type: "text", text: "B", children: ["b1"] },
      b1: { id: "b1", type: "text", text: "B1", children: [] },
      c: { id: "c", type: "text", text: "C", children: [] },
    },
  }
}

/** Command input for the row `key` (an occurrence key: `b/b1` is b1 under b). */
function input(
  doc: BlockDoc,
  key: string,
  over: Partial<Omit<CommandInput, "doc" | "key">> = {},
): CommandInput {
  return { doc, key, mode: "select", visibleOrder: ["a", "b", "b/b1", "c"], ...over }
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
    // Focus follows the row to where it went.
    expect(result.focus).toEqual({ mode: "select", key: "b/c" })
  })

  it("keeps edit focus and the caret position when indenting in edit mode", () => {
    const doc = fixture()
    const result = runCommand("indent", input(doc, "c", { mode: "edit", caret: caret("C", 1) }))
    // The caret rides along with the block rather than jumping to its end.
    expect(result.focus).toEqual({ mode: "edit", key: "b/c", caret: 1 })
  })

  it("consumes the key but does nothing when it cannot indent", () => {
    const doc = fixture()
    const result = runCommand("indent", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.doc).toBeUndefined()
  })

  it("outdents a nested block to sibling of its parent", () => {
    const doc = fixture()
    const result = runCommand("outdent", input(doc, "b/b1", { mode: "select" }))
    expect(result.doc!.blocks.b.children).toEqual([])
    expect(result.doc!.rootBlockIds).toEqual(["a", "b", "b1", "c"])
  })
})

describe("selection movement", () => {
  it("moves the highlight down the visible order", () => {
    const doc = fixture()
    const result = runCommand("moveSelectionDown", input(doc, "b"))
    expect(result.focus).toEqual({ mode: "select", key: "b/b1" })
  })

  it("signals exitTop when moving up past the first block", () => {
    const doc = fixture()
    const result = runCommand("moveSelectionUp", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.focus).toBeUndefined()
    expect(result.exitTop).toBe(true)
  })

  it("consumes the key at the bottom, signalling exitBottom for whatever sits below", () => {
    const doc = fixture()
    const result = runCommand("moveSelectionDown", input(doc, "c"))
    expect(result.handled).toBe(true)
    expect(result.focus).toBeUndefined()
    expect(result.exitTop).toBeUndefined()
    expect(result.exitBottom).toBe(true)
    // Not from a row that has one below it.
    expect(runCommand("moveSelectionDown", input(doc, "a")).exitBottom).toBeUndefined()
  })

  it("arrow-out of edit mode commits the edit and selects the neighbour", () => {
    const doc = fixture()
    expect(runCommand("moveEditFocusUp", input(doc, "b", { mode: "edit" })).focus).toEqual({
      mode: "select",
      key: "a",
    })
    expect(runCommand("moveEditFocusDown", input(doc, "b", { mode: "edit" })).focus).toEqual({
      mode: "select",
      key: "b/b1",
    })
  })

  it("arrow-down on the very last block exits edit and selects it", () => {
    const doc = fixture()
    expect(runCommand("moveEditFocusDown", input(doc, "c", { mode: "edit" })).focus).toEqual({
      mode: "select",
      key: "c",
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
      input(doc, "b/b1", { visibleOrder: ["a", "b", "c"] }),
    )
    expect(result.handled).toBe(true)
    expect(result.focus).toEqual({ mode: "select", key: "b" })
  })
})

describe("sibling & level navigation", () => {
  it("jumps to the previous / next sibling, skipping nested blocks", () => {
    const doc = fixture()
    expect(runCommand("nextSibling", input(doc, "b")).focus).toEqual({ mode: "select", key: "c" })
    expect(runCommand("prevSibling", input(doc, "b")).focus).toEqual({ mode: "select", key: "a" })
  })

  it("stops at the ends of a sibling group", () => {
    const doc = fixture()
    expect(runCommand("prevSibling", input(doc, "a")).focus).toBeUndefined()
    // b1 is an only child, so it has no siblings to move to.
    expect(runCommand("nextSibling", input(doc, "b/b1")).focus).toBeUndefined()
  })

  it("jumps to the top of the level, then up to the parent", () => {
    const doc = fixture()
    expect(runCommand("jumpLevelTop", input(doc, "c")).focus).toEqual({ mode: "select", key: "a" })
    // b1's level has one item; already at top, so step up to parent b.
    expect(runCommand("jumpLevelTop", input(doc, "b/b1")).focus).toEqual({
      mode: "select",
      key: "b",
    })
    // a is already the first root block — nowhere further up.
    expect(runCommand("jumpLevelTop", input(doc, "a")).focus).toBeUndefined()
  })

  it("jumps to the bottom of the level", () => {
    const doc = fixture()
    expect(runCommand("jumpLevelBottom", input(doc, "a")).focus).toEqual({
      mode: "select",
      key: "c",
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
      props: null,
      rootBlockIds: ["a", "b", "c"],
      blocks: {
        a: { id: "a", type: "text", text: "A", children: [] },
        b: { id: "b", type: "text", text: "B", children: ["b1"] },
        b1: { id: "b1", type: "text", text: "B1", children: ["b2"] },
        b2: { id: "b2", type: "text", text: "B2", children: [] },
        c: { id: "c", type: "text", text: "C", children: [] },
      },
    }
  }

  it("moves across siblings mid-level, skipping descendants", () => {
    const doc = fixture()
    expect(runCommand("treeNext", input(doc, "b")).focus).toEqual({ mode: "select", key: "c" })
    expect(runCommand("treePrev", input(doc, "c")).focus).toEqual({ mode: "select", key: "b" })
  })

  it("treePrev at the first sibling of a level breaks out to the parent", () => {
    const doc = fixture()
    expect(runCommand("treePrev", input(doc, "b/b1")).focus).toEqual({ mode: "select", key: "b" })
  })

  it("treePrev on the first root block no-ops (nothing above)", () => {
    const doc = fixture()
    const result = runCommand("treePrev", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.focus).toBeUndefined()
  })

  it("treeNext at the last sibling continues at the ancestor's next sibling", () => {
    const doc = fixture()
    expect(runCommand("treeNext", input(doc, "b/b1")).focus).toEqual({ mode: "select", key: "c" })
  })

  it("treeNext walks multiple levels up to find the next block", () => {
    const doc = deep()
    // b2 → b1 (last) → b (has next sibling c): two levels up.
    expect(runCommand("treeNext", input(doc, "b/b1/b2")).focus).toEqual({
      mode: "select",
      key: "c",
    })
  })

  it("treeNext no-ops at the true end of the document", () => {
    const doc = fixture()
    expect(runCommand("treeNext", input(doc, "c")).focus).toBeUndefined()
    // Deep last block with no ancestor-next anywhere: also a no-op.
    const noTail = deep()
    noTail.rootBlockIds = ["a", "b"]
    expect(runCommand("treeNext", input(noTail, "b/b1/b2")).focus).toBeUndefined()
  })

  it("clamps at the zoom boundary (never escapes the zoomed subtree)", () => {
    const doc = deep()
    const zoomed = (id: string): Parameters<typeof runCommand>[1] =>
      input(doc, id, { visibleOrder: ["b/b1", "b/b1/b2"], zoomRootId: "b" })
    // w on a direct child of the zoom root breaks out to the title — not a
    // row, but the view's title above them (`exitTop`), never a zoom out
    // (that stays `a`'s job).
    const up = runCommand("treePrev", zoomed("b/b1"))
    expect(up).toEqual({ handled: true, exitTop: true })
    expect(up.zoom).toBeUndefined()
    // s at the end of the zoomed subtree would have to climb past the title
    // to reach c — clamp instead.
    expect(runCommand("treeNext", zoomed("b/b1/b2")).focus).toBeUndefined()
    expect(runCommand("treeNext", zoomed("b/b1")).focus).toBeUndefined()
  })
})

describe("wasd depth navigation (selectParent / selectFirstChild)", () => {
  it("selectParent steps from a nested block to its parent", () => {
    const doc = fixture()
    expect(runCommand("selectParent", input(doc, "b/b1")).focus).toEqual({
      mode: "select",
      key: "b",
    })
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
    expect(result.focus).toEqual({ mode: "select", key: "b/b1" })
    // A collapsed parent must open in the same keypress: the command can't see
    // collapse state, so it always demands the block be expanded.
    expect(result.expand).toBe("b")
  })

  it("selectFirstChild consumes the key but does nothing on a leaf", () => {
    const doc = fixture()
    const result = runCommand("selectFirstChild", input(doc, "b/b1"))
    expect(result.handled).toBe(true)
    expect(result.focus).toBeUndefined()
    expect(result.expand).toBeUndefined()
  })

  it("while zoomed, selectParent on a direct child hands up to the title", () => {
    const doc = fixture()
    const zoomed = (id: string): Parameters<typeof runCommand>[1] =>
      input(doc, id, { visibleOrder: ["b/b1"], zoomRootId: "b" })
    // The child's parent is the zoomed block — the view's title above the
    // rows, not a row: `exitTop`, as ↑ from the first row. Never a zoom.
    const result = runCommand("selectParent", zoomed("b/b1"))
    expect(result).toEqual({ handled: true, exitTop: true })
    expect(result.zoom).toBeUndefined()
    // Deeper, the parent walk is the ordinary one.
    const nested: BlockDoc = {
      ...doc,
      blocks: {
        ...doc.blocks,
        b1: { ...doc.blocks.b1, children: ["b2"] },
        b2: { id: "b2", type: "text", text: "B2", children: [] },
      },
    }
    const deeper = input(nested, "b/b1/b2", { visibleOrder: ["b/b1", "b/b1/b2"], zoomRootId: "b" })
    expect(runCommand("selectParent", deeper).focus).toEqual({ mode: "select", key: "b/b1" })
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
    expect(result.focus).toEqual({ mode: "select", key: "b/b1" })
    expect(result.expand).toBeUndefined()
  })

  it("→ consumes the key but does nothing on a leaf", () => {
    const doc = fixture()
    const result = runCommand("expandOrFirstChild", input(doc, "b/b1"))
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
    const result = runCommand("collapseOrParent", input(doc, "b/b1"))
    expect(result.focus).toEqual({ mode: "select", key: "b" })
    expect(result.collapse).toBeUndefined()
  })

  it("← on a collapsed (non-root) block steps out to the parent", () => {
    // b1 gains a child of its own and is collapsed (b1a hidden from the order).
    const doc = fixture()
    doc.blocks.b1 = { id: "b1", type: "text", text: "B1", children: ["b1a"] }
    doc.blocks.b1a = { id: "b1a", type: "text", text: "B1a", children: [] }
    const result = runCommand("collapseOrParent", input(doc, "b/b1"))
    expect(result.focus).toEqual({ mode: "select", key: "b" })
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

  it("while zoomed, ← on a direct child hands up to the title", () => {
    const doc = fixture()
    const zoomed = (id: string) => input(doc, id, { visibleOrder: ["b/b1"], zoomRootId: "b" })
    // A direct child's "parent" is the zoom root — the view's title above the
    // rows (`exitTop`), never a zoom out or an escape from the subtree.
    expect(runCommand("collapseOrParent", zoomed("b/b1"))).toEqual({
      handled: true,
      exitTop: true,
    })
  })

  it("while zoomed, → on the title steps into its first child (children always render)", () => {
    const doc = fixture()
    const result = runCommand(
      "expandOrFirstChild",
      input(doc, "b", { visibleOrder: ["b", "b/b1"], zoomRootId: "b" }),
    )
    expect(result.focus).toEqual({ mode: "select", key: "b/b1" })
    expect(result.expand).toBeUndefined()
  })
})

describe("moveBlock", () => {
  it("reorders a block among its siblings, keeping focus on it", () => {
    const doc = fixture()
    const result = runCommand("moveBlockDown", input(doc, "a", { mode: "select" }))
    expect(result.doc!.rootBlockIds).toEqual(["b", "a", "c"])
    expect(result.focus).toEqual({ mode: "select", key: "a" })
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
    expect(result.doc!.blocks[copyId].text).toBe("B")
    // The subtree came along, with a fresh id of its own.
    const childCopy = result.doc!.blocks[copyId].children[0]
    expect(childCopy).not.toBe("b1")
    expect(result.doc!.blocks[childCopy].text).toBe("B1")
    // The original is untouched.
    expect(result.doc!.blocks.b.children).toEqual(["b1"])
    expect(result.focus).toEqual({ mode: "select", key: copyId })
  })

  it("duplicateAbove inserts the copy before the original and selects it", () => {
    const doc = fixture()
    const result = runCommand("duplicateAbove", input(doc, "a", { mode: "select" }))
    const copyId = result.doc!.rootBlockIds[0]
    expect(result.doc!.rootBlockIds).toEqual([copyId, "a", "b", "c"])
    expect(result.doc!.blocks[copyId].text).toBe("A")
    expect(result.focus).toEqual({ mode: "select", key: copyId })
  })

  it("keeps editing the copy (caret preserved) in edit mode", () => {
    const doc = fixture()
    const result = runCommand(
      "duplicateBelow",
      input(doc, "a", { mode: "edit", caret: caret("A", 1) }),
    )
    const copyId = result.doc!.rootBlockIds[1]
    expect(result.focus).toEqual({ mode: "edit", key: copyId, caret: 1 })
  })
})

describe("deleteBlock", () => {
  it("highlights the block below — the one that slides into the deleted block's place", () => {
    const doc = fixture()
    const result = runCommand("deleteBlock", input(doc, "a"))
    expect(result.doc!.blocks.a).toBeUndefined()
    expect(result.doc!.rootBlockIds).toEqual(["b", "c"])
    expect(result.focus).toEqual({ mode: "select", key: "b" })
  })

  it("skips the deleted block's own subtree when looking below", () => {
    const doc = fixture()
    const result = runCommand("deleteBlock", input(doc, "b"))
    // b's subtree (b, b1) is gone; the first visible survivor below is c.
    expect(result.doc!.blocks.b).toBeUndefined()
    expect(result.doc!.blocks.b1).toBeUndefined()
    expect(result.focus).toEqual({ mode: "select", key: "c" })
  })

  it("falls back to the visible block above when the deleted block was last", () => {
    const doc = fixture()
    const result = runCommand("deleteBlock", input(doc, "c"))
    expect(result.doc!.blocks.c).toBeUndefined()
    expect(result.doc!.rootBlockIds).toEqual(["a", "b"])
    expect(result.focus).toEqual({ mode: "select", key: "b/b1" })
  })

  it("refuses to delete the only block", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["only"],
      blocks: { only: { id: "only", type: "text", text: "", children: [] } },
    }
    const result = runCommand("deleteBlock", input(doc, "only", { visibleOrder: ["only"] }))
    expect(result.handled).toBe(true)
    expect(result.doc).toBeUndefined()
  })

  it("deletes the only block of a doc that may be emptied (the basket)", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["only"],
      blocks: { only: { id: "only", type: "text", text: "last one", children: [] } },
    }
    const result = runCommand(
      "deleteBlock",
      input(doc, "only", { visibleOrder: ["only"], emptyable: true }),
    )
    expect(result.handled).toBe(true)
    expect(result.doc!.rootBlockIds).toEqual([])
    expect(result.doc!.blocks.only).toBeUndefined()
    expect(result.focus).toEqual({ mode: "select", key: null })
  })
})

describe("toggleTodo", () => {
  it("checks an unchecked todo", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["t"],
      blocks: { t: { id: "t", type: "todo", text: "task", children: [] } },
    }
    const result = runCommand("toggleTodo", input(doc, "t", { visibleOrder: ["t"] }))
    expect(result.doc!.blocks.t.type).toBe("done")
    expect(result.doc!.blocks.t.text).toBe("task")
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
  /** A one-block doc from a marked line (`# A`, `- A`…), typed as the parser
   * would type it — the fixtures read as the markdown they stand for. */
  function docOf(content: string): BlockDoc {
    const { type, text } = parseLine(content)
    return {
      props: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", type, text, children: [] } },
    }
  }
  const turn = (name: Parameters<typeof runCommand>[0], content: string) =>
    runCommand(name, input(docOf(content), "x", { visibleOrder: ["x"] }))

  it("toggles each type on from a paragraph, and back off to a paragraph", () => {
    const cases: [Parameters<typeof runCommand>[0], string, BlockType][] = [
      ["turnIntoHeading", "# A", "h1"],
      ["turnIntoBullet", "- A", "ul"],
      ["turnIntoTodo", "[ ] A", "todo"],
      ["turnIntoQuote", "> A", "quote"],
      ["turnIntoOrdered", "1. A", "ol"],
    ]
    for (const [name, marked, type] of cases) {
      const on = turn(name, "A").doc!.blocks.x
      expect([on.type, on.text]).toEqual([type, "A"])
      const off = turn(name, marked).doc!.blocks.x
      expect([off.type, off.text]).toEqual(["text", "A"])
    }
  })

  it("swaps the marker when the block is another type, body byte-exact", () => {
    expect(turn("turnIntoHeading", "- hello  world").doc!.blocks.x.type).toBe("h1")
    expect(turn("turnIntoHeading", "- hello  world").doc!.blocks.x.text).toBe("hello  world")
    expect(turn("turnIntoTodo", "# hello  world").doc!.blocks.x.type).toBe("todo")
    expect(turn("turnIntoTodo", "# hello  world").doc!.blocks.x.text).toBe("hello  world")
    expect(turn("turnIntoBullet", "3) counted").doc!.blocks.x.type).toBe("ul")
    expect(turn("turnIntoBullet", "3) counted").doc!.blocks.x.text).toBe("counted")
  })

  it("a checked todo is still a todo: [ strips it, x keeps toggling the check", () => {
    expect(turn("turnIntoTodo", "[x] done").doc!.blocks.x.type).toBe("text")
    expect(turn("turnIntoTodo", "[x] done").doc!.blocks.x.text).toBe("done")
    expect(turn("toggleTodo", "[x] done").doc!.blocks.x.type).toBe("todo")
    expect(turn("toggleTodo", "[x] done").doc!.blocks.x.text).toBe("done")
  })

  it("ordered toggles off from any number", () => {
    expect(turn("turnIntoOrdered", "7. seventh").doc!.blocks.x.text).toBe("seventh")
  })

  it("stays selected on a block with content, as one structural undo step", () => {
    const result = turn("turnIntoHeading", "A")
    expect(result.focus).toEqual({ mode: "select", key: "x" })
    expect(result.op).toEqual({ type: "structural" })
  })

  it("an empty block applies the marker AND opens editing", () => {
    const result = turn("turnIntoBullet", "")
    expect(result.doc!.blocks.x.type).toBe("ul")
    expect(result.doc!.blocks.x.text).toBe("")
    expect(result.focus).toEqual({ mode: "edit", key: "x" })
    // Swapping one empty marker for another stays in edit too.
    const swapped = turn("turnIntoTodo", "- ")
    expect(swapped.doc!.blocks.x.type).toBe("todo")
    expect(swapped.doc!.blocks.x.text).toBe("")
    expect(swapped.focus).toEqual({ mode: "edit", key: "x" })
  })

  it("never touches children (marker swap only)", () => {
    const doc = fixture() // b "B" has child b1
    const result = runCommand("turnIntoQuote", input(doc, "b"))
    expect(result.doc!.blocks.b.type).toBe("quote")
    expect(result.doc!.blocks.b.text).toBe("B")
    expect(result.doc!.blocks.b.children).toEqual(["b1"])
    expect(result.doc!.blocks.b1.text).toBe("B1")
  })

  it("works on the zoomed title (a content-type change stays in view)", () => {
    const doc = fixture()
    const result = runCommand(
      "turnIntoHeading",
      input(doc, "b", { visibleOrder: ["b", "b/b1"], zoomRootId: "b" }),
    )
    expect(result.doc!.blocks.b.type).toBe("h1")
    expect(result.doc!.blocks.b.text).toBe("B")
  })
})

describe("openFence", () => {
  it("makes an empty code block of the typed language, editing at its start", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", type: "ul", text: "```ts", children: [] } },
    }
    const result = runCommand(
      "openFence",
      input(doc, "x", { mode: "edit", visibleOrder: ["x"], caret: caret("```ts", 5) }),
    )
    expect(result.doc!.blocks.x).toEqual({
      id: "x",
      type: "code",
      text: "",
      props: { language: "ts" },
      children: [],
    })
    expect(result.focus).toEqual({ mode: "edit", key: "x", atStart: true })
    expect(result.op).toEqual({ type: "structural" })
    // No language: no props.
    const bare = runCommand(
      "openFence",
      input(doc, "x", { mode: "edit", visibleOrder: ["x"], caret: caret("```", 3) }),
    )
    expect(bare.doc!.blocks.x.props).toBeUndefined()
  })
})

describe("insertBelow", () => {
  it("adds an unordered-list continuation block by default", () => {
    const doc = fixture()
    const result = runCommand("insertBelow", input(doc, "a", { mode: "edit" }))
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks[id].type).toBe("ul")
    expect(result.doc!.blocks[id].text).toBe("")
    expect(result.doc!.rootBlockIds).toEqual(["a", id, "b", "c"])
    expect(result.focus).toEqual({ mode: "edit", key: id })
  })

  it("nests the new block under a heading", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["h"],
      blocks: { h: { id: "h", type: "h1", text: "Title", children: [] } },
    }
    const result = runCommand("insertBelow", input(doc, "h", { mode: "edit", visibleOrder: ["h"] }))
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.rootBlockIds).toEqual(["h"])
    expect(result.doc!.blocks.h.children).toEqual([id])
    expect(result.doc!.blocks[id].type).toBe("ul")
    expect(result.doc!.blocks[id].text).toBe("")
  })

  it("uses the configured new-block type instead of the default", () => {
    const doc = fixture()
    for (const type of ["text", "todo", "quote"] as const) {
      const result = runCommand(
        "insertBelow",
        input(doc, "a", { mode: "edit", newBlockType: type }),
      )
      const id = newBlockId(doc, result.doc!)
      expect(result.doc!.blocks[id].type).toBe(type)
      expect(result.doc!.blocks[id].text).toBe("")
    }
  })

  it("still continues bullet, todo and numbered lists whatever the configured marker", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["b", "t", "n"],
      blocks: {
        b: { id: "b", type: "ul", text: "point", children: [] },
        t: { id: "t", type: "todo", text: "task", children: [] },
        n: { id: "n", type: "ol", text: "second", children: [] },
      },
    }
    const over = {
      mode: "edit" as const,
      visibleOrder: ["b", "t", "n"],
      newBlockType: "text" as const,
    }
    const bullet = runCommand("insertBelow", input(doc, "b", over))
    expect(bullet.doc!.blocks[newBlockId(doc, bullet.doc!)].type).toBe("ul")
    expect(bullet.doc!.blocks[newBlockId(doc, bullet.doc!)].text).toBe("")
    const todo = runCommand("insertBelow", input(doc, "t", over))
    expect(todo.doc!.blocks[newBlockId(doc, todo.doc!)].type).toBe("todo")
    expect(todo.doc!.blocks[newBlockId(doc, todo.doc!)].text).toBe("")
    const ordered = runCommand("insertBelow", input(doc, "n", over))
    expect(ordered.doc!.blocks[newBlockId(doc, ordered.doc!)].type).toBe("ol")
    expect(ordered.doc!.blocks[newBlockId(doc, ordered.doc!)].text).toBe("")
  })
})

describe("insertSiblingBelow", () => {
  it("keeps the block's own type (heading stays a heading, sibling not nested)", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["h"],
      blocks: { h: { id: "h", type: "h1", text: "Title", children: [] } },
    }
    const result = runCommand("insertSiblingBelow", input(doc, "h", { visibleOrder: ["h"] }))
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.rootBlockIds).toEqual(["h", id])
    expect(result.doc!.blocks[id].type).toBe("h1")
    expect(result.doc!.blocks[id].text).toBe("")
  })

  it("keeps a todo a todo", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["t"],
      blocks: { t: { id: "t", type: "done", text: "done", children: [] } },
    }
    const result = runCommand("insertSiblingBelow", input(doc, "t", { visibleOrder: ["t"] }))
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks[id].type).toBe("todo")
    expect(result.doc!.blocks[id].text).toBe("")
  })
})

describe("split", () => {
  it("splits a list item at the caret, continuing the marker", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", type: "ul", text: "hello", children: [] } },
    }
    const result = runCommand(
      "splitContinuingList",
      input(doc, "x", { mode: "edit", visibleOrder: ["x"], caret: caret("hello", 2) }),
    )
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks.x.type).toBe("ul")
    expect(result.doc!.blocks.x.text).toBe("he")
    expect(result.doc!.blocks[id].type).toBe("ul")
    expect(result.doc!.blocks[id].text).toBe("llo")
    expect(result.focus).toEqual({ mode: "edit", key: id, atStart: true })
  })

  it("splits a paragraph at the caret using the configured new-block marker", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", type: "text", text: "hello", children: [] } },
    }
    const result = runCommand(
      "splitContinuingList",
      input(doc, "x", {
        mode: "edit",
        visibleOrder: ["x"],
        caret: caret("hello", 2),
        newBlockType: "quote",
      }),
    )
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks.x.text).toBe("he")
    expect(result.doc!.blocks[id].type).toBe("quote")
    expect(result.doc!.blocks[id].text).toBe("llo")
  })

  it("shift-enter splits carrying the same block type", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", type: "ul", text: "hello", children: [] } },
    }
    const result = runCommand(
      "splitPlain",
      input(doc, "x", { mode: "edit", visibleOrder: ["x"], caret: caret("hello", 2) }),
    )
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks.x.type).toBe("ul")
    expect(result.doc!.blocks.x.text).toBe("he")
    expect(result.doc!.blocks[id].type).toBe("ul")
    expect(result.doc!.blocks[id].text).toBe("llo")
  })

  it("shift-enter on a heading makes another heading", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", type: "h1", text: "Title", children: [] } },
    }
    const result = runCommand(
      "splitPlain",
      input(doc, "x", { mode: "edit", visibleOrder: ["x"], caret: caret("Title", 5) }),
    )
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks[id].type).toBe("h1")
    expect(result.doc!.blocks[id].text).toBe("")
  })
})

describe("marker editing", () => {
  it("exitList clears an empty list item to a paragraph when the default is that list", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", type: "ul", text: "", children: [] } },
    }
    // The default new-block type is a bullet: leaving the list must not keep it one.
    const result = runCommand("exitList", input(doc, "x", { mode: "edit", visibleOrder: ["x"] }))
    expect(result.doc!.blocks.x.type).toBe("text")
    expect(result.doc!.blocks.x.text).toBe("")
    const explicit = runCommand(
      "exitList",
      input(doc, "x", { mode: "edit", visibleOrder: ["x"], newBlockType: "ul" }),
    )
    expect(explicit.doc!.blocks.x.type).toBe("text")
  })

  it("exitList leaves an empty list item as the configured new-block type", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["x", "y"],
      blocks: {
        x: { id: "x", type: "ul", text: " ", children: [] },
        y: { id: "y", type: "ol", text: "", children: [] },
      },
    }
    const plain = runCommand(
      "exitList",
      input(doc, "x", { mode: "edit", visibleOrder: ["x", "y"], newBlockType: "text" }),
    )
    expect(plain.doc!.blocks.x.type).toBe("text")
    expect(plain.doc!.blocks.x.text).toBe("")
    const todo = runCommand(
      "exitList",
      input(doc, "x", { mode: "edit", visibleOrder: ["x", "y"], newBlockType: "todo" }),
    )
    expect(todo.doc!.blocks.x.type).toBe("todo")
    // A numbered item leaves for the default bullet.
    const numbered = runCommand(
      "exitList",
      input(doc, "y", { mode: "edit", visibleOrder: ["x", "y"], newBlockType: "ul" }),
    )
    expect(numbered.doc!.blocks.y.type).toBe("ul")
  })

  it("stripMarker removes the leading marker", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["x"],
      blocks: { x: { id: "x", type: "h1", text: "Heading", children: [] } },
    }
    const result = runCommand("stripMarker", input(doc, "x", { mode: "edit", visibleOrder: ["x"] }))
    expect(result.doc!.blocks.x.type).toBe("text")
    expect(result.doc!.blocks.x.text).toBe("Heading")
    expect(result.focus).toEqual({ mode: "edit", key: "x", atStart: true })
  })

  it("backspaceEmpty keeps the only block, unless the doc may be emptied", () => {
    const doc: BlockDoc = {
      props: null,
      rootBlockIds: ["only"],
      blocks: { only: { id: "only", type: "text", text: "", children: [] } },
    }
    const kept = runCommand("backspaceEmpty", input(doc, "only", { mode: "edit" }))
    expect(kept.handled).toBe(true)
    expect(kept.doc).toBeUndefined()
    const emptied = runCommand(
      "backspaceEmpty",
      input(doc, "only", { mode: "edit", emptyable: true }),
    )
    expect(emptied.doc!.rootBlockIds).toEqual([])
    expect(emptied.focus).toEqual({ mode: "select", key: null })
  })

  it("backspaceEmpty removes an empty block and edits the previous one", () => {
    const doc = fixture()
    const result = runCommand("backspaceEmpty", input(doc, "c", { mode: "edit" }))
    expect(result.doc!.blocks.c).toBeUndefined()
    // removeBlock hands focus to the previous *sibling* (b), not b1.
    expect(result.focus).toEqual({ mode: "edit", key: "b" })
  })
})

describe("zoom", () => {
  /** Command input as seen while zoomed into `b`: its children are the rows
   * (b1); b itself is the view's title above them, not a row. */
  function zoomed(doc: BlockDoc, key: string, over: Partial<CommandInput> = {}): CommandInput {
    return { doc, key, mode: "select", visibleOrder: ["b/b1"], zoomRootId: "b", ...over }
  }

  it("zoomIn requests a zoom into the block", () => {
    const doc = fixture()
    expect(runCommand("zoomIn", input(doc, "b")).zoom).toEqual({ id: "b" })
  })

  it("zoomOut pops the navigation stack, and exits when nothing is below", () => {
    const doc = fixture()
    // The stack (zoomBackId) says where "one level out" goes — the path the
    // user took, not the tree ancestry.
    expect(
      runCommand(
        "zoomOut",
        input(doc, "b/b1", { visibleOrder: ["b/b1"], zoomRootId: "b1", zoomBackId: "b" }),
      ).zoom,
    ).toEqual({ id: "b" })
    // No stack below (deep link): out exits fully.
    expect(runCommand("zoomOut", zoomed(doc, "b/b1")).zoom).toEqual({ id: null })
  })

  it("zoomOut / zoomExit are ignored when not zoomed", () => {
    const doc = fixture()
    expect(runCommand("zoomOut", input(doc, "b")).handled).toBe(false)
    expect(runCommand("zoomExit", input(doc, "b")).handled).toBe(false)
  })

  it("zoomExit requests a full exit", () => {
    const doc = fixture()
    expect(runCommand("zoomExit", zoomed(doc, "b/b1")).zoom).toEqual({ id: null })
  })

  it("outdent refuses at the zoom boundary (the root's direct children)", () => {
    const doc = fixture()
    const result = runCommand("outdent", zoomed(doc, "b/b1"))
    expect(result.handled).toBe(true)
    expect(result.doc).toBeUndefined()
    // The same block outdents fine when not zoomed.
    expect(runCommand("outdent", input(doc, "b/b1")).doc).toBeDefined()
  })

  it("deleting the last child empties the view and hands up to the title", () => {
    const doc = fixture()
    // The zoomed block alone is a valid view — Enter on its title makes a child.
    const result = runCommand("deleteBlock", zoomed(doc, "b/b1"))
    expect(result.doc!.blocks.b1).toBeUndefined()
    expect(result.focus).toBeUndefined()
    expect(result.exitTop).toBe(true)
    // Backspace in the emptied last child merges upward the same way — to
    // the title, never to a row outside the view.
    const empty = { ...doc, blocks: { ...doc.blocks, b1: { ...doc.blocks.b1, text: "" } } }
    const merged = runCommand("backspaceEmpty", zoomed(empty, "b/b1", { mode: "edit" }))
    expect(merged.doc!.blocks.b1).toBeUndefined()
    expect(merged.exitTop).toBe(true)
  })

  it("level and sibling jumps clamp at the zoomed subtree", () => {
    const doc = fixture()
    for (const name of ["jumpLevelBottom", "prevSibling", "nextSibling"] as const) {
      const result = runCommand(name, zoomed(doc, "b/b1"))
      expect(result.handled).toBe(true)
      expect(result.focus).toBeUndefined()
      expect(result.exitTop).toBeUndefined()
    }
    // The top of the first level is the title above the rows.
    expect(runCommand("jumpLevelTop", zoomed(doc, "b/b1"))).toEqual({
      handled: true,
      exitTop: true,
    })
  })

  it("upward exits at the top of the zoomed view hand up to the title", () => {
    const doc = fixture()
    // ↑ from the first row, highlighted or editing: the editor takes
    // `exitTop` to the zoom title, as it would to the note title.
    expect(runCommand("moveSelectionUp", zoomed(doc, "b/b1"))).toEqual({
      handled: true,
      exitTop: true,
    })
    expect(runCommand("moveEditFocusUp", zoomed(doc, "b/b1", { mode: "edit" }))).toEqual({
      handled: true,
      exitTop: true,
    })
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
    expect(result.focus).toEqual({ mode: to, key: "a" })
  })

  it("deselect clears the highlight entirely", () => {
    const result = runCommand("deselect", input(doc, "a"))
    expect(result.handled).toBe(true)
    expect(result.focus).toEqual({ mode: "select", key: null })
  })
})

describe("rows of a shared block", () => {
  /** `s` hangs under both `p` and `q`: one block, two rows. */
  function shared(): BlockDoc {
    return {
      props: null,
      rootBlockIds: ["p", "q"],
      blocks: {
        p: { id: "p", type: "ul", text: "p", children: ["s"] },
        q: { id: "q", type: "ul", text: "q", children: ["s", "r"] },
        s: { id: "s", type: "ul", text: "shared", children: [] },
        r: { id: "r", type: "ul", text: "r", children: [] },
      },
    }
  }
  const order = ["p", "p/s", "q", "q/s", "q/r"]

  it("navigates from the row asked for: the parent is read off the key", () => {
    const doc = shared()
    expect(runCommand("selectParent", input(doc, "q/s", { visibleOrder: order })).focus).toEqual({
      mode: "select",
      key: "q",
    })
    expect(runCommand("nextSibling", input(doc, "q/s", { visibleOrder: order })).focus).toEqual({
      mode: "select",
      key: "q/r",
    })
    // Under p the block has no next sibling.
    expect(
      runCommand("nextSibling", input(doc, "p/s", { visibleOrder: order })).focus,
    ).toBeUndefined()
  })

  it("deletes one row and keeps the block in the other", () => {
    const doc = shared()
    const result = runCommand("deleteBlock", input(doc, "q/s", { visibleOrder: order }))
    expect(result.doc!.blocks.q.children).toEqual(["r"])
    expect(result.doc!.blocks.p.children).toEqual(["s"])
    expect(result.doc!.blocks.s).toBeDefined()
    expect(result.focus).toEqual({ mode: "select", key: "q/r" })
  })

  it("moves one row, leaving the other where it was", () => {
    const doc = shared()
    const result = runCommand("moveBlockDown", input(doc, "q/s", { visibleOrder: order }))
    expect(result.doc!.blocks.q.children).toEqual(["r", "s"])
    expect(result.doc!.blocks.p.children).toEqual(["s"])
    expect(result.focus).toEqual({ mode: "select", key: "q/s" })
  })

  it("inserts beside the row, and the new block's key is under that parent", () => {
    const doc = shared()
    const result = runCommand("insertSiblingBelow", input(doc, "q/s", { visibleOrder: order }))
    const id = newBlockId(doc, result.doc!)
    expect(result.doc!.blocks.q.children).toEqual(["s", id, "r"])
    expect(result.doc!.blocks.p.children).toEqual(["s"])
    expect(result.focus).toEqual({ mode: "edit", key: `q/${id}` })
  })

  it("a type change is the block's: it shows in both rows", () => {
    const doc = shared()
    const result = runCommand("turnIntoHeading", input(doc, "p/s", { visibleOrder: order }))
    expect(result.doc!.blocks.s.type).toBe("h1")
    expect(result.focus).toEqual({ mode: "select", key: "p/s" })
  })
})

describe("wrapBold / wrapItalic / wrapCode", () => {
  it("wraps the selection and puts the caret after it", () => {
    expect(wrapSelection("Alpha beta", 0, 5, "**")).toEqual({
      text: "**Alpha** beta",
      start: 2,
      end: 7,
    })
  })

  it("takes the marker off a selection that already has it, inside or outside", () => {
    expect(wrapSelection("**Alpha** beta", 0, 9, "**")).toEqual({
      text: "Alpha beta",
      start: 0,
      end: 5,
    })
    expect(wrapSelection("**Alpha** beta", 2, 7, "**")).toEqual({
      text: "Alpha beta",
      start: 0,
      end: 5,
    })
  })

  it("with nothing selected, puts the pair in and the caret between", () => {
    expect(wrapSelection("Alpha", 5, 5, "`")).toEqual({ text: "Alpha``", start: 6, end: 6 })
  })

  it("edits the block's text as a text op, keeping the row editing", () => {
    const doc = fixture()
    const result = runCommand(
      "wrapItalic",
      input(doc, "a", { mode: "edit", caret: caret("Alpha", 0, 2) }),
    )
    expect(result.handled).toBe(true)
    expect(result.doc!.blocks.a.text).toBe("_Al_pha")
    expect(result.op).toEqual({ type: "text", blockId: "a" })
    expect(result.focus).toEqual({ mode: "edit", key: "a", caret: 3 })
  })

  it("does nothing in select mode", () => {
    expect(runCommand("wrapBold", input(fixture(), "a")).handled).toBe(false)
  })
})

describe("wrapStrike / wrapMath / wrapLink", () => {
  it("strike and maths wrap as the others do", () => {
    const doc = fixture()
    const strike = runCommand(
      "wrapStrike",
      input(doc, "a", { mode: "edit", caret: caret("Alpha", 0, 5) }),
    )
    expect(strike.doc!.blocks.a.text).toBe("~~Alpha~~")
    const math = runCommand("wrapMath", input(doc, "a", { mode: "edit", caret: caret("x", 0, 1) }))
    expect(math.doc!.blocks.a.text).toBe("$$x$$")
    expect(math.focus).toEqual({ mode: "edit", key: "a", caret: 3 })
  })

  it("links the selection with the caret in the parentheses, for the address", () => {
    expect(linkSelection("see Alpha now", 4, 9)).toEqual({ text: "see [Alpha]() now", caret: 12 })
  })

  it("links an address with the caret in the brackets, for its name", () => {
    expect(linkSelection("https://example.com", 0, 19)).toEqual({
      text: "[](https://example.com)",
      caret: 1,
    })
  })

  it("with nothing selected, puts the empty shape in with the caret in the brackets", () => {
    expect(linkSelection("Alpha", 5, 5)).toEqual({ text: "Alpha[]()", caret: 8 })
  })

  it("wrapLink is a text op on the block, editing on", () => {
    const result = runCommand(
      "wrapLink",
      input(fixture(), "a", { mode: "edit", caret: caret("Alpha", 0, 5) }),
    )
    expect(result.doc!.blocks.a.text).toBe("[Alpha]()")
    expect(result.op).toEqual({ type: "text", blockId: "a" })
    expect(result.focus).toEqual({ mode: "edit", key: "a", caret: 8 })
    expect(runCommand("wrapLink", input(fixture(), "a")).handled).toBe(false)
  })
})

describe("parent rows (upstream occurrences)", () => {
  /** r holds x; r is held by p and q, shown beneath it. The note n is the root. */
  function graphed(): BlockDoc {
    return {
      props: null,
      rootBlockIds: ["r"],
      upstream: [],
      blocks: {
        r: { id: "r", type: "text", text: "R", children: ["x"], upstream: ["p", "q"] },
        x: { id: "x", type: "text", text: "X", children: [], upstream: ["r"] },
        p: { id: "p", type: "text", text: "P", children: ["r"], upstream: ["n"] },
        q: { id: "q", type: "text", text: "Q", children: ["r"], upstream: [] },
      },
    }
  }
  const order = ["r", "r/x", "r/^p", "r/^q"]

  it("navigates among parent rows as siblings, with their own keys", () => {
    const doc = graphed()
    expect(
      runCommand("nextSibling", input(doc, "r/^p", { visibleOrder: order, rootId: "n" })).focus,
    ).toEqual({ mode: "select", key: "r/^q" })
    expect(
      runCommand("prevSibling", input(doc, "r/^q", { visibleOrder: order, rootId: "n" })).focus,
    ).toEqual({ mode: "select", key: "r/^p" })
    // A child row and a parent row are not siblings of each other.
    expect(
      runCommand("nextSibling", input(doc, "r/x", { visibleOrder: order, rootId: "n" })).focus,
    ).toBeUndefined()
  })

  it("folds count the parents beneath a row, with the root never among them", () => {
    const doc = graphed()
    // r has a child and two parents beneath it; x has none (its only parent
    // is r, on the path); p's only parent is the note, on the path.
    expect(runCommand("toggleCollapse", input(doc, "r", { rootId: "n" })).toggleCollapse).toBe("r")
    expect(
      runCommand("toggleCollapse", input(doc, "r/x", { rootId: "n" })).toggleCollapse,
    ).toBeUndefined()
    expect(
      runCommand("toggleCollapse", input(doc, "r/^p", { rootId: "n" })).toggleCollapse,
    ).toBeUndefined()
    // Without the root named, the note would count as a row beneath p.
    expect(runCommand("toggleCollapse", input(doc, "r/^p")).toggleCollapse).toBe("r/^p")
    // → on r steps into its first row beneath: the child before the parents.
    expect(
      runCommand("expandOrFirstChild", input(doc, "r", { visibleOrder: order, rootId: "n" })).focus,
    ).toEqual({ mode: "select", key: "r/x" })
  })

  it("Enter after a parent row makes a new parent; indent moves which block it holds", () => {
    const doc = graphed()
    const entered = runCommand("insertSiblingBelow", input(doc, "r/^p", { rootId: "n" }))
    const fresh = newBlockId(doc, entered.doc!)
    expect(entered.doc!.blocks.r.upstream).toEqual(["p", fresh, "q"])
    expect(entered.doc!.blocks[fresh].children).toEqual(["r"])
    expect(entered.focus).toEqual({ mode: "edit", key: `r/^${fresh}` })

    const indented = runCommand("indent", input(doc, "r/^q", { rootId: "n" }))
    expect(indented.focus).toEqual({ mode: "select", key: "r/^p/^q" })
    expect(indented.doc!.blocks.q.children).toEqual(["p"])
  })

  it("deleting a parent row removes it from beneath the block and lands on the row above", () => {
    const doc = graphed()
    const result = runCommand(
      "deleteBlock",
      input(doc, "r/^q", { visibleOrder: order, rootId: "n" }),
    )
    expect(result.doc!.blocks.r.upstream).toEqual(["p"])
    expect(result.focus).toEqual({ mode: "select", key: "r/^p" })
  })
})
