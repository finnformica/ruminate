import { describe, expect, it } from "vitest"
import { canonicalFrontmatterYaml } from "../utils/frontmatter"
import {
  frontmatterTextFromProps,
  pagePropsFromFrontmatter,
  upgradedPageProps,
} from "./frontmatter-props"

/** The full raw→props→rollup-text pipeline for one frontmatter text. */
const roundTrip = (raw: string) => frontmatterTextFromProps(pagePropsFromFrontmatter(raw))

describe("pagePropsFromFrontmatter — parsed entries", () => {
  it("stores individual parsed entries, not the legacy raw blob", () => {
    expect(pagePropsFromFrontmatter("pinned: true\ngist_id: abc123")).toBe(
      JSON.stringify({ pinned: true, gist_id: "abc123" }),
    )
  })

  it("parses tags arrays and preserves key order", () => {
    expect(pagePropsFromFrontmatter("tags: [work, home]\ntitle: My note")).toBe(
      JSON.stringify({ tags: ["work", "home"], title: "My note" }),
    )
  })

  it("stores the save stamp's ISO datetime as a string entry", () => {
    expect(pagePropsFromFrontmatter("updated_at: 2026-08-31T09:30:00.000Z")).toBe(
      JSON.stringify({ updated_at: "2026-08-31T09:30:00.000Z" }),
    )
  })

  it("empty frontmatter is an empty entries object", () => {
    expect(pagePropsFromFrontmatter("")).toBe("{}")
  })
})

describe("pagePropsFromFrontmatter — legacy fallback (verbatim beats lossy)", () => {
  const legacy = (raw: string) => JSON.stringify({ frontmatter: raw })

  it("unparseable YAML stays raw", () => {
    const raw = ":\n  - ]broken["
    expect(pagePropsFromFrontmatter(raw)).toBe(legacy(raw))
  })

  it("non-map YAML (scalar, list) stays raw", () => {
    expect(pagePropsFromFrontmatter("just a sentence")).toBe(legacy("just a sentence"))
    expect(pagePropsFromFrontmatter("- a\n- b")).toBe(legacy("- a\n- b"))
  })

  it("comments stay raw — entries cannot carry them (template frontmatter uses them)", () => {
    const wholeLine = "# choose a mood\nmood: happy"
    expect(pagePropsFromFrontmatter(wholeLine)).toBe(legacy(wholeLine))
    const inline = "mood: happy # or sad"
    expect(pagePropsFromFrontmatter(inline)).toBe(legacy(inline))
  })

  it("a quoted # is not a comment and parses normally", () => {
    expect(pagePropsFromFrontmatter('title: "my #tag note"')).toBe(
      JSON.stringify({ title: "my #tag note" }),
    )
  })

  it("whitespace-only frontmatter stays raw (no silent byte shrink)", () => {
    expect(pagePropsFromFrontmatter("  ")).toBe(legacy("  "))
  })

  it("a single `frontmatter:` string key stays raw — it would collide with the legacy shape", () => {
    const raw = "frontmatter: sneaky"
    expect(pagePropsFromFrontmatter(raw)).toBe(legacy(raw))
  })
})

describe("frontmatterTextFromProps — both shapes roll up", () => {
  it("parsed entries emit canonical YAML", () => {
    expect(frontmatterTextFromProps(JSON.stringify({ pinned: true, tags: ["a", "b"] }))).toBe(
      "pinned: true\ntags: [a, b]",
    )
  })

  it("the legacy raw blob emits verbatim (rows from older app versions)", () => {
    expect(frontmatterTextFromProps(JSON.stringify({ frontmatter: "anything: at all # !" }))).toBe(
      "anything: at all # !",
    )
  })

  it("null and malformed props emit nothing", () => {
    expect(frontmatterTextFromProps(null)).toBeNull()
    expect(frontmatterTextFromProps("{not json")).toBeNull()
    expect(frontmatterTextFromProps('"a string"')).toBeNull()
    expect(frontmatterTextFromProps("[1, 2]")).toBeNull()
  })
})

