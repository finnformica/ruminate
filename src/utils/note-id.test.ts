import { describe, expect, it } from "vitest"
import { isMintedNoteId } from "../data/page-identity"
import { generateNoteId } from "./note-id"

describe("generateNoteId", () => {
  it("mints an ordinary opaque block id", () => {
    // A page is a node like any other (docs/page-identity-design.md): one
    // minting path, one id space, no `pg_` sibling scheme.
    const id = generateNoteId()
    expect(id).toMatch(/^blk_[0-9a-z]{10}$/)
    expect(isMintedNoteId(id)).toBe(true)
  })

  it("mints a distinct id each time", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateNoteId()))
    expect(ids.size).toBe(100)
  })
})
