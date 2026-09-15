import { describe, expect, test } from "vitest"
import {
  composeQuery,
  extractQualifiers,
  isInRange,
  parseQualifierToken,
  parseQuery,
  resolveRelativeDate,
  splitQuery,
} from "./search"

describe("parseQuery", () => {
  test("parses quoted values, comma lists, exclusions, and multiple sorts", () => {
    const q = parseQuery('foo area:a,b title:"hello, world" -area:c sort:title,id:desc,updated')
    expect(q.fuzzy).toBe("foo")
    expect(q.filters).toEqual([
      { key: "area", values: ["a", "b"], exclude: false },
      { key: "title", values: ["hello, world"], exclude: false },
      { key: "area", values: ["c"], exclude: true },
    ])
    expect(q.sorts).toEqual([
      { key: "title", direction: "asc" },
      { key: "id", direction: "desc" },
      { key: "updated", direction: "desc" },
    ])
  })

  test("treats unknown qualifiers as frontmatter filters and trims fuzzy", () => {
    const q = parseQuery("hello priority:high")
    expect(q.fuzzy).toBe("hello")
    expect(q.filters).toEqual([{ key: "priority", values: ["high"], exclude: false }])
  })

  test("parses multiple sort qualifiers and ignores exclude on sort", () => {
    const q = parseQuery("sort:title -sort:id:desc")
    expect(q.sorts).toEqual([
      { key: "title", direction: "asc" },
      { key: "id", direction: "desc" },
    ])
  })

  test("supports hyphenated keys and quoted values with commas and hyphens", () => {
    const q = parseQuery('foo foo-bar:"a-b, c"')
    expect(q.fuzzy).toBe("foo")
    expect(q.filters).toEqual([{ key: "foo-bar", values: ["a-b, c"], exclude: false }])
  })

  test("trims fuzzy text and preserves inner spacing", () => {
    const q = parseQuery("   hello   world   area:a   ")
    expect(q.fuzzy).toBe("hello   world")
  })

  test("parses type qualifiers like any other filter", () => {
    expect(parseQuery("type:todo").filters).toEqual([
      { key: "type", values: ["todo"], exclude: false },
    ])
    expect(parseQuery("type:todo,done").filters).toEqual([
      { key: "type", values: ["todo", "done"], exclude: false },
    ])
    expect(parseQuery("-type:done").filters).toEqual([
      { key: "type", values: ["done"], exclude: true },
    ])
    expect(parseQuery('type:"todo"').filters).toEqual([
      { key: "type", values: ["todo"], exclude: false },
    ])
    const q = parseQuery("milk type:todo area:work")
    expect(q.fuzzy).toBe("milk")
    expect(q.filters).toEqual([
      { key: "type", values: ["todo"], exclude: false },
      { key: "area", values: ["work"], exclude: false },
    ])
  })

  test("sort:updated and sort:updated_at default to descending", () => {
    expect(parseQuery("sort:updated").sorts).toEqual([{ key: "updated", direction: "desc" }])
    expect(parseQuery("sort:updated_at").sorts).toEqual([{ key: "updated_at", direction: "desc" }])
  })

  test("applies default sort directions when omitted per key", () => {
    const q = parseQuery("sort:updated_at,title,updated:asc")
    expect(q.sorts).toEqual([
      { key: "updated_at", direction: "desc" },
      { key: "title", direction: "asc" },
      { key: "updated", direction: "asc" },
    ])
  })
})

