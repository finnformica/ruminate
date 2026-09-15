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

  it("folds headings like any other parent", () => {
    const markdown = [
      "- outer",
      "  - inner",
      "    # Deep heading",
      "      - under heading",
      "        - deeper",
      "",
    ].join("\n")
    // `inner` is level 2 → collapsed, and so are the heading at level 3 and
    // the parent beneath it: a heading has no special standing in the count,
    // and does not restart it.
    expect(collapsedContents(markdown)).toEqual(["inner", "Deep heading", "under heading"])
  })

  it("shows the headings and folds the lists beneath them (heading, sub-heading, list)", () => {
    const markdown = [
      "# Week",
      "  ## Monday",
      "    - [ ] todo",
      "    - point",
      "      - detail",
      "",
    ].join("\n")
    // Two levels: the top heading (level 1) opens, the sub-heading (level 2)
    // folds, so the note opens as its two rows of headings and nothing else.
    // `point` (level 3) folds too, so unfolding the sub-heading reveals one
    // level at a time.
    expect(collapsedContents(markdown)).toEqual(["Monday", "point"])
    // Three levels: the lists show, and only `point` (level 3) folds.
    expect(collapsedContents(markdown, 3)).toEqual(["point"])
  })

  it("handles an empty document", () => {
    expect(defaultCollapsedKeys(doc(""))).toEqual([])
  })

  it("opens as many levels as asked, counted from the top of the note", () => {
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
    // One level: only the top-level rows show; every parent beneath folds
    // (a folded row's own children fold too, so opening it reveals one level).
    expect(collapsedContents(markdown, 1)).toEqual([
      "root",
      "middle",
      "deep",
      "Section",
      "point",
      "detail",
    ])
    // Three levels: a parent three down folds, under a heading as anywhere.
    expect(collapsedContents(markdown, 3)).toEqual(["deep", "detail"])
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
