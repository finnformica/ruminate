import { describe, expect, it } from "vitest"
import { COMMANDS, type CaretInput, type CommandInput, type Mode } from "./commands"
import { comboFromEvent, KEYMAP, resolveKey, type KeyLike } from "./keymap"
import { parseLine } from "./parse"
import type { BlockDoc } from "./types"

function key(over: Partial<KeyLike> & { key: string }): KeyLike {
  return { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...over }
}

/** A one-block doc from a marked line, typed as the parser would type it. */
function docWith(content: string): BlockDoc {
  const { type, text } = parseLine(content)
  return {
    props: null,
    rootBlockIds: ["x"],
    blocks: { x: { id: "x", type, text, children: [] } },
  }
}

function input(content: string, mode: Mode, caret?: CaretInput): CommandInput {
  return { doc: docWith(content), key: "x", mode, visibleOrder: ["x"], caret }
}

function caret(value: string, start: number, end = start, lines = {}): CaretInput {
  return { value, start, end, atFirstLine: false, atLastLine: false, ...lines }
}

describe("keymap integrity", () => {
  it("binds only commands that exist", () => {
    for (const binding of KEYMAP) {
      expect(COMMANDS[binding.command], `unknown command ${binding.command}`).toBeTypeOf("function")
    }
  })
})

describe("comboFromEvent", () => {
  it("names plain keys, shift, and mod in a fixed order", () => {
    expect(comboFromEvent(key({ key: "Enter" }))).toBe("Enter")
    expect(comboFromEvent(key({ key: "Tab", shiftKey: true }))).toBe("Shift+Tab")
    expect(comboFromEvent(key({ key: "z", metaKey: true }))).toBe("Mod+z")
    expect(comboFromEvent(key({ key: "z", ctrlKey: true }))).toBe("Mod+z")
    expect(comboFromEvent(key({ key: " " }))).toBe(" ")
  })
})

describe("select mode", () => {
  const cases: [Partial<KeyLike> & { key: string }, string][] = [
    [{ key: "Enter" }, "enterEdit"],
    [{ key: "Tab" }, "indent"],
    [{ key: "Tab", shiftKey: true }, "outdent"],
    [{ key: "ArrowUp" }, "moveSelectionUp"],
    [{ key: "ArrowDown" }, "moveSelectionDown"],
    // ←/→ fold like a tree view (expand/step-in, collapse/step-out).
    [{ key: "ArrowRight" }, "expandOrFirstChild"],
    [{ key: "ArrowLeft" }, "collapseOrParent"],
    [{ key: "Escape" }, "deselect"],
    [{ key: "ArrowUp", altKey: true }, "moveBlockUp"],
    [{ key: "ArrowDown", altKey: true }, "moveBlockDown"],
    [{ key: "ArrowUp", metaKey: true, altKey: true }, "prevSibling"],
    [{ key: "ArrowDown", metaKey: true, altKey: true }, "nextSibling"],
    [{ key: "ArrowUp", metaKey: true }, "jumpLevelTop"],
    [{ key: "ArrowDown", metaKey: true }, "jumpLevelBottom"],
    [{ key: "ArrowUp", metaKey: true, shiftKey: true }, "moveBlockUp"],
    [{ key: "ArrowDown", metaKey: true, shiftKey: true }, "moveBlockDown"],
    [{ key: "ArrowUp", altKey: true, shiftKey: true }, "duplicateAbove"],
    [{ key: "ArrowDown", altKey: true, shiftKey: true }, "duplicateBelow"],
    [{ key: "Backspace" }, "deleteBlock"],
    [{ key: "Delete" }, "deleteBlock"],
    [{ key: "x" }, "toggleTodo"],
    [{ key: " " }, "toggleCollapse"],
    // WASD tree navigation: w/s traverse siblings (breaking out at the ends),
    // a/d walk up/down the tree.
    [{ key: "w" }, "treePrev"],
    [{ key: "s" }, "treeNext"],
    [{ key: "a" }, "selectParent"],
    [{ key: "d" }, "selectFirstChild"],
    // "Turn into": marker keys toggle the block's type. # and > need Shift on
    // many layouts, so the shifted spellings resolve too.
    [{ key: "#" }, "turnIntoHeading"],
    [{ key: "#", shiftKey: true }, "turnIntoHeading"],
    [{ key: "-" }, "turnIntoBullet"],
    [{ key: "[" }, "turnIntoTodo"],
    [{ key: ">" }, "turnIntoQuote"],
    [{ key: ">", shiftKey: true }, "turnIntoQuote"],
    [{ key: "1" }, "turnIntoOrdered"],
    [{ key: "f" }, "zoomIn"],
    [{ key: "F", shiftKey: true }, "zoomOut"],
    [{ key: ".", metaKey: true }, "zoomIn"],
    [{ key: ".", metaKey: true, shiftKey: true }, "zoomExit"],
    // With Shift held, some layouts report the shifted character.
    [{ key: ">", metaKey: true, shiftKey: true }, "zoomExit"],
  ]
  it.each(cases)("%o → %s", (evt, command) => {
    expect(resolveKey("select", key(evt), input("A", "select"))).toBe(command)
  })

  it("leaves unmapped keys alone", () => {
    expect(resolveKey("select", key({ key: "q" }), input("A", "select"))).toBeNull()
  })

  it("never swallows modified w/a/s/d (⌘W must stay the browser's close-tab)", () => {
    const inp = input("A", "select")
    expect(resolveKey("select", key({ key: "w", metaKey: true }), inp)).toBeNull()
    expect(resolveKey("select", key({ key: "w", ctrlKey: true }), inp)).toBeNull()
    expect(resolveKey("select", key({ key: "d", altKey: true }), inp)).toBeNull()
    expect(resolveKey("select", key({ key: "s", metaKey: true }), inp)).toBeNull()
    // Mod+a is the (imperative) selection ladder, never the keymap's bare `a`.
    expect(resolveKey("select", key({ key: "a", metaKey: true }), inp)).toBeNull()
  })

  it("never swallows modified ←/→ (Shift/Mod/Alt arrows keep their own meanings)", () => {
    const inp = input("A", "select")
    for (const arrow of ["ArrowLeft", "ArrowRight"]) {
      expect(resolveKey("select", key({ key: arrow, shiftKey: true }), inp)).toBeNull()
      expect(resolveKey("select", key({ key: arrow, metaKey: true }), inp)).toBeNull()
      expect(resolveKey("select", key({ key: arrow, ctrlKey: true }), inp)).toBeNull()
      expect(resolveKey("select", key({ key: arrow, altKey: true }), inp)).toBeNull()
    }
  })

  it("never swallows Mod-modified marker keys (⌘- stays the browser's zoom-out)", () => {
    const inp = input("A", "select")
    expect(resolveKey("select", key({ key: "-", metaKey: true }), inp)).toBeNull()
    expect(resolveKey("select", key({ key: "1", metaKey: true }), inp)).toBeNull()
    expect(resolveKey("select", key({ key: "[", metaKey: true }), inp)).toBeNull()
  })

  it("accepts Alt-modified marker symbols (non-US Macs type them with Option)", () => {
    // UK Mac: # is Alt+3, so the event carries altKey with key "#".
    const inp = input("A", "select")
    expect(resolveKey("select", key({ key: "#", altKey: true }), inp)).toBe("turnIntoHeading")
    expect(resolveKey("select", key({ key: "#", altKey: true, shiftKey: true }), inp)).toBe(
      "turnIntoHeading",
    )
    expect(resolveKey("select", key({ key: "[", altKey: true }), inp)).toBe("turnIntoTodo")
  })
})

