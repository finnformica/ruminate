import { describe, expect, it } from "vitest"
import { clampExpandedLevels, defaultCollapsedKeys } from "./default-collapsed"
import { parse } from "./parse"
import { idOfKey } from "./view"

const doc = (markdown: string) => parse(markdown)

/** Map occurrence keys back to content so assertions read naturally. */
const collapsedContents = (markdown: string, levels?: number) => {
  const parsed = doc(markdown)
  return defaultCollapsedKeys(parsed, levels).map((key) => parsed.blocks[idOfKey(key)].text)
}

describe("defaultCollapsedKeys", () => {
  it("keeps a flat document fully expanded", () => {
    expect(collapsedContents("- a\n- b\n- c\n")).toEqual([])
  })

  it("keeps level-1 parents expanded and collapses level-2 parents", () => {
    const markdown = ["- root", "  - middle", "    - deep", "      - deeper", ""].join("\n")
    expect(collapsedContents(markdown)).toEqual(["middle", "deep"])
  })

  it("never collapses leaves, no matter how deep", () => {
    const markdown = ["- a", "  - b", "    - leaf", ""].join("\n")
    expect(collapsedContents(markdown)).toEqual(["b"])
  })

  it("always expands headings", () => {
    const markdown = [
      "- outer",
      "  - inner",
      "    # Deep heading",
      "      - under heading",
      "        - deeper",
      "          - deepest",
      "",
    ].join("\n")
    // `inner` is level 2 → collapsed. The heading itself stays expanded even
    // deeper, and it resets the level count for its subtree: `under heading`
    // is level 1 (expanded), `deeper` is level 2 (collapsed).
    expect(collapsedContents(markdown)).toEqual(["inner", "deeper"])
  })

  it("resets the level below every heading (top-level heading case)", () => {
    const markdown = ["# Section", "  - point", "    - detail", "      - minutiae", ""].join("\n")
    expect(collapsedContents(markdown)).toEqual(["detail"])
  })

  it("handles an empty document", () => {
    expect(defaultCollapsedKeys(doc(""))).toEqual([])
  })

  it("opens as many levels as asked, beneath the top and beneath every heading", () => {
    const markdown = [
      "- root",
      "  - middle",
      "    - deep",
      "      - deeper",
      "# Section",
      "  - point",
      "    - detail",
      "      - minutiae",
      "",
    ].join("\n")
    // One level: only the direct children show; every parent beneath folds
    // (a folded row's own children fold too, so opening it reveals one level).
    expect(collapsedContents(markdown, 1)).toEqual(["root", "middle", "deep", "point", "detail"])
    // Three levels: a parent three down folds.
    expect(collapsedContents(markdown, 3)).toEqual(["deep"])
    // Ten levels: nothing here is deep enough to fold.
    expect(collapsedContents(markdown, 10)).toEqual([])
  })

  it("clamps the preference to the slider's range", () => {
    expect(clampExpandedLevels(0)).toBe(1)
    expect(clampExpandedLevels(11)).toBe(10)
    expect(clampExpandedLevels(2.6)).toBe(3)
    expect(clampExpandedLevels("x")).toBe(2)
    expect(clampExpandedLevels(undefined)).toBe(2)
  })
})
