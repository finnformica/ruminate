import { describe, expect, test } from "vitest"
import {
  applySlashItem,
  findSlashTrigger,
  parseDateShortcut,
  slashMenuItems,
  type SlashItem,
} from "./slash-menu"

// Tuesday 8 September 2026, midday local time.
const NOW = new Date(2026, 8, 8, 12)

const iso = (date: Date | null) =>
  date
    ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
        date.getDate(),
      ).padStart(2, "0")}`
    : null

describe("findSlashTrigger", () => {
  test("a slash at the start of the text opens with an empty query", () => {
    expect(findSlashTrigger("/", 1)).toEqual({ start: 0, query: "" })
  })

  test("the query is the text between the slash and the caret", () => {
    expect(findSlashTrigger("call mum /tom", 13)).toEqual({ start: 9, query: "tom" })
    expect(findSlashTrigger("/next week on friday", 20)).toEqual({
      start: 0,
      query: "next week on friday",
    })
  })

  test("text after the caret is not part of the query", () => {
    expect(findSlashTrigger("/tom and more", 4)).toEqual({ start: 0, query: "tom" })
  })

  test("a slash inside a word never triggers", () => {
    expect(findSlashTrigger("and/or", 6)).toBeNull()
    expect(findSlashTrigger("https://example.com", 8)).toBeNull()
  })

  test("a space straight after the slash closes it (literal slash)", () => {
    expect(findSlashTrigger("/ ", 2)).toBeNull()
  })

  test("the caret must be after the slash on the same line", () => {
    expect(findSlashTrigger("/tom", 0)).toBeNull()
    expect(findSlashTrigger("/tom\nx", 6)).toBeNull()
  })

  test("a long phrase is prose, not a command", () => {
    expect(findSlashTrigger("/" + "a".repeat(41), 42)).toBeNull()
  })
})

describe("parseDateShortcut", () => {
  test("the everyday shortcuts", () => {
    expect(iso(parseDateShortcut("today", NOW))).toBe("2026-09-08")
    expect(iso(parseDateShortcut("Tomorrow", NOW))).toBe("2026-09-09")
    expect(iso(parseDateShortcut("yesterday", NOW))).toBe("2026-09-07")
    expect(iso(parseDateShortcut("next week", NOW))).toBe("2026-09-15")
    expect(iso(parseDateShortcut("in 2 weeks", NOW))).toBe("2026-09-22")
    expect(iso(parseDateShortcut("3 days ago", NOW))).toBe("2026-09-05")
  })

  test("weekdays", () => {
    expect(iso(parseDateShortcut("friday", NOW))).toBe("2026-09-11")
    expect(iso(parseDateShortcut("next friday", NOW))).toBe("2026-09-18")
  })

  test("'next week on <day>' means that day of the following week", () => {
    expect(iso(parseDateShortcut("next week on friday", NOW))).toBe("2026-09-18")
    expect(iso(parseDateShortcut("next week  on Fri", NOW))).toBe("2026-09-18")
    expect(iso(parseDateShortcut("next week monday", NOW))).toBe("2026-09-14")
    expect(iso(parseDateShortcut("monday next week", NOW))).toBe("2026-09-14")
    expect(iso(parseDateShortcut("sunday of next week", NOW))).toBe("2026-09-20")
  })

  test("explicit dates", () => {
    expect(iso(parseDateShortcut("1 oct", NOW))).toBe("2026-10-01")
    expect(iso(parseDateShortcut("2026-12-25", NOW))).toBe("2026-12-25")
  })

  test("prose and bare months stay text", () => {
    expect(parseDateShortcut("", NOW)).toBeNull()
    expect(parseDateShortcut("meeting", NOW)).toBeNull()
    expect(parseDateShortcut("march notes", NOW)).toBeNull()
    expect(parseDateShortcut("may", NOW)).toBeNull()
    expect(parseDateShortcut("next week on someday", NOW)).toBeNull()
  })
})

describe("slashMenuItems", () => {
  const labels = (items: SlashItem[]) => items.map((item) => item.label)

  test("an empty query lists every date shortcut, then every block type", () => {
    expect(labels(slashMenuItems("", NOW))).toEqual([
      "Today",
      "Tomorrow",
      "Yesterday",
      "Next week",
      "Last week",
      "Text",
      "Bullet list",
      "Numbered list",
      "To-do",
      "Heading",
      "Quote",
    ])
  })

  test("date rows carry the resolved date", () => {
    const [today, tomorrow] = slashMenuItems("", NOW)
    expect(today).toMatchObject({ kind: "date", date: "2026-09-08", detail: "Tue, Sep 8" })
    expect(tomorrow).toMatchObject({ kind: "date", date: "2026-09-09" })
  })

  test("filters by word prefix across both groups", () => {
    expect(labels(slashMenuItems("t", NOW))).toEqual(["Today", "Tomorrow", "Text", "To-do"])
    expect(labels(slashMenuItems("tom", NOW))).toEqual(["Tomorrow"])
    expect(labels(slashMenuItems("list", NOW))).toEqual(["Bullet list", "Numbered list"])
    expect(labels(slashMenuItems("week", NOW))).toEqual(["Next week", "Last week"])
  })

  test("keywords and hyphen-free spellings find block types", () => {
    expect(labels(slashMenuItems("task", NOW))).toEqual(["To-do"])
    expect(labels(slashMenuItems("todo", NOW))).toEqual(["To-do"])
    expect(labels(slashMenuItems("h1", NOW))).toEqual(["Heading"])
  })

  test("a phrase that resolves to a date adds a row for it", () => {
    const items = slashMenuItems("friday next week", NOW)
    expect(items).toEqual([
      {
        kind: "date",
        id: "date:parsed",
        label: "Fri, Sep 18",
        detail: "in 10 days",
        date: "2026-09-18",
      },
    ])
  })

  test("a fixed shortcut is not listed twice when the phrase resolves to it", () => {
    const items = slashMenuItems("today", NOW)
    expect(items.map((item) => item.id)).toEqual(["date:Today"])
  })

  test("prose matches nothing, so the menu closes", () => {
    expect(slashMenuItems("meeting notes", NOW)).toEqual([])
  })
})

describe("applySlashItem", () => {
  const tomorrow: SlashItem = {
    kind: "date",
    id: "date:Tomorrow",
    label: "Tomorrow",
    detail: "Wed, Sep 9",
    date: "2026-09-09",
  }
  const heading: SlashItem = {
    kind: "block",
    id: "block:heading",
    label: "Heading",
    type: "heading",
  }
  const text: SlashItem = { kind: "block", id: "block:paragraph", label: "Text", type: "paragraph" }

  test("a date replaces the /phrase and leaves the caret after it", () => {
    const result = applySlashItem(
      "- call mum /tom",
      "call mum /tom",
      { start: 9, query: "tom" },
      tomorrow,
    )
    expect(result).toEqual({ content: "- call mum 2026-09-09", caret: 19 })
  })

  test("text after the caret is kept", () => {
    const result = applySlashItem(
      "/tom and more",
      "/tom and more",
      { start: 0, query: "tom" },
      tomorrow,
    )
    expect(result).toEqual({ content: "2026-09-09 and more", caret: 10 })
  })

  test("a block type sets the marker and drops the /phrase", () => {
    const result = applySlashItem(
      "- plan /head",
      "plan /head",
      { start: 5, query: "head" },
      heading,
    )
    expect(result).toEqual({ content: "# plan ", caret: 5 })
  })

  test("Text strips the marker", () => {
    const result = applySlashItem("[ ] /text", "/text", { start: 0, query: "text" }, text)
    expect(result).toEqual({ content: "", caret: 0 })
  })
})