describe("edit mode modifier arrows", () => {
  const cases: [Partial<KeyLike> & { key: string }, string][] = [
    [{ key: "ArrowUp", altKey: true }, "moveBlockUp"],
    [{ key: "ArrowDown", altKey: true }, "moveBlockDown"],
    [{ key: "ArrowUp", metaKey: true, altKey: true }, "prevSibling"],
    [{ key: "ArrowDown", metaKey: true, altKey: true }, "nextSibling"],
    [{ key: "ArrowUp", metaKey: true, shiftKey: true }, "moveBlockUp"],
    [{ key: "ArrowDown", metaKey: true, shiftKey: true }, "moveBlockDown"],
    [{ key: "ArrowUp", altKey: true, shiftKey: true }, "duplicateAbove"],
    [{ key: "ArrowDown", altKey: true, shiftKey: true }, "duplicateBelow"],
    // The zoom family aliases work while typing (single-key f stays typeable).
    [{ key: ".", metaKey: true }, "zoomIn"],
    [{ key: ".", metaKey: true, shiftKey: true }, "zoomExit"],
    [{ key: ">", metaKey: true, shiftKey: true }, "zoomExit"],
  ]
  it.each(cases)("%o → %s", (evt, command) => {
    expect(resolveKey("edit", key(evt), input("A", "edit", caret("A", 0)))).toBe(command)
  })

  it("leaves plain f alone in edit mode (it's just typing)", () => {
    expect(resolveKey("edit", key({ key: "f" }), input("A", "edit", caret("A", 0)))).toBeNull()
  })

  it("leaves plain w/a/s/d and marker keys alone in edit mode (they're just typing)", () => {
    for (const letter of ["w", "a", "s", "d", "#", "-", "[", ">", "1"]) {
      expect(resolveKey("edit", key({ key: letter }), input("A", "edit", caret("A", 0)))).toBeNull()
    }
  })

  it("leaves ←/→ alone in edit mode (they stay native caret keys)", () => {
    for (const arrow of ["ArrowLeft", "ArrowRight"]) {
      expect(resolveKey("edit", key({ key: arrow }), input("A", "edit", caret("A", 0)))).toBeNull()
      expect(
        resolveKey("edit", key({ key: arrow, shiftKey: true }), input("A", "edit", caret("A", 0))),
      ).toBeNull()
    }
  })
})

