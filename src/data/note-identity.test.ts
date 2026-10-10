import { describe, expect, it } from "vitest"
import { emittedNoteTitle } from "./note-identity"

describe("the title a note's doc carries", () => {
  it("emits no title for an untitled note", () => {
    // An untitled note keeps the exact bytes it had before minting existed.
    expect(emittedNoteTitle("blk_aaaaaaaaaa", "blk_aaaaaaaaaa")).toBe(null)
    expect(emittedNoteTitle("blk_aaaaaaaaaa", "")).toBe(null)
    expect(emittedNoteTitle("blk_aaaaaaaaaa", "Flow")).toBe("Flow")
  })
})
