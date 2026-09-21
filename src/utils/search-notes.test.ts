import { describe, expect, test, vi } from "vitest"
vi.mock("../global-state", () => ({
  sortedNotesAtom: {},
  noteSearcherAtom: {},
}))
import { parseQuery } from "./search"
import { filterNotes, sortNotes, testNoteFilters } from "./search-notes"
import type { Note } from "../schema"

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "1",
    type: "note",
    displayName: "",
    props: {},
    title: "",
    updatedAt: null,
    dates: [],
    tasks: [],
    headings: [],
    text: "",
    ...overrides,
  }
}

describe("in: scope", () => {
  test("matches a note by id, or by its name (case-insensitively)", () => {
    const note = makeNote({ id: "n1", displayName: "Reading list", title: "Reading list" })
    const scope = (value: string) =>
      testNoteFilters([{ key: "in", values: [value], exclude: false }], note)
    expect(scope("n1")).toBe(true)
    expect(scope("reading LIST")).toBe(true)
    expect(scope("n2")).toBe(false)
    // A block id means nothing at note granularity.
    expect(scope("blk_abc")).toBe(false)
    expect(testNoteFilters([{ key: "in", values: ["n1"], exclude: true }], note)).toBe(false)
  })
})

describe("filtering", () => {
  test("matches by title, type, property, counts, dates, has and no filters", () => {
    const note = makeNote({
      type: "daily",
      title: "Title 1",
      props: { priority: "high" },
      tasks: [
        {
          completed: false,
          text: "do it",
          blockId: "blk",
        },
        {
          completed: true,
          text: "done",
          blockId: "blk",
        },
      ],
      dates: ["2021-01-01", "2021-01-03"],
    })

    expect(testNoteFilters([{ key: "id", values: [note.id], exclude: false }], note)).toBe(true)
    expect(testNoteFilters([{ key: "title", values: [note.title], exclude: false }], note)).toBe(
      true,
    )
    expect(testNoteFilters([{ key: "type", values: ["daily"], exclude: false }], note)).toBe(true)
    expect(testNoteFilters([{ key: "priority", values: ["high"], exclude: false }], note)).toBe(
      true,
    )

    expect(testNoteFilters([{ key: "dates", values: ["2"], exclude: false }], note)).toBe(true)
    expect(testNoteFilters([{ key: "tasks", values: [">=1"], exclude: false }], note)).toBe(true)

    expect(testNoteFilters([{ key: "date", values: [">=2021-01-02"], exclude: false }], note)).toBe(
      true,
    )

    expect(testNoteFilters([{ key: "has", values: ["dates"], exclude: false }], note)).toBe(true)
    expect(testNoteFilters([{ key: "no", values: ["dates"], exclude: false }], note)).toBe(false)

    expect(testNoteFilters([{ key: "priority", values: ["high"], exclude: true }], note)).toBe(
      false,
    )
  })

  test("AND semantics across multiple filters", () => {
    const note = makeNote({ props: { area: "work", status: "open" } })
    const filters = [
      { key: "area", values: ["work"], exclude: false },
      { key: "status", values: ["open"], exclude: false },
    ]
    expect(testNoteFilters(filters, note)).toBe(true)
  })

  test("filterNotes applies filters and removes non-matching notes", () => {
    const notes = [
      makeNote({ id: "1", props: { area: "work" } }),
      makeNote({ id: "2", props: { area: "home" } }),
      makeNote({ id: "3", props: { area: "work" } }),
    ]
    const filtered = filterNotes(notes, [{ key: "area", values: ["work"], exclude: false }])
    expect(filtered.map((n) => n.id)).toEqual(["1", "3"])
  })

  test("has and no on frontmatter keys consider presence not truthiness", () => {
    const note = makeNote({ props: { read: false } })
    expect(testNoteFilters([{ key: "has", values: ["read"], exclude: false }], note)).toBe(true)
    expect(testNoteFilters([{ key: "no", values: ["read"], exclude: false }], note)).toBe(false)
  })

  test("has and no for title respect empty string and non-empty", () => {
    const emptyTitle = makeNote({ title: "" })
    const withTitle = makeNote({ title: "Hello" })
    expect(testNoteFilters([{ key: "no", values: ["title"], exclude: false }], emptyTitle)).toBe(
      true,
    )
    expect(testNoteFilters([{ key: "has", values: ["title"], exclude: false }], emptyTitle)).toBe(
      false,
    )
    expect(testNoteFilters([{ key: "has", values: ["title"], exclude: false }], withTitle)).toBe(
      true,
    )
  })

  test("AND with exclusion allows include and exclude combinations", () => {
    const workOnly = makeNote({ id: "1", props: { area: "work" } })
    const workDone = makeNote({ id: "2", props: { area: "work", status: "done" } })
    const filters = [
      { key: "area", values: ["work"], exclude: false },
      { key: "status", values: ["done"], exclude: true },
    ]
    expect(testNoteFilters(filters, workOnly)).toBe(true)
    expect(testNoteFilters(filters, workDone)).toBe(false)
  })

  test("task count filters match incomplete task counts with range operators", () => {
    const note = makeNote({
      tasks: [
        {
          completed: false,
          text: "x",
          blockId: "blk",
        },
      ],
    })
    expect(testNoteFilters([{ key: "tasks", values: ["0"], exclude: false }], note)).toBe(false)
    expect(testNoteFilters([{ key: "tasks", values: ["<=1"], exclude: false }], note)).toBe(true)
  })
})