describe("resolveRelativeDate", () => {
  test("resolves 'today' to current date", () => {
    const today = resolveRelativeDate("today")
    // Should be a valid ISO date
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("resolves 'tomorrow' to day after today", () => {
    const today = resolveRelativeDate("today")
    const tomorrow = resolveRelativeDate("tomorrow")
    // Tomorrow should be greater than today
    expect(tomorrow > today).toBe(true)
  })

  test("resolves 'yesterday' to day before today", () => {
    const today = resolveRelativeDate("today")
    const yesterday = resolveRelativeDate("yesterday")
    // Yesterday should be less than today
    expect(yesterday < today).toBe(true)
  })

  test("resolves 'next+week' syntax with plus signs", () => {
    const today = resolveRelativeDate("today")
    const nextWeek = resolveRelativeDate("next+week")
    // next week should be greater than today
    expect(nextWeek > today).toBe(true)
  })

  test("returns original value for non-date strings", () => {
    expect(resolveRelativeDate("foo")).toBe("foo")
  })

  test("returns original value for ISO dates", () => {
    expect(resolveRelativeDate("2024-01-15")).toBe("2024-01-15")
  })
})

describe("isInRange with relative dates", () => {
  test("matches exact relative date", () => {
    const today = resolveRelativeDate("today")
    const yesterday = resolveRelativeDate("yesterday")
    expect(isInRange(today, "today")).toBe(true)
    expect(isInRange(yesterday, "today")).toBe(false)
  })

  test("supports >= with relative dates", () => {
    const today = resolveRelativeDate("today")
    const tomorrow = resolveRelativeDate("tomorrow")
    const yesterday = resolveRelativeDate("yesterday")
    expect(isInRange(today, ">=today")).toBe(true)
    expect(isInRange(tomorrow, ">=today")).toBe(true)
    expect(isInRange(yesterday, ">=today")).toBe(false)
  })

  test("supports < with relative dates", () => {
    const today = resolveRelativeDate("today")
    const yesterday = resolveRelativeDate("yesterday")
    expect(isInRange(yesterday, "<today")).toBe(true)
    expect(isInRange(today, "<today")).toBe(false)
  })

  test("supports <= with relative dates", () => {
    const today = resolveRelativeDate("today")
    const tomorrow = resolveRelativeDate("tomorrow")
    expect(isInRange(today, "<=today")).toBe(true)
    expect(isInRange(tomorrow, "<=today")).toBe(false)
  })

  test("supports > with relative dates", () => {
    const today = resolveRelativeDate("today")
    const tomorrow = resolveRelativeDate("tomorrow")
    expect(isInRange(tomorrow, ">today")).toBe(true)
    expect(isInRange(today, ">today")).toBe(false)
  })
})

describe("splitQuery and composeQuery", () => {
  test("splits a query into its qualifier tokens, as typed, and the text between", () => {
    expect(splitQuery('milk  in:"Reading list" type:todo  bread -area:work')).toEqual({
      qualifiers: ['in:"Reading list"', "type:todo", "-area:work"],
      text: "milk bread",
    })
    expect(splitQuery("")).toEqual({ qualifiers: [], text: "" })
    expect(splitQuery("sort:title,id:desc")).toEqual({
      qualifiers: ["sort:title,id:desc"],
      text: "",
    })
  })

  test("composes the qualifiers first and the text after, and round-trips", () => {
    expect(composeQuery(["type:todo", 'in:"Reading list"'], " milk ")).toBe(
      'type:todo in:"Reading list" milk',
    )
    expect(composeQuery([], "")).toBe("")
    expect(composeQuery(["type:todo"], "")).toBe("type:todo")
    const query = "in:n1 type:todo milk"
    expect(composeQuery(splitQuery(query).qualifiers, splitQuery(query).text)).toBe(query)
  })
})

describe("extractQualifiers", () => {
  test("lifts a token out once whitespace follows it, moving the caret with the text", () => {
    expect(extractQualifiers("type:todo ", 10)).toEqual({
      text: "",
      caret: 0,
      qualifiers: ["type:todo"],
    })
    expect(extractQualifiers("milk type:todo bread", 20)).toEqual({
      text: "milk bread",
      caret: 10,
      qualifiers: ["type:todo"],
    })
    // The caret inside the lifted token lands where it stood.
    expect(extractQualifiers("milk type:todo  bread", 15)).toEqual({
      text: "milk bread",
      caret: 5,
      qualifiers: ["type:todo"],
    })
    // Before the token, the caret does not move.
    expect(extractQualifiers("milk type:todo bread", 2).caret).toBe(2)
  })

  test("leaves the token the line ends in — it is still being typed", () => {
    expect(extractQualifiers("milk type:to", 12)).toEqual({
      text: "milk type:to",
      caret: 12,
      qualifiers: [],
    })
    expect(extractQualifiers('in:"Reading li', 14).qualifiers).toEqual([])
  })

  test("lifts several at once, quoted and negated values as typed", () => {
    expect(extractQualifiers('-type:done in:"Reading list" milk', 33)).toEqual({
      text: "milk",
      caret: 4,
      qualifiers: ["-type:done", 'in:"Reading list"'],
    })
  })
})

describe("parseQualifierToken", () => {
  test("reads a token as a filter: key, values, negation", () => {
    expect(parseQualifierToken("type:todo")).toEqual({
      key: "type",
      values: ["todo"],
      exclude: false,
    })
    expect(parseQualifierToken('-in:"Reading list"')).toEqual({
      key: "in",
      values: ["Reading list"],
      exclude: true,
    })
    expect(parseQualifierToken("area:a,b")).toEqual({
      key: "area",
      values: ["a", "b"],
      exclude: false,
    })
  })

  test("reads a sort as one value, and refuses what is not a token", () => {
    expect(parseQualifierToken("sort:title,id:desc")).toEqual({
      key: "sort",
      values: ["title,id:desc"],
      exclude: false,
    })
    expect(parseQualifierToken("milk")).toBeNull()
    expect(parseQualifierToken("type:todo milk")).toBeNull()
  })
})
