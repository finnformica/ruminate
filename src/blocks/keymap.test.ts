import { describe, expect, it } from "vitest"
import { COMMANDS, type CaretInput, type CommandInput, type Mode } from "./commands"
import { comboFromEvent, KEYMAP, resolveKey, type KeyLike } from "./keymap"
import type { BlockDoc } from "./types"

function key(over: Partial<KeyLike> & { key: string }): KeyLike {
  return { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...over }
}

function docWith(content: string): BlockDoc {
  return {
    frontmatter: null,
    rootBlockIds: ["x"],
    blocks: { x: { id: "x", content, children: [] } },
  }
}

function input(content: string, mode: Mode, caret?: CaretInput): CommandInput {
  return { doc: docWith(content), id: "x", mode, visibleOrder: ["x"], caret }
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
