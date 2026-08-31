import { describe, expect, test } from "vitest"
import { isNoteEmpty, parseNote } from "./parse-note"

describe("parseNote", () => {
  test("extracts url from frontmatter", () => {
    const note = parseNote("1234", "---\nurl: https://example.com\n---\n# Title")
    expect(note.url).toBe("https://example.com")
  })

  test("extracts url from link in title", () => {
    const note = parseNote("1234", "# [Title](https://example.com)")
    expect(note.url).toBe("https://example.com")
  })

  test("frontmatter url takes priority over link in title", () => {
    const note = parseNote(
      "1234",
      "---\nurl: https://frontmatter.com\n---\n# [Title](https://title.com)",
    )
    expect(note.url).toBe("https://frontmatter.com")
  })

  test("stores task markdown and tags", () => {
    const tasks = parseNote("1234", "- [ ] Review the plan #ops").tasks

    expect(tasks).toEqual([
      {
        completed: false,
        text: "Review the plan #ops",
        tags: ["ops"],
        priority: null,
        startOffset: 0,
      },
    ])
  })

  test("emits nested subtasks", () => {
    const tasks = parseNote(
      "1234",
      `
- [ ] Parent review #parent
  - [ ] Child follow up #child
`,
    ).tasks

    expect(tasks).toEqual([
      {
        completed: false,
        text: "Parent review #parent",
        tags: ["parent"],
        priority: null,
        startOffset: 1, // After the leading newline
      },
      {
        completed: false,
        text: "Child follow up #child",
        tags: ["child"],
        priority: null,
        startOffset: 31, // After parent task + newline + 2 spaces for nesting
      },
    ])
  })

  test("treats [[wikilink]] syntax as literal text", () => {
    const note = parseNote("1234", "Some [[foo]] text and ![[bar]] too")

    // Untitled numeric-id notes preview their first words — brackets included,
    // because [[...]] is no longer syntax, just text.
    expect(note.displayName).toBe("Some [[foo]] text and ![[bar]] too")
    expect(note.tasks).toEqual([])
  })

  test("task text keeps [[...]] verbatim", () => {
    const tasks = parseNote("1234", "- [ ] Review [[project-alpha]] plan").tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].text).toBe("Review [[project-alpha]] plan")
  })

  test("parses aliases from frontmatter", () => {
    const note = parseNote("new-name", "---\naliases: [old-name, older-name]\n---\n# Title")
    expect(note.aliases).toEqual(["old-name", "older-name"])

    const noAliases = parseNote("1234", "# Title")
    expect(noAliases.aliases).toEqual([])

    const badAliases = parseNote("1234", "---\naliases: nope\n---\n# Title")
    expect(badAliases.aliases).toEqual([])
  })

  test("collects dates from frontmatter date properties", () => {
    const note = parseNote("1234", "---\ndue: 2026-01-05\n---\n# Title")
    expect(note.dates).toContain("2026-01-05")
  })
})

describe("isNoteEmpty", () => {
  test("returns true for empty string", () => {
    expect(isNoteEmpty({ markdown: "" })).toBe(true)
  })

  test("returns true for whitespace only", () => {
    expect(isNoteEmpty({ markdown: "   " })).toBe(true)
    expect(isNoteEmpty({ markdown: "\n\n" })).toBe(true)
  })

  test("returns false for note with title", () => {
    expect(isNoteEmpty({ markdown: "# Hello" })).toBe(false)
  })

  test("returns false for note with body", () => {
    expect(isNoteEmpty({ markdown: "Some content" })).toBe(false)
  })

  test("returns false for note with title and body", () => {
    expect(isNoteEmpty({ markdown: "# Title\n\nBody content" })).toBe(false)
  })

  test("returns false for note with visible frontmatter", () => {
    expect(isNoteEmpty({ markdown: "---\nauthor: John\n---\n" })).toBe(false)
  })

  test("returns true for note with only reserved frontmatter keys", () => {
    expect(isNoteEmpty({ markdown: "---\npinned: true\n---\n" })).toBe(true)
    expect(isNoteEmpty({ markdown: "---\ngist_id: abc123\n---\n" })).toBe(true)
    expect(isNoteEmpty({ markdown: "---\nfont: serif\n---\n" })).toBe(true)
    expect(isNoteEmpty({ markdown: "---\nwidth: full\n---\n" })).toBe(true)
  })

  test("returns true for note with empty array in frontmatter", () => {
    expect(isNoteEmpty({ markdown: "---\ntags: []\n---\n" })).toBe(true)
  })

  test("returns false for note with non-empty array in frontmatter", () => {
    expect(isNoteEmpty({ markdown: "---\ntags: [foo]\n---\n" })).toBe(false)
  })

  test("returns false for note with mixed reserved and visible frontmatter", () => {
    expect(isNoteEmpty({ markdown: "---\npinned: true\nauthor: John\n---\n" })).toBe(false)
  })

  test("returns true when hideFrontmatter is true and note has only frontmatter", () => {
    expect(isNoteEmpty({ markdown: "---\nauthor: John\n---\n", hideFrontmatter: true })).toBe(true)
  })

  test("returns false when hideFrontmatter is true but note has content", () => {
    expect(
      isNoteEmpty({ markdown: "---\nauthor: John\n---\nSome content", hideFrontmatter: true }),
    ).toBe(false)
  })
})
