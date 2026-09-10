// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const writeNotes = vi.fn()
vi.mock("../data/store", () => ({
  useWriteNotes: () => writeNotes,
  useDeleteNoteFile: () => vi.fn(),
  useGetNoteContents: () => () => ({}),
}))

import { useRenameNote } from "./note"

/**
 * Renaming, since page ids are minted and opaque
 * (docs/page-identity-design.md), is setting one property — not the id
 * surgery it used to be. These pin that contract at the seam the UI calls.
 */
describe("useRenameNote", () => {
  beforeEach(() => writeNotes.mockClear())

  const rename = (params: { noteId: string; newTitle: string; content: string }) => {
    const { result } = renderHook(() => useRenameNote())
    return result.current(params)
  }

  it("writes the new title under the SAME id, and deletes nothing", () => {
    const changed = rename({
      noteId: "blk_page00000",
      newTitle: "New Name",
      content: "---\ntitle: Old Name\n---\nbody\n",
    })

    expect(changed).toBe(true)
    expect(writeNotes).toHaveBeenCalledTimes(1)
    const [updates] = writeNotes.mock.calls[0] as [Record<string, string | null>]
    // One key, the note's own id: no second write under a new name and no
    // `null` retiring the old one — so no URL breaks and nothing is resurrected.
    expect(Object.keys(updates)).toEqual(["blk_page00000"])
    expect(updates.blk_page00000).toContain("title: New Name")
    expect(updates.blk_page00000).toContain("body")
  })

  it("titles a note that had none", () => {
    rename({ noteId: "blk_page00000", newTitle: "First Name", content: "body\n" })
    const [updates] = writeNotes.mock.calls[0] as [Record<string, string>]
    expect(updates.blk_page00000).toContain("title: First Name")
  })

  it("accepts titles the old filename charset forbade", () => {
    // The point of separating identity from name.
    for (const title of ["Q3: the plan", "What? [draft]", "a|b#c"]) {
      writeNotes.mockClear()
      rename({ noteId: "blk_page00000", newTitle: title, content: "body\n" })
      expect(writeNotes).toHaveBeenCalledTimes(1)
    }
  })

  it("clears the key when the title is emptied, rather than storing an empty one", () => {
    rename({
      noteId: "blk_page00000",
      newTitle: "   ",
      content: "---\ntitle: Old Name\n---\nbody\n",
    })
    const [updates] = writeNotes.mock.calls[0] as [Record<string, string>]
    expect(updates.blk_page00000).not.toContain("title:")
  })

  it("does nothing when the title is unchanged", () => {
    expect(
      rename({
        noteId: "blk_page00000",
        newTitle: "  Same  ",
        content: "---\ntitle: Same\n---\nbody\n",
      }),
    ).toBe(false)
    expect(writeNotes).not.toHaveBeenCalled()
  })
})
