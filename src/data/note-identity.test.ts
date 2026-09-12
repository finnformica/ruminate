import { describe, expect, it } from "vitest"
import { emittedNoteTitle, isDateNoteId } from "./note-identity"

describe("the date carve-out", () => {
  it("recognizes date and week natural keys", () => {
    expect(isDateNoteId("2026-08-31")).toBe(true)
    expect(isDateNoteId("2026-W35")).toBe(true)
    expect(isDateNoteId("Flow Engineering")).toBe(false)
    expect(isDateNoteId("2026-13-99")).toBe(false)
  })
})

describe("the title a note's doc carries", () => {
  it("emits no title for an untitled or date note", () => {
    // Both keep the exact bytes they had before minting existed.
    expect(emittedNoteTitle("2026-08-31", "2026-08-31")).toBe(null)
    expect(emittedNoteTitle("blk_aaaaaaaaaa", "blk_aaaaaaaaaa")).toBe(null)
    expect(emittedNoteTitle("blk_aaaaaaaaaa", "")).toBe(null)
    expect(emittedNoteTitle("blk_aaaaaaaaaa", "Flow")).toBe("Flow")
  })
})
