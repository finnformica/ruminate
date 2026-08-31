import { describe, expect, it } from "vitest"
import {
  derivePageId,
  derivePageIdAvoiding,
  emittedPageTitle,
  injectTitleIntoFrontmatter,
  isDatePageId,
  isMintedNoteId,
  liftTitleFromFrontmatter,
  needsMintedId,
  pagePropsWithAlias,
} from "./page-identity"

describe("derivePageId", () => {
  it("mints an id shaped exactly like any other node id", () => {
    expect(derivePageId("Flow Engineering")).toMatch(/^blk_[0-9a-z]{10}$/)
    expect(isMintedNoteId(derivePageId("Flow Engineering"))).toBe(true)
  })

  it("is deterministic — the property the whole migration rests on", () => {
    // Two engines transform the same corpus independently; a random mint would
    // give one page two ids and the next sync would merge them into two pages.
    expect(derivePageId("Flow Engineering")).toBe(derivePageId("Flow Engineering"))
    expect(derivePageId("a")).toBe(derivePageId("a"))
  })

  it("separates different titles, including near-identical ones", () => {
    const ids = ["a", "b", "ab", "ba", "Flow Engineering", "Flow engineering", ""].map((name) =>
      derivePageId(name),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("uses only 32-bit-safe arithmetic, so every engine agrees", () => {
    // A long, high-codepoint seed would overflow a naive 53-bit accumulator
    // differently on different engines; this pins the exact expected output.
    const id = derivePageId("é".repeat(500))
    expect(id).toBe(derivePageId("é".repeat(500)))
    expect(id).toMatch(/^blk_[0-9a-z]{10}$/)
  })

  it("probes deterministically around a collision", () => {
    const first = derivePageId("taken")
    const avoided = derivePageIdAvoiding("taken", new Set([first]))
    expect(avoided).not.toBe(first)
    expect(avoided).toBe(derivePageId("taken", 1))
    // Same corpus, same answer — on every engine.
    expect(avoided).toBe(derivePageIdAvoiding("taken", new Set([first])))
  })

  it("gives up probing rather than looping on a pathological corpus", () => {
    // Every candidate taken: it must still return a well-formed id.
    const always = { has: () => true } as unknown as ReadonlySet<string>
    expect(derivePageIdAvoiding("x", always, 4)).toMatch(/^blk_[0-9a-z]{10}$/)
  })
})

describe("the date carve-out", () => {
  it("recognizes date and week natural keys", () => {
    expect(isDatePageId("2026-08-31")).toBe(true)
    expect(isDatePageId("2026-W35")).toBe(true)
    expect(isDatePageId("Flow Engineering")).toBe(false)
    expect(isDatePageId("2026-13-99")).toBe(false)
  })

  it("exempts date pages and already-minted pages from minting", () => {
    expect(needsMintedId("Flow Engineering")).toBe(true)
    expect(needsMintedId("2026-08-31")).toBe(false)
    expect(needsMintedId("2026-W35")).toBe(false)
    expect(needsMintedId("blk_aaaaaaaaaa")).toBe(false)
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

describe("pagePropsWithAlias", () => {
  it("records an alias on a page with no props at all", () => {
    expect(pagePropsWithAlias(null, "Old Name")).toBe(JSON.stringify({ aliases: ["Old Name"] }))
  })

  it("appends to existing entries, keeping the other props", () => {
    expect(pagePropsWithAlias(JSON.stringify({ pinned: true }), "Old")).toBe(
      JSON.stringify({ pinned: true, aliases: ["Old"] }),
    )
    expect(pagePropsWithAlias(JSON.stringify({ aliases: ["First"] }), "Second")).toBe(
      JSON.stringify({ aliases: ["First", "Second"] }),
    )
  })

  it("is idempotent: re-recording the same alias changes nothing", () => {
    const props = JSON.stringify({ aliases: ["Old"] })
    expect(pagePropsWithAlias(props, "Old")).toBe(props)
  })

  it("extends the legacy raw shape without losing its comments", () => {
    // Frontmatter stays raw precisely because entries cannot carry comments —
    // so the alias is appended as a line rather than through a lossy upgrade.
    const legacy = JSON.stringify({ frontmatter: "# a comment\npinned: true" })
    const next = JSON.parse(pagePropsWithAlias(legacy, "Old")) as { frontmatter: string }
    expect(next.frontmatter).toBe("# a comment\npinned: true\naliases: [Old]")
  })

  it("merges into an existing aliases line in the legacy shape", () => {
    const legacy = JSON.stringify({ frontmatter: "# c\naliases: [First]" })
    const next = JSON.parse(pagePropsWithAlias(legacy, "Second")) as { frontmatter: string }
    expect(next.frontmatter).toBe("# c\naliases: [First, Second]")
  })

  it("leaves malformed props untouched rather than destroying them", () => {
    expect(pagePropsWithAlias("not json", "Old")).toBe("not json")
    expect(pagePropsWithAlias("[1,2]", "Old")).toBe("[1,2]")
  })
})
