import { describe, expect, it } from "vitest"
import { classifyLine, leadingMarker, markerFor, toggleType, typeOfMarker } from "./markers"

describe("classifyLine (import)", () => {
  it("types each canonical marker and drops it from the text", () => {
    expect(classifyLine("# Title", 1, false)).toEqual({ type: "h1", text: "Title" })
    expect(classifyLine("[ ] task", 1, false)).toEqual({ type: "todo", text: "task" })
    expect(classifyLine("[x] done", 1, false)).toEqual({ type: "done", text: "done" })
    expect(classifyLine("- item", 1, false)).toEqual({ type: "ul", text: "item" })
    expect(classifyLine("> quote", 1, false)).toEqual({ type: "quote", text: "quote" })
    expect(classifyLine("1. first", 1, false)).toEqual({ type: "ol", text: "first" })
    expect(classifyLine("just text", 1, false)).toEqual({ type: "text", text: "just text" })
  })

  it("collapses deeper heading markers to one heading type (size comes from depth)", () => {
    expect(classifyLine("### Small", 1, false)).toEqual({ type: "h1", text: "Small" })
  })

  it("types an ordered marker by its position in the run, folding wrong numbers in", () => {
    expect(classifyLine("2. second", 2, false)).toEqual({ type: "ol", text: "second" })
    // A wrong number is a near-miss: still an ordered item, renumbered on export.
    expect(classifyLine("7. seventh", 2, false)).toEqual({ type: "ol", text: "seventh" })
    expect(classifyLine("2) paren", 1, false)).toEqual({ type: "ol", text: "paren" })
  })

  it("folds near-miss spellings into their typed form", () => {
    expect(classifyLine("[] task", 1, false)).toEqual({ type: "todo", text: "task" })
    expect(classifyLine("[X] done", 1, false)).toEqual({ type: "done", text: "done" })
    expect(classifyLine("* item", 1, false)).toEqual({ type: "ul", text: "item" })
  })

  it("leaves ambiguous text alone: a tag, a bare marker, a year", () => {
    expect(classifyLine("#tag", 1, false)).toEqual({ type: "text", text: "#tag" })
    expect(classifyLine("1st place", 1, false)).toEqual({ type: "text", text: "1st place" })
    expect(classifyLine("1990. That year", 1, false).type).toBe("text")
    expect(classifyLine("", 1, false)).toEqual({ type: "text", text: "" })
  })

  it("types nothing inside a code fence", () => {
    expect(classifyLine("- [ ] not a todo", 1, true)).toEqual({
      type: "text",
      text: "- [ ] not a todo",
    })
  })
})

describe("markerFor (export)", () => {
  it("is the inverse of classification, renumbering ordered items by position", () => {
    expect(markerFor("h1")).toBe("# ")
    expect(markerFor("todo")).toBe("[ ] ")
    expect(markerFor("done")).toBe("[x] ")
    expect(markerFor("ul")).toBe("- ")
    expect(markerFor("quote")).toBe("> ")
    expect(markerFor("ol", 3)).toBe("3. ")
    expect(markerFor("text")).toBe("")
    expect(markerFor("page")).toBe("")
  })
})

describe("leadingMarker (the typing shortcut)", () => {
  it("returns the type and the rest when the text starts with a marker", () => {
    expect(leadingMarker("# Title")).toEqual({ type: "h1", text: "Title" })
    expect(leadingMarker("### Small")).toEqual({ type: "h1", text: "Small" })
    expect(leadingMarker("- item")).toEqual({ type: "ul", text: "item" })
    expect(leadingMarker("[] task")).toEqual({ type: "todo", text: "task" })
    expect(leadingMarker("[x] done")).toEqual({ type: "done", text: "done" })
    expect(leadingMarker("> quote")).toEqual({ type: "quote", text: "quote" })
    expect(leadingMarker("1. first")).toEqual({ type: "ol", text: "first" })
    // The moment the marker is typed, with nothing after it yet.
    expect(leadingMarker("- ")).toEqual({ type: "ul", text: "" })
  })

  it("returns null without a trailing space, so a partial marker never switches type", () => {
    expect(leadingMarker("#tag")).toBeNull()
    expect(leadingMarker("-dash")).toBeNull()
    expect(leadingMarker("1st")).toBeNull()
    expect(leadingMarker("plain text")).toBeNull()
    expect(leadingMarker("")).toBeNull()
  })
})

describe("typeOfMarker (the new-block preference)", () => {
  it("reads a marker string as its type, an empty one as plain text", () => {
    expect(typeOfMarker("- ")).toBe("ul")
    expect(typeOfMarker("[ ] ")).toBe("todo")
    expect(typeOfMarker("> ")).toBe("quote")
    expect(typeOfMarker("")).toBe("text")
    expect(typeOfMarker("→ ")).toBe("text")
  })
})

describe("toggleType", () => {
  it("turns a type on, and the same type back off to text", () => {
    expect(toggleType("text", "ul")).toBe("ul")
    expect(toggleType("ul", "ul")).toBe("text")
    expect(toggleType("quote", "ul")).toBe("ul")
  })

  it("treats a checked todo as already a todo, and any heading as a heading", () => {
    expect(toggleType("done", "todo")).toBe("text")
    expect(toggleType("h2", "h1")).toBe("text")
  })
})
