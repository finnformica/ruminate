import { describe, expect, test } from "vitest"
import { dateShortcuts } from "../blocks/slash-menu"
import {
  STATIC_QUALIFIER_OPTIONS,
  SUGGESTED_QUALIFIER_KEYS,
  applyQualifierOption,
  dateQualifierOptions,
  filterQualifierOptions,
  findQualifierTrigger,
  sortQualifierOptions,
} from "./qualifier-suggestions"

/** The trigger with the caret at the end of the text. */
const atEnd = (text: string) => findQualifierTrigger(text, text.length)

describe("findQualifierTrigger", () => {
  test("opens on `key:` and tracks the value being typed", () => {
    expect(atEnd("type:")).toEqual({
      key: "type",
      exclude: false,
      prefixValues: [],
      partial: "",
      start: 0,
      end: 5,
    })
    expect(atEnd("milk type:to")).toMatchObject({ key: "type", partial: "to", start: 5, end: 12 })
    expect(atEnd("-Type:to")).toMatchObject({ key: "type", exclude: true, partial: "to" })
  })

  test("nothing opens on plain words, or on a colon inside a word", () => {
    expect(atEnd("milk")).toBeNull()
    expect(atEnd("")).toBeNull()
    // A URL reads as a qualifier to the query language too (`https:`); it is
    // the picker that stays shut, since no vocabulary is known for that key.
    expect(atEnd("see https://example.com")).toMatchObject({ key: "https" })
    expect(atEnd("type:todo milk")).toBeNull()
  })

  test("a comma list keeps the earlier values and filters on the last", () => {
    expect(atEnd("type:todo,do")).toMatchObject({
      prefixValues: ["todo"],
      partial: "do",
      start: 0,
      end: 12,
    })
  })

  test("an open quote lets the value run over spaces", () => {
    expect(atEnd('in:"reading li')).toMatchObject({ key: "in", partial: "reading li", end: 14 })
    // A closed quote is a finished value: nothing to suggest.
    expect(atEnd('in:"reading list"')).toBeNull()
  })

  test("with the caret inside a token, the whole token is the range", () => {
    // `type:to|do` — filters on what is before the caret, replaces all of it.
    expect(findQualifierTrigger("type:todo milk", 7)).toMatchObject({
      partial: "to",
      start: 0,
      end: 9,
    })
  })
})

describe("applyQualifierOption", () => {
  test("replaces the token with the pick and leaves the caret after a space", () => {
    const trigger = atEnd("milk type:to")!
    expect(applyQualifierOption("milk type:to", trigger, { value: "todo" })).toEqual({
      value: "milk type:todo ",
      caret: 15,
    })
  })

  test("keeps the exclusion, the comma prefix, and the text after the token", () => {
    const value = "-type:todo,do in:work"
    const trigger = findQualifierTrigger(value, 13)!
    expect(applyQualifierOption(value, trigger, { value: "done" })).toEqual({
      value: "-type:todo,done in:work",
      caret: 16,
    })
  })

  test("quotes a value with spaces (a note name)", () => {
    const value = 'in:"read'
    const trigger = atEnd(value)!
    expect(applyQualifierOption(value, trigger, { value: "Reading list" })).toEqual({
      value: 'in:"Reading list" ',
      caret: 18,
    })
  })
})

describe("filterQualifierOptions", () => {
  test("ranks prefix matches on the value first, then on the label, then substrings", () => {
    const options = [
      { value: "heading", label: "Heading" },
      { value: "todo", label: "To-do" },
      { value: "done", label: "Checked to-do" },
      { value: "text", label: "Paragraph" },
    ]
    expect(filterQualifierOptions(options, "to").map((o) => o.value)).toEqual(["todo", "done"])
    expect(filterQualifierOptions(options, "").map((o) => o.value)).toEqual([
      "heading",
      "todo",
      "done",
      "text",
    ])
    expect(filterQualifierOptions(options, "zzz")).toEqual([])
  })

  test("the type vocabulary is the query language's, block types first", () => {
    const values = STATIC_QUALIFIER_OPTIONS.type.map((o) => o.value)
    expect(values.slice(0, 3)).toEqual(["todo", "done", "task"])
    expect(values).toContain("daily")
  })
})

describe("sort: and date: vocabularies", () => {
  test("sort: offers the keys first, and a picked key opens on its directions", () => {
    const keys = sortQualifierOptions("")
    expect(keys.map((option) => [option.value, option.label])).toEqual([
      ["title", "Title"],
      ["updated_at", "Updated at"],
    ])
    expect(filterQualifierOptions(keys, "up").map((o) => o.value)).toEqual(["updated_at"])
    // A key is half a value: the pick writes it with a colon and no space,
    // so the picker stays open on the second step.
    const atKey = atEnd("sort:up")
    expect(applyQualifierOption("sort:up", atKey!, keys[1])).toEqual({
      value: "sort:updated_at:",
      caret: 16,
    })
    // The direction suffix is part of the value the picker filters on.
    const trigger = atEnd("sort:title:")
    expect(trigger?.key).toBe("sort")
    expect(trigger?.partial).toBe("title:")
    const directions = sortQualifierOptions("title:")
    expect(directions.map((o) => [o.value, o.label, o.glyph])).toEqual([
      ["title:asc", "Ascending", "↑"],
      ["title:desc", "Descending", "↓"],
    ])
    expect(filterQualifierOptions(directions, "title:de").map((o) => o.value)).toEqual([
      "title:desc",
    ])
    expect(applyQualifierOption("sort:title:", trigger!, directions[1])).toEqual({
      value: "sort:title:desc ",
      caret: 16,
    })
    // A key the picker does not know has no directions to offer.
    expect(sortQualifierOptions("id:")).toEqual([])
  })

  test("date: offers the slash menu's shortcuts, each resolved to the day it means", () => {
    const now = new Date(2026, 8, 13) // a Sunday
    const options = dateQualifierOptions(now)
    // The one source the slash menu's date rows come from: same words,
    // same days.
    expect(options).toEqual(dateShortcuts(now).map((s) => ({ value: s.date, label: s.label })))
    expect(options.map((option) => option.label)).toEqual([
      "Today",
      "Tomorrow",
      "Yesterday",
      "Next week",
      "Last week",
    ])
    expect(options.map((option) => option.value)).toEqual([
      "2026-09-13",
      "2026-09-14",
      "2026-09-12",
      "2026-09-20",
      "2026-09-06",
    ])
    // The row is found by its word, and the day is what a pick writes.
    expect(filterQualifierOptions(options, "tom").map((o) => o.value)).toEqual(["2026-09-14"])
    expect(SUGGESTED_QUALIFIER_KEYS).toContain("date")
    expect(SUGGESTED_QUALIFIER_KEYS).toContain("sort")
  })
})
