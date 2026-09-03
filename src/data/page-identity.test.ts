import { describe, expect, it } from "vitest"
import {
  emittedPageTitle,
  injectTitleIntoFrontmatter,
  isDatePageId,
  liftTitleFromFrontmatter,
} from "./page-identity"

describe("the date carve-out", () => {
  it("recognizes date and week natural keys", () => {
    expect(isDatePageId("2026-08-31")).toBe(true)
    expect(isDatePageId("2026-W35")).toBe(true)
    expect(isDatePageId("Flow Engineering")).toBe(false)
    expect(isDatePageId("2026-13-99")).toBe(false)
  })
})

describe("the title's ride through the <id>.md seam", () => {
  it("lifts a title out of frontmatter and leaves the rest", () => {
    expect(liftTitleFromFrontmatter("title: Flow Engineering\npinned: true")).toEqual({
      title: "Flow Engineering",
      rest: "pinned: true",
    })
  })

  it("returns null frontmatter when the title was all there was", () => {
    // So a titled page with no other metadata stores `props` null.
    expect(liftTitleFromFrontmatter("title: Solo")).toEqual({ title: "Solo", rest: null })
  })

  it("leaves frontmatter alone when there is no title key", () => {
    expect(liftTitleFromFrontmatter("pinned: true")).toEqual({ title: null, rest: "pinned: true" })
    expect(liftTitleFromFrontmatter(null)).toEqual({ title: null, rest: null })
  })

  it("ignores a non-string title rather than mangling it", () => {
    expect(liftTitleFromFrontmatter("title: [a, b]")).toEqual({
      title: null,
      rest: "title: [a, b]",
    })
  })

  it("round-trips a title that YAML would otherwise misread", () => {
    for (const title of ["Q3: the plan", "true", "2026-08-31", "#hash", "", "a # b"]) {
      const injected = injectTitleIntoFrontmatter(null, title)
      expect(liftTitleFromFrontmatter(injected).title).toBe(title)
    }
  })

  it("injects the title as the first key, ahead of the stored props", () => {
    expect(injectTitleIntoFrontmatter("pinned: true", "Flow")).toBe("title: Flow\npinned: true")
    expect(injectTitleIntoFrontmatter(null, "Flow")).toBe("title: Flow")
  })

  it("emits no title for an untitled or date page", () => {
    // Both keep the exact bytes they had before minting existed.
    expect(emittedPageTitle("2026-08-31", "2026-08-31")).toBe(null)
    expect(emittedPageTitle("blk_aaaaaaaaaa", "blk_aaaaaaaaaa")).toBe(null)
    expect(emittedPageTitle("blk_aaaaaaaaaa", "")).toBe(null)
    expect(emittedPageTitle("blk_aaaaaaaaaa", "Flow")).toBe("Flow")
  })
})