describe("sorting", () => {
  test("sorts by a property desc then id asc with punctuation and case ignored", () => {
    const notes = [
      makeNote({ id: "note-2", displayName: "A-2", props: { priority: 1 } }),
      makeNote({ id: "note 10", displayName: "A-1", props: { priority: 2 } }),
      makeNote({ id: "note-1", displayName: "A-1", props: { priority: 0 } }),
    ]
    const sorted = sortNotes(notes, [
      { key: "priority", direction: "desc" },
      { key: "id", direction: "asc" },
    ])
    expect(sorted.map((n) => n.id)).toEqual(["note 10", "note-2", "note-1"])
  })

  test("title sort ignores punctuation and case (asc) with id tiebreaker", () => {
    const notes = [
      makeNote({ id: "1", displayName: "B-2" }),
      makeNote({ id: "2", displayName: "A 1" }),
      makeNote({ id: "3", displayName: "A-1" }),
    ]
    const sorted = sortNotes(notes, [
      { key: "title", direction: "asc" },
      { key: "id", direction: "asc" },
    ])
    expect(sorted.map((n) => n.id)).toEqual(["2", "3", "1"]) // A(1) then B(2)
  })

  test("unknown sort key is ignored and next sort applies", () => {
    const notes = [makeNote({ id: "2", displayName: "A" }), makeNote({ id: "1", displayName: "A" })]
    const sorted = sortNotes(notes, [
      { key: "unknown", direction: "desc" },
      { key: "id", direction: "asc" },
    ])
    expect(sorted.map((n) => n.id)).toEqual(["1", "2"])
  })

  test("numeric collation sorts ids with embedded numbers in natural order", () => {
    const notes = [
      makeNote({ id: "note 2", displayName: "X" }),
      makeNote({ id: "note 10", displayName: "X" }),
      makeNote({ id: "note 1", displayName: "X" }),
    ]
    const sorted = sortNotes(notes, [{ key: "id", direction: "asc" }])
    expect(sorted.map((n) => n.id)).toEqual(["note 1", "note 2", "note 10"])
  })
})

describe("integration: parse + filter + sort", () => {
  test("filters by a property and sorts by title asc with punctuation ignored", () => {
    const notes = [
      makeNote({ id: "1", displayName: "B--", props: { area: "work" } }),
      makeNote({ id: "2", displayName: "A!!", props: { area: "work" } }),
      makeNote({ id: "3", displayName: "C??", props: { area: "home" } }),
    ]
    const { filters, sorts } = parseQuery("area:work sort:title")
    const filtered = filterNotes(notes, filters)
    const sorted = sortNotes(filtered, sorts)
    expect(sorted.map((n) => n.id)).toEqual(["2", "1"]) // A before B
  })

  test("exclusion filter excludes notes with a matching property", () => {
    const notes = [makeNote({ id: "1", props: { area: "work" } }), makeNote({ id: "2" })]
    const { filters } = parseQuery("-area:work")
    const filtered = filterNotes(notes, filters)
    expect(filtered.map((n) => n.id)).toEqual(["2"])
  })

  test("sort by updated_at defaults to desc (most recent first)", () => {
    const notes = [
      makeNote({ id: "1", updatedAt: 1000 }),
      makeNote({ id: "2", updatedAt: 3000 }),
      makeNote({ id: "3", updatedAt: 2000 }),
      makeNote({ id: "4", updatedAt: null }), // null = infinitely old, sorts to end in desc
    ]
    const { sorts } = parseQuery("sort:updated_at")
    const sorted = sortNotes(notes, sorts)
    expect(sorted.map((n) => n.id)).toEqual(["2", "3", "1", "4"])
  })

  test("sort by updated_at asc puts null (oldest) first", () => {
    const notes = [
      makeNote({ id: "1", updatedAt: 1000 }),
      makeNote({ id: "2", updatedAt: 3000 }),
      makeNote({ id: "3", updatedAt: null }), // null = infinitely old, sorts to start in asc
    ]
    const { sorts } = parseQuery("sort:updated_at:asc")
    const sorted = sortNotes(notes, sorts)
    expect(sorted.map((n) => n.id)).toEqual(["3", "1", "2"])
  })

  test("sort by arbitrary frontmatter key (numeric)", () => {
    const notes = [
      makeNote({ id: "1", props: { priority: 3 } }),
      makeNote({ id: "2", props: { priority: 1 } }),
      makeNote({ id: "3", props: {} }), // missing key sorts to end
      makeNote({ id: "4", props: { priority: 2 } }),
    ]
    const { sorts } = parseQuery("sort:priority")
    const sorted = sortNotes(notes, sorts)
    expect(sorted.map((n) => n.id)).toEqual(["2", "4", "1", "3"])
  })

  test("sort by arbitrary frontmatter key (string)", () => {
    const notes = [
      makeNote({ id: "1", props: { status: "draft" } }),
      makeNote({ id: "2", props: { status: "published" } }),
      makeNote({ id: "3", props: { status: "archived" } }),
    ]
    const { sorts } = parseQuery("sort:status")
    const sorted = sortNotes(notes, sorts)
    expect(sorted.map((n) => n.id)).toEqual(["3", "1", "2"]) // archived, draft, published
  })
})
