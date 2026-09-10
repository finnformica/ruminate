import { describe, expect, it } from "vitest"
import { defaultCollapsedKeys } from "./default-collapsed"
import { parse } from "./parse"
import { idOfKey } from "./view"

const doc = (markdown: string) => parse(markdown)

/** Map occurrence keys back to content so assertions read naturally. */
const collapsedContents = (markdown: string) => {
  const parsed = doc(markdown)
  return defaultCollapsedKeys(parsed).map((key) => parsed.blocks[idOfKey(key)].text)
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
})
