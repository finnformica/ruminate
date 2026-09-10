import { describe, expect, test } from "vitest"
import { isInRange, parseQuery, removeQualifier, resolveRelativeDate } from "./search"

describe("parseQuery", () => {
  test("parses quoted values, comma lists, exclusions, and multiple sorts", () => {
    const q = parseQuery('foo tag:a,b title:"hello, world" -tag:c sort:title,id:desc,tags')
    expect(q.fuzzy).toBe("foo")
    expect(q.filters).toEqual([
      { key: "tag", values: ["a", "b"], exclude: false },
      { key: "title", values: ["hello, world"], exclude: false },
      { key: "tag", values: ["c"], exclude: true },
    ])
    expect(q.sorts).toEqual([
      { key: "title", direction: "asc" },
      { key: "id", direction: "desc" },
      { key: "tags", direction: "desc" },
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
    const q = parseQuery("   hello   world   tag:a   ")
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
    const q = parseQuery("milk type:todo tag:work")
    expect(q.fuzzy).toBe("milk")
    expect(q.filters).toEqual([
      { key: "type", values: ["todo"], exclude: false },
      { key: "tag", values: ["work"], exclude: false },
    ])
  })

  test("sort:updated and sort:updated_at default to descending", () => {
    expect(parseQuery("sort:updated").sorts).toEqual([{ key: "updated", direction: "desc" }])
    expect(parseQuery("sort:updated_at").sorts).toEqual([{ key: "updated_at", direction: "desc" }])
  })

  test("applies default sort directions when omitted per key", () => {
    const q = parseQuery("sort:tags,title,updated:asc")
    expect(q.sorts).toEqual([
      { key: "tags", direction: "desc" },
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

describe("removeQualifier", () => {
  test("takes one qualifier out of the query, as parsed, and tidies the spacing", () => {
    expect(
      removeQualifier("type:todo tag:work milk", { key: "tag", values: ["work"], exclude: false }),
    ).toBe("type:todo milk")
    expect(removeQualifier("-tag:work milk", { key: "tag", values: ["work"], exclude: true })).toBe(
      "milk",
    )
    expect(removeQualifier("in:n1 type:todo", { key: "in", values: ["n1"], exclude: false })).toBe(
      "type:todo",
    )
  })

  test("finds quoted and comma-list values as typed", () => {
    expect(
      removeQualifier('milk in:"reading list" type:todo', {
        key: "in",
        values: ["reading list"],
        exclude: false,
      }),
    ).toBe("milk type:todo")
    expect(
      removeQualifier("tag:a,b milk", { key: "tag", values: ["a", "b"], exclude: false }),
    ).toBe("milk")
  })

  test("leaves the query alone when nothing matches exactly", () => {
    expect(removeQualifier("tag:work milk", { key: "tag", values: ["home"], exclude: false })).toBe(
      "tag:work milk",
    )
    expect(removeQualifier("tag:work milk", { key: "tag", values: ["work"], exclude: true })).toBe(
      "tag:work milk",
    )
  })
})
