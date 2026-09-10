import { describe, expect, it } from "vitest"
import { normalizeBlockText } from "./normalize-block-text"

/**
 * The near-miss pattern set is deliberately conservative — every recognized
 * spelling AND every documented refusal is pinned here, with the reasoning
 * for each call (see the module header in normalize-block-text.ts).
 */
describe("normalizeBlockText — recognized near-misses", () => {
  it("[] shorthand todo (the canonical marker is `[ ] `)", () => {
    expect(normalizeBlockText("[] buy milk")).toEqual({ type: "todo", text: "buy milk" })
  })

  it("[X] uppercase done (the canonical marker is `[x] `)", () => {
    expect(normalizeBlockText("[X] done thing")).toEqual({ type: "done", text: "done thing" })
  })

  it("* and + CommonMark bullets (the canonical marker is `- `)", () => {
    expect(normalizeBlockText("* item")).toEqual({ type: "ul", text: "item" })
    expect(normalizeBlockText("+ item")).toEqual({ type: "ul", text: "item" })
  })

  it("paren-delimited ordered markers (`2)` — the canonical form is `N. ` at run position)", () => {
    expect(normalizeBlockText("2) item")).toEqual({ type: "ol", text: "item" })
    expect(normalizeBlockText("1) item")).toEqual({ type: "ol", text: "item" })
  })

  it("zero-padded, zero, and out-of-run dot ordered markers", () => {
    expect(normalizeBlockText("01. item")).toEqual({ type: "ol", text: "item" })
    expect(normalizeBlockText("0. item")).toEqual({ type: "ol", text: "item" })
    // `7. x` reaches the normalizer only when 7 isn't the run position —
    // classifyLine in graph.ts types run-position markers first.
    expect(normalizeBlockText("7. item")).toEqual({ type: "ol", text: "item" })
    expect(normalizeBlockText("999. item")).toEqual({ type: "ol", text: "item" })
  })

  it("keeps the rest of the line verbatim (only the marker is consumed)", () => {
    expect(normalizeBlockText("[] a  b\tc")).toEqual({ type: "todo", text: "a  b\tc" })
    expect(normalizeBlockText("* [not a todo] text")).toEqual({
      type: "ul",
      text: "[not a todo] text",
    })
  })
})

describe("normalizeBlockText — documented refusals (ambiguous stays text)", () => {
  it("a block starting with [link] text — brackets around prose, not a checkbox", () => {
    expect(normalizeBlockText("[link] to somewhere")).toBeNull()
    expect(normalizeBlockText("[2026] year in review")).toBeNull()
  })

  it("bare [] with no content — nothing to check off, could be empty brackets in prose", () => {
    expect(normalizeBlockText("[]")).toBeNull()
    expect(normalizeBlockText("[] ")).toBeNull()
    expect(normalizeBlockText("[x]")).toBeNull()
  })

  it("tight markers without the separating space — `[x]marks` and `*emphasis*` are prose", () => {
    expect(normalizeBlockText("[x]tight")).toBeNull()
    expect(normalizeBlockText("[]tight")).toBeNull()
    expect(normalizeBlockText("*emphasis* start")).toBeNull()
    expect(normalizeBlockText("**bold** start")).toBeNull()
    expect(normalizeBlockText("2)tight")).toBeNull()
  })

  it("#heading without a space — indistinguishable from the app's #tag syntax", () => {
    expect(normalizeBlockText("#Heading")).toBeNull()
    expect(normalizeBlockText("#tag and prose")).toBeNull()
    expect(normalizeBlockText("##nospace")).toBeNull()
  })

  it("4+ digit ordered markers — `1990. ` starting a sentence is prose, and the ol type would discard the number", () => {
    expect(normalizeBlockText("1990. That was the year")).toBeNull()
    expect(normalizeBlockText("10000. item")).toBeNull()
  })

  it("+/- signs in prose — `+1`, `-3`, and dash-without-space stay text", () => {
    expect(normalizeBlockText("+1 to that")).toBeNull()
    expect(normalizeBlockText("-lite variant")).toBeNull()
    expect(normalizeBlockText("- canonical bullet")).toBeNull() // canonical: classifyLine's job
  })

  it("code-ish content — fences, indent-free operators, wiki syntax", () => {
    expect(normalizeBlockText("```js")).toBeNull()
    expect(normalizeBlockText("x * y")).toBeNull()
    expect(normalizeBlockText("[[wikilink]] text")).toBeNull()
    expect(normalizeBlockText("((blk_ref)) text")).toBeNull()
  })

  it("markers separated by a tab or double space — not the single-space canonical shape", () => {
    expect(normalizeBlockText("[]\ttab")).toBeNull()
    expect(normalizeBlockText("[]  double space")).toBeNull()
    expect(normalizeBlockText("*\ttab")).toBeNull()
  })

  it("canonical spellings — classifyLine already types them, the normalizer must not", () => {
    expect(normalizeBlockText("[ ] open")).toBeNull()
    expect(normalizeBlockText("[x] done")).toBeNull()
    expect(normalizeBlockText("> quote")).toBeNull()
    expect(normalizeBlockText("# Heading")).toBeNull()
    expect(normalizeBlockText("plain text")).toBeNull()
    expect(normalizeBlockText("")).toBeNull()
  })
})
