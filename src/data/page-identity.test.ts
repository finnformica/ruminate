import { describe, expect, it } from "vitest"
import { emittedPageTitle, isDatePageId } from "./page-identity"

describe("the date carve-out", () => {
  it("recognizes date and week natural keys", () => {
    expect(isDatePageId("2026-08-31")).toBe(true)
    expect(isDatePageId("2026-W35")).toBe(true)
    expect(isDatePageId("Flow Engineering")).toBe(false)
    expect(isDatePageId("2026-13-99")).toBe(false)
  })
})

describe("the title a page's doc carries", () => {
  it("emits no title for an untitled or date page", () => {
    // Both keep the exact bytes they had before minting existed.
    expect(emittedPageTitle("2026-08-31", "2026-08-31")).toBe(null)
    expect(emittedPageTitle("blk_aaaaaaaaaa", "blk_aaaaaaaaaa")).toBe(null)
    expect(emittedPageTitle("blk_aaaaaaaaaa", "")).toBe(null)
    expect(emittedPageTitle("blk_aaaaaaaaaa", "Flow")).toBe("Flow")
  })
})
