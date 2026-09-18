import { describe, expect, it } from "vitest"
import {
  clearFilterKey,
  describeFilter,
  describeSort,
  filterBranches,
  filterValues,
  sortBranches,
  sortDirections,
  toggleFilterValue,
} from "./view-filter"

/**
 * The header's menus edit a query-language string, one qualifier at a time —
 * so what they set can be read, and typed, by hand. These hold that: a
 * toggle changes one qualifier's list and leaves everything else as written.
 *
 * They also hold the single source of truth: the branches the Filter menu
 * offers are the query box's picker vocabulary, not a copy of it.
 */

describe("filterBranches", () => {
  it("offers the query box's own qualifier keys", () => {
    const keys = filterBranches(new Date("2026-09-18T00:00:00Z")).map((branch) => branch.key)
    expect(keys).toEqual(["type", "has", "no", "date"])
  })

  it("does not offer sort (the Sort menu's) or in (the view's root)", () => {
    const keys = filterBranches().map((branch) => branch.key)
    expect(keys).not.toContain("sort")
    expect(keys).not.toContain("in")
  })

  it("takes each branch's values from the picker, not from a copy", () => {
    const type = filterBranches().find((branch) => branch.key === "type")
    const values = type?.options.map((option) => option.value) ?? []
    // The block types the registry declares, and the note types beside them.
    expect(values).toContain("todo")
    expect(values).toContain("heading")
    expect(values).toContain("daily")
    const has = filterBranches().find((branch) => branch.key === "has")
    expect(has?.options.map((option) => option.value)).toEqual(["dates", "tasks", "title"])
  })
})

describe("filterValues", () => {
  it("reads the values a filter names under a key", () => {
    expect(filterValues("type:todo", "type")).toEqual(["todo"])
    expect(filterValues("type:todo,done", "type")).toEqual(["todo", "done"])
    expect(filterValues("milk type:todo has:tasks", "has")).toEqual(["tasks"])
  })

  it("reads nothing where the key is absent, or only excluded", () => {
    expect(filterValues("", "type")).toEqual([])
    expect(filterValues("milk", "type")).toEqual([])
    expect(filterValues("-type:done", "type")).toEqual([])
  })
})

describe("toggleFilterValue", () => {
  it("adds a value, then takes it back out", () => {
    expect(toggleFilterValue("", "type", "todo")).toBe("type:todo")
    expect(toggleFilterValue("type:todo", "type", "done")).toBe("type:todo,done")
    expect(toggleFilterValue("type:todo,done", "type", "todo")).toBe("type:done")
    expect(toggleFilterValue("type:todo", "type", "todo")).toBe("")
  })

  it("keeps the free text the filter carries", () => {
    expect(toggleFilterValue("milk", "type", "todo")).toBe("type:todo milk")
    expect(toggleFilterValue("type:todo milk", "type", "todo")).toBe("milk")
  })

  it("keeps the other qualifiers, including an exclusion typed by hand", () => {
    expect(toggleFilterValue("-type:done milk", "type", "todo")).toBe("type:todo -type:done milk")
    expect(toggleFilterValue("has:tasks", "type", "todo")).toBe("type:todo has:tasks")
  })

  it("quotes a value with a space in it, as the query box does", () => {
    expect(toggleFilterValue("", "genre", "science fiction")).toBe('genre:"science fiction"')
  })
})

describe("clearFilterKey", () => {
  it("takes one qualifier out and leaves the rest", () => {
    expect(clearFilterKey("type:todo has:tasks milk", "type")).toBe("has:tasks milk")
    expect(clearFilterKey("type:todo", "has")).toBe("type:todo")
  })
})

describe("describeFilter", () => {
  it("reads every qualifier out in words, then the text", () => {
    expect(describeFilter("type:todo")).toBe("Todo")
    expect(describeFilter("type:todo,done")).toBe("Todo, Done")
    expect(describeFilter("type:todo has:tasks")).toBe("Todo, Tasks")
    expect(describeFilter("type:todo milk")).toBe("Todo, “milk”")
    expect(describeFilter("milk")).toBe("“milk”")
  })

  it("says nothing about nothing", () => {
    expect(describeFilter("")).toBe("")
  })
})

describe("sort branches", () => {
  it("offers only the keys that order a block by something of its own", () => {
    expect(sortBranches().map((option) => option.value)).toEqual(["text", "type"])
  })

  it("takes the directions from the query box's second step", () => {
    expect(sortDirections("text").map((option) => option.value)).toEqual(["text:asc", "text:desc"])
  })
})

describe("describeSort", () => {
  it("names the key, and the direction when it is not the default", () => {
    expect(describeSort("text")).toBe("Text")
    expect(describeSort("text:desc")).toBe("Text, descending")
    expect(describeSort("type,text:desc")).toBe("Type then Text, descending")
  })

  it("says nothing about document order", () => {
    expect(describeSort("")).toBe("")
    expect(describeSort("  ")).toBe("")
  })
})
