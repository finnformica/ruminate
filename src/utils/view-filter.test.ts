import { describe, expect, it } from "vitest"
import { STATIC_QUALIFIER_OPTIONS } from "./qualifier-suggestions"
import {
  clearFilterKey,
  describeFilter,
  describeSort,
  FILTER_TYPE_OPTIONS,
  filterValues,
  narrowingParam,
  resolveNarrowing,
  sortBranches,
  sortDirections,
  toggleFilterValue,
} from "./view-filter"

/**
 * The header's menus edit a query-language string, one qualifier at a time —
 * so what they set can be read, and typed, by hand. These hold that: a
 * toggle changes one qualifier's list and leaves everything else as written.
 *
 * They also hold the single source of truth: the values the Filter menu
 * offers are the query box's picker vocabulary, not a copy of it.
 */

describe("FILTER_TYPE_OPTIONS", () => {
  it("is the query box's own `type:` list, not a copy of it", () => {
    expect(FILTER_TYPE_OPTIONS).toBe(STATIC_QUALIFIER_OPTIONS.type)
  })

  it("leads with a plain paragraph and carries the note types too", () => {
    const values = FILTER_TYPE_OPTIONS.map((option) => option.value)
    expect(values[0]).toBe("text")
    expect(values).toContain("todo")
    expect(values).toContain("daily")
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
    // A qualifier the menu does not offer is still reported, as written, so
    // the button never claims an empty filter when one is set.
    expect(describeFilter("type:todo has:tasks")).toBe("Todo, has:tasks")
    expect(describeFilter("type:todo milk")).toBe("Todo, “milk”")
    expect(describeFilter("milk")).toBe("“milk”")
  })

  it("says nothing about nothing", () => {
    expect(describeFilter("")).toBe("")
  })

  it("reads an ancestor as the block's text when picked, or the typed text in quotes", () => {
    const blockText = (id: string) => (id === "blk_alice" ? "Alice Smith" : undefined)
    expect(describeFilter("parent:blk_alice", blockText)).toBe("parent Alice Smith")
    expect(describeFilter('under:"alice smith"', blockText)).toBe("under “alice smith”")
    expect(describeFilter("type:todo parent:alice milk", blockText)).toBe(
      "Todo, parent “alice”, “milk”",
    )
    // Without a lookup an id reads as itself, quoted like any value.
    expect(describeFilter("parent:blk_alice")).toBe("parent “blk_alice”")
  })

  it("reads every qualifier of a key, so a board's two features both read", () => {
    const blockText = (id: string) =>
      ({ blk_mauritius: "Mauritius", blk_lisbon: "Lisbon", blk_lamp: "Lamp" })[id]
    expect(describeFilter("parent:blk_mauritius,blk_lisbon parent:blk_lamp", blockText)).toBe(
      "parent Mauritius, parent Lisbon, parent Lamp",
    )
  })
})

/**
 * A board's Filter gives each feature a `parent:` qualifier of its own, so
 * that ticks under one feature OR (a comma list) and two features AND (a
 * key repeated) — the two shapes the engine reads two ways. A branch finds
 * its qualifier by the values it offers.
 */