describe("upgradedPageProps — the data_version transform's props step", () => {
  it("upgrades a legacy raw blob to parsed entries", () => {
    expect(upgradedPageProps(JSON.stringify({ frontmatter: "pinned: true" }))).toBe(
      JSON.stringify({ pinned: true }),
    )
  })

  it("returns null when nothing changes (already entries, degenerate raw, no props)", () => {
    expect(upgradedPageProps(JSON.stringify({ pinned: true }))).toBeNull()
    expect(upgradedPageProps(JSON.stringify({ frontmatter: "# comment only" }))).toBeNull()
    expect(upgradedPageProps(null)).toBeNull()
    expect(upgradedPageProps("{not json")).toBeNull()
  })
})

describe("canonical YAML — parse(serialize(entries)) is a fixpoint", () => {
  it("typical note frontmatter is byte-stable through the pipeline", () => {
    for (const raw of [
      "pinned: true",
      "updated_at: 2026-01-02T03:04:05.000Z",
      "gist_id: 0a1b2c3d",
      "tags: [alpha, beta/gamma]",
      "title: My great note",
      "width: wide\nfont: serif",
      "pinned: true\nupdated_at: 2026-01-02T03:04:05.000Z\ntags: [a]",
      "count: 7\nratio: -3.5",
      "empty: null",
      'quoted: "2026-01-02"',
      'listy: "[not, a, list]"',
      "template: {name: Daily note}",
    ]) {
      expect(roundTrip(raw), raw).toBe(raw)
    }
  })

  it("canonicalization is a one-step convergence for reformatted YAML", () => {
    for (const raw of [
      "nested:\n  - x\n  - 'y: z'", // block list → flow, single-quote → double
      "template:\n  name: Daily", // block map → flow
      "spaced:    lots", // value spacing collapses
      "date_only: 2026-01-02", // unquoted date-only → quoted ISO string of the parsed Date
    ]) {
      const once = roundTrip(raw) as string
      expect(once).not.toBeNull()
      // The canonical form is a strict fixpoint from then on.
      expect(roundTrip(once), raw).toBe(once)
    }
  })

  it("property: generated entries survive serialize→parse→serialize byte-stably", () => {
    // Deterministic PRNG so failures reproduce.
    const mulberry32 = (seed: number) => () => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const rand = mulberry32(20260831)
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]

    const scalars: unknown[] = [
      "plain",
      "two words",
      "with: colon",
      "#hash",
      "- dash",
      "2026-01-02",
      "2026-01-02T03:04:05.000Z",
      "true",
      "007",
      "",
      "café 🌱",
      "[brackets]",
      "a, b",
      "line\nbreak",
      true,
      false,
      null,
      0,
      42,
      -3.5,
    ]
    const value = (depth: number): unknown => {
      const r = rand()
      if (depth < 2 && r < 0.15) {
        return Array.from({ length: Math.floor(rand() * 4) }, () => value(depth + 1))
      }
      if (depth < 2 && r < 0.25) {
        const entries: Record<string, unknown> = {}
        for (let i = Math.floor(rand() * 3); i > 0; i -= 1) entries[`k${i}`] = value(depth + 1)
        return entries
      }
      return pick(scalars)
    }

    for (let i = 0; i < 300; i += 1) {
      const entries: Record<string, unknown> = {}
      for (let k = 1 + Math.floor(rand() * 5); k > 0; k -= 1) {
        entries[pick(["title", "tags", "updated_at", "pinned", `key${k}`, "weird-key"])] = value(0)
      }
      const yamlText = canonicalFrontmatterYaml(entries)
      // Byte fixpoint through the whole props pipeline.
      const props = pagePropsFromFrontmatter(yamlText)
      expect(frontmatterTextFromProps(props), `seed entries ${i}: ${yamlText}`).toBe(yamlText)
    }
  })
})