describe("edit mode Enter chain (caret-dependent)", () => {
  it("exits the list on an empty list item", () => {
    const evt = key({ key: "Enter" })
    expect(resolveKey("edit", evt, input("- ", "edit", caret("", 0)))).toBe("exitList")
  })

  it("appends a fresh block when the caret is at the end", () => {
    const evt = key({ key: "Enter" })
    expect(resolveKey("edit", evt, input("- hi", "edit", caret("hi", 2)))).toBe("insertBelow")
  })

  it("splits mid-line otherwise", () => {
    const evt = key({ key: "Enter" })
    expect(resolveKey("edit", evt, input("- hello", "edit", caret("hello", 2)))).toBe(
      "splitContinuingList",
    )
  })

  it("shift-enter is always a plain split", () => {
    const evt = key({ key: "Enter", shiftKey: true })
    expect(resolveKey("edit", evt, input("- hi", "edit", caret("hi", 2)))).toBe("splitPlain")
  })
})

describe("edit mode Enter in and into a code block", () => {
  /** A one-block doc of the given type and text. */
  function typed(type: "code" | "text", text: string, c: CaretInput): CommandInput {
    return {
      doc: {
        props: null,
        rootBlockIds: ["x"],
        blocks: { x: { id: "x", type, text, children: [] } },
      },
      key: "x",
      mode: "edit",
      visibleOrder: ["x"],
      caret: c,
    }
  }

  it("Enter in a code block is a newline — nothing is bound", () => {
    const evt = key({ key: "Enter" })
    expect(resolveKey("edit", evt, typed("code", "x = 1", caret("x = 1", 5)))).toBeNull()
    expect(resolveKey("edit", evt, typed("code", "", caret("", 0)))).toBeNull()
    expect(resolveKey("edit", evt, typed("code", "ab", caret("ab", 1)))).toBeNull()
  })

  it("Shift-Enter and Mod-Enter leave a code block with a fresh block below", () => {
    expect(
      resolveKey("edit", key({ key: "Enter", shiftKey: true }), typed("code", "x", caret("x", 1))),
    ).toBe("insertSiblingBelow")
    expect(
      resolveKey("edit", key({ key: "Enter", metaKey: true }), typed("code", "x", caret("x", 1))),
    ).toBe("insertSiblingBelow")
  })

  it("Enter on ```lang turns the block into a code block", () => {
    const evt = key({ key: "Enter" })
    expect(resolveKey("edit", evt, typed("text", "```", caret("```", 3)))).toBe("turnIntoCode")
    expect(resolveKey("edit", evt, typed("text", "```ts", caret("```ts", 5)))).toBe("turnIntoCode")
    // Not a fence opener: text after a space, or backticks mid-text.
    expect(resolveKey("edit", evt, typed("text", "``` x y", caret("``` x y", 7)))).toBe(
      "insertBelow",
    )
    expect(resolveKey("edit", evt, typed("text", "a ```", caret("a ```", 5)))).toBe("insertBelow")
  })
})

describe("edit mode Backspace (only special at the very start)", () => {
  it("strips the marker at the start of a marked block", () => {
    const evt = key({ key: "Backspace" })
    expect(resolveKey("edit", evt, input("# H", "edit", caret("H", 0)))).toBe("stripMarker")
  })

  it("merges up an empty unmarked block", () => {
    const evt = key({ key: "Backspace" })
    expect(resolveKey("edit", evt, input("", "edit", caret("", 0)))).toBe("backspaceEmpty")
  })

  it("does nothing special mid-text", () => {
    const evt = key({ key: "Backspace" })
    expect(resolveKey("edit", evt, input("hello", "edit", caret("hello", 3)))).toBeNull()
  })

  it("leaves an image's caption alone at its start (the picture is not a marker to strip)", () => {
    const evt = key({ key: "Backspace" })
    const image = "![cap](/api/images/img_abcdefghijklmnop)"
    expect(resolveKey("edit", evt, input(image, "edit", caret("cap", 0)))).toBeNull()
  })
})

describe("edit mode arrows leave only from the boundary line", () => {
  it("moves up only from the first visual line", () => {
    const evt = key({ key: "ArrowUp" })
    expect(
      resolveKey("edit", evt, input("a", "edit", caret("a", 0, 0, { atFirstLine: true }))),
    ).toBe("moveEditFocusUp")
    expect(
      resolveKey("edit", evt, input("a", "edit", caret("a", 0, 0, { atFirstLine: false }))),
    ).toBeNull()
  })

  it("ignores shifted arrows (text selection stays native)", () => {
    const evt = key({ key: "ArrowUp", shiftKey: true })
    expect(
      resolveKey("edit", evt, input("a", "edit", caret("a", 0, 0, { atFirstLine: true }))),
    ).toBeNull()
  })
})
