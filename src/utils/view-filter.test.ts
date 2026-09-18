import { describe, expect, it } from "vitest"
import { describeFilter, describeSort, filterTypes, toggleFilterType } from "./view-filter"

/**
 * The header's menus edit a query-language string, one qualifier at a time —
 * so what they set can be read, and typed, by hand. These hold that: a
 * toggle changes the `type:` list and leaves everything else exactly as
 * written.
 */

describe("filterTypes", () => {
  it("reads the values a filter names", () => {
    expect(filterTypes("type:todo")).toEqual(["todo"])
    expect(filterTypes("type:todo,done")).toEqual(["todo", "done"])
    expect(filterTypes("milk type:todo")).toEqual(["todo"])
  })

  it("reads nothing out of a filter with no type:", () => {
    expect(filterTypes("")).toEqual([])
    expect(filterTypes("milk")).toEqual([])
  })

  it("ignores an exclusion — those are not what the menu ticks", () => {
    expect(filterTypes("-type:done")).toEqual([])
  })
})

describe("toggleFilterType", () => {
  it("adds a value, then takes it back out", () => {
    expect(toggleFilterType("", "todo")).toBe("type:todo")
    expect(toggleFilterType("type:todo", "done")).toBe("type:todo,done")
    expect(toggleFilterType("type:todo,done", "todo")).toBe("type:done")
    expect(toggleFilterType("type:todo", "todo")).toBe("")
  })

  it("keeps the free text the filter carries", () => {
    expect(toggleFilterType("milk", "todo")).toBe("type:todo milk")
    expect(toggleFilterType("type:todo milk", "todo")).toBe("milk")
  })

  it("keeps a qualifier it does not own", () => {
    expect(toggleFilterType("-type:done milk", "todo")).toBe("type:todo milk")
  })
})

describe("describeFilter", () => {
  it("reads the types out in words", () => {
    expect(describeFilter("type:todo")).toBe("Todo")
    expect(describeFilter("type:todo,done")).toBe("Todo, Done")
  })

  it("quotes the text it is searching for", () => {
    expect(describeFilter("type:todo milk")).toBe("Todo, “milk”")
    expect(describeFilter("milk")).toBe("“milk”")
  })

  it("says nothing about nothing", () => {
    expect(describeFilter("")).toBe("")
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
