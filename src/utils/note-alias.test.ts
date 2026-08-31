import { describe, expect, test } from "vitest"
import { Note, NoteId } from "../schema"
import { recordRenameAlias, resolveNoteId } from "./note-alias"
import { parseFrontmatter } from "./frontmatter"
import { parseNote } from "./parse-note"

function notesFrom(entries: Record<NoteId, string>): Map<NoteId, Note> {
  const notes = new Map<NoteId, Note>()
  for (const [id, content] of Object.entries(entries)) {
    notes.set(id, parseNote(id, content))
  }
  return notes
}

describe("recordRenameAlias", () => {
  test("records the old id in aliases frontmatter", () => {
    const content = recordRenameAlias({ content: "# Title\n\nBody", oldId: "old-name" })
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.aliases).toEqual(["old-name"])
    expect(content).toContain("# Title")
  })

  test("renaming twice chains — aliases accumulate", () => {
    let content = "# Title"
    content = recordRenameAlias({ content, oldId: "first-name" })
    content = recordRenameAlias({ content, oldId: "second-name" })
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.aliases).toEqual(["first-name", "second-name"])
  })

  test("does not duplicate an already-recorded alias", () => {
    let content = recordRenameAlias({ content: "# Title", oldId: "old-name" })
    content = recordRenameAlias({ content, oldId: "old-name" })
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.aliases).toEqual(["old-name"])
  })

  test("preserves existing frontmatter", () => {
    const content = recordRenameAlias({
      content: "---\npinned: true\n---\n# Title",
      oldId: "old-name",
    })
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.pinned).toBe(true)
    expect(frontmatter.aliases).toEqual(["old-name"])
  })
})

describe("resolveNoteId", () => {
  test("a live note resolves to itself", () => {
    const notes = notesFrom({ "my-note": "# My note" })
    expect(resolveNoteId(notes, "my-note")).toBe("my-note")
  })

  test("rename: the old id resolves to the renamed note (redirect path)", () => {
    // Simulate a rename of "old-name" → "new-name"
    const renamed = recordRenameAlias({ content: "# Title", oldId: "old-name" })
    const notes = notesFrom({ "new-name": renamed })

    expect(resolveNoteId(notes, "old-name")).toBe("new-name")
  })

  test("an unknown id resolves to null (new-note editor path)", () => {
    const notes = notesFrom({ "some-note": "# Some note" })
    expect(resolveNoteId(notes, "brand-new-idea")).toBe(null)
  })

  test("a rename chain keeps every former id resolvable", () => {
    let content = "# Title"
    content = recordRenameAlias({ content, oldId: "first-name" })
    content = recordRenameAlias({ content, oldId: "second-name" })
    const notes = notesFrom({ "third-name": content })

    expect(resolveNoteId(notes, "first-name")).toBe("third-name")
    expect(resolveNoteId(notes, "second-name")).toBe("third-name")
    expect(resolveNoteId(notes, "third-name")).toBe("third-name")
  })

  test("a live note wins over another note's alias claim", () => {
    // "taken" is an alias of "renamed", but a real note now exists at "taken"
    const renamed = recordRenameAlias({ content: "# Renamed", oldId: "taken" })
    const notes = notesFrom({
      renamed,
      taken: "# The real note at this id",
    })

    expect(resolveNoteId(notes, "taken")).toBe("taken")
  })
})