describe("a branch's own qualifier", () => {
  const LOCATIONS = ["blk_mauritius", "blk_lisbon"]
  const FIXTURES = ["blk_lamp", "blk_chair"]

  it("writes a qualifier per branch: either within one, both across two", () => {
    const one = toggleFilterValue("", "parent", "blk_mauritius", LOCATIONS)
    expect(one).toBe("parent:blk_mauritius")
    const two = toggleFilterValue(one, "parent", "blk_lamp", FIXTURES)
    expect(two).toBe("parent:blk_mauritius parent:blk_lamp")
    const three = toggleFilterValue(two, "parent", "blk_lisbon", LOCATIONS)
    expect(three).toBe("parent:blk_mauritius,blk_lisbon parent:blk_lamp")
  })

  it("reads only its own qualifier, while a read without a branch sees them all", () => {
    const filter = "parent:blk_mauritius,blk_lisbon parent:blk_lamp"
    expect(filterValues(filter, "parent", LOCATIONS)).toEqual(["blk_mauritius", "blk_lisbon"])
    expect(filterValues(filter, "parent", FIXTURES)).toEqual(["blk_lamp"])
    expect(filterValues(filter, "parent")).toEqual(["blk_mauritius", "blk_lisbon", "blk_lamp"])
  })

  it("takes a value out of its own qualifier only, dropping it once empty", () => {
    const filter = "parent:blk_mauritius,blk_lisbon parent:blk_lamp"
    expect(toggleFilterValue(filter, "parent", "blk_lisbon", LOCATIONS)).toBe(
      "parent:blk_mauritius parent:blk_lamp",
    )
    expect(toggleFilterValue(filter, "parent", "blk_lamp", FIXTURES)).toBe(
      "parent:blk_mauritius,blk_lisbon",
    )
  })

  it("clears its own qualifier and leaves the others, the text and the rest as written", () => {
    const filter = "parent:blk_mauritius parent:blk_lamp type:text brass"
    expect(clearFilterKey(filter, "parent", LOCATIONS)).toBe("parent:blk_lamp type:text brass")
    expect(clearFilterKey(filter, "parent", FIXTURES)).toBe("parent:blk_mauritius type:text brass")
    expect(clearFilterKey(filter, "parent")).toBe("type:text brass")
  })

  it("leaves a qualifier typed by hand to no branch, meaning what it meant", () => {
    // A text value, or a list mixing two branches' values, is nobody's: it
    // is read by none, written by none, and a branch's tick goes beside it.
    expect(filterValues("parent:mauritius", "parent", LOCATIONS)).toEqual([])
    expect(filterValues("parent:blk_mauritius,blk_lamp", "parent", LOCATIONS)).toEqual([])
    expect(toggleFilterValue("parent:mauritius", "parent", "blk_lamp", FIXTURES)).toBe(
      "parent:mauritius parent:blk_lamp",
    )
    expect(clearFilterKey("parent:mauritius", "parent", LOCATIONS)).toBe("parent:mauritius")
  })

  it("without a branch, takes a value out of whichever qualifier holds it, and adds to the last", () => {
    const filter = "parent:blk_mauritius,blk_lisbon parent:blk_lamp"
    expect(toggleFilterValue(filter, "parent", "blk_lisbon")).toBe(
      "parent:blk_mauritius parent:blk_lamp",
    )
    expect(toggleFilterValue(filter, "parent", "blk_lamp")).toBe("parent:blk_mauritius,blk_lisbon")
    expect(toggleFilterValue(filter, "parent", "blk_chair")).toBe(
      "parent:blk_mauritius,blk_lisbon parent:blk_lamp,blk_chair",
    )
  })
})

describe("resolveNarrowing / narrowingParam", () => {
  it("lets the URL win where it speaks, and the saved view fill the silence", () => {
    expect(resolveNarrowing(undefined, "type:todo")).toBe("type:todo")
    expect(resolveNarrowing("type:done", "type:todo")).toBe("type:done")
    expect(resolveNarrowing(undefined, "")).toBe("")
  })

  it("reads an empty param as an explicit none, not as nothing said", () => {
    // Otherwise clearing the filter on a note with a saved one would drop the
    // param, the default would come back, and the whole note would be
    // unreachable.
    expect(resolveNarrowing("", "type:todo")).toBe("")
  })

  it("writes emptiness down only when the silence would mean something else", () => {
    expect(narrowingParam("type:todo", "")).toBe("type:todo")
    expect(narrowingParam("", "")).toBe(undefined)
    expect(narrowingParam("", "type:todo")).toBe("")
  })

  it("round-trips: clearing a saved view shows the whole note", () => {
    const saved = "type:todo"
    expect(resolveNarrowing(narrowingParam("", saved), saved)).toBe("")
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
