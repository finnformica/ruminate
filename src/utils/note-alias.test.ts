import { describe, expect, test } from "vitest"
import { Note, NoteId } from "../schema"
import { resolveNoteId } from "./note-alias"
import { parseNote } from "./parse-note"

function notesFrom(entries: Record<NoteId, string>): Map<NoteId, Note> {
  const notes = new Map<NoteId, Note>()
  for (const [id, content] of Object.entries(entries)) {
    notes.set(id, parseNote(id, content))
  }
  return notes
}

/** A note as the page-identity migration leaves it: minted id, former title as
 * both the title and an alias (see `pagePropsWithAlias`). */
const migrated = (title: string, ...aliases: string[]) =>
  `---\ntitle: ${title}\naliases: [${aliases.join(", ")}]\n---\nbody\n`

describe("resolveNoteId", () => {
  test("a live note resolves to itself", () => {
    const notes = notesFrom({ blk_aaaaaaaaaa: "# My note" })
    expect(resolveNoteId(notes, "blk_aaaaaaaaaa")).toBe("blk_aaaaaaaaaa")
  })

  test("a pre-minting title URL resolves to the note it became", () => {
    // The whole point: /notes/Flow Engineering was a real URL before ids were
    // minted, and it must still open the same note.
    const notes = notesFrom({ blk_flow000000: migrated("Flow Engineering", "Flow Engineering") })
    expect(resolveNoteId(notes, "Flow Engineering")).toBe("blk_flow000000")
  })

  test("an unknown id resolves to null (new-note editor path)", () => {
    const notes = notesFrom({ blk_aaaaaaaaaa: "# Some note" })
    expect(resolveNoteId(notes, "brand-new-idea")).toBe(null)
  })

  test("every former id stays resolvable when a note carries several aliases", () => {
    const notes = notesFrom({ blk_aaaaaaaaaa: migrated("Third", "first-name", "second-name") })

    expect(resolveNoteId(notes, "first-name")).toBe("blk_aaaaaaaaaa")
    expect(resolveNoteId(notes, "second-name")).toBe("blk_aaaaaaaaaa")
    expect(resolveNoteId(notes, "blk_aaaaaaaaaa")).toBe("blk_aaaaaaaaaa")
  })

  test("a live note wins over another note's alias claim", () => {
    const notes = notesFrom({
      blk_aaaaaaaaaa: migrated("Renamed", "taken"),
      taken: "# The real note at this id",
    })

    expect(resolveNoteId(notes, "taken")).toBe("taken")
  })
})
