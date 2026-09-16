import { describe, expect, it } from "vitest"
import { clampExpandedLevels, collapsedKeysOf, expandedByDepth } from "./default-collapsed"
import { parse } from "./parse"
import { idOfKey } from "./view"

const doc = (markdown: string) => parse(markdown)

/** Map occurrence keys back to content so assertions read naturally. */
const collapsedContents = (markdown: string, levels?: number) => {
  const parsed = doc(markdown)
  return collapsedKeysOf(parsed, expandedByDepth(levels)).map(
    (key) => parsed.blocks[idOfKey(key)].text,
  )
}

describe("collapsedKeysOf, by depth", () => {
  it("keeps a flat document fully expanded", () => {
    expect(collapsedContents("- a\n- b\n- c\n")).toEqual([])
  })

  it("keeps level-1 parents expanded and collapses level-2 parents — and stops there", () => {
    const markdown = ["- root", "  - middle", "    - deep", "      - deeper", ""].join("\n")
    // What is beneath a fold is not listed: the rule decides it when the
    // fold opens (a lazy walk never reaches it), and it folds then.
    expect(collapsedContents(markdown)).toEqual(["middle"])
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
    // `inner` is level 2 → collapsed; the heading beneath it would be too,
    // once reached: a heading has no special standing in the count, and does
    // not restart it.
    expect(collapsedContents(markdown)).toEqual(["inner"])
    expect(collapsedContents(markdown, 3)).toEqual(["Deep heading"])
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
    // (`point`, at level 3, folds in turn when the sub-heading is opened.)
    expect(collapsedContents(markdown)).toEqual(["Monday"])
    // Three levels: the lists show, and only `point` (level 3) folds.
    expect(collapsedContents(markdown, 3)).toEqual(["point"])
  })

  it("handles an empty document", () => {
    expect(collapsedKeysOf(doc(""), expandedByDepth())).toEqual([])
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
    // One level: only the top-level rows show, folded.
    expect(collapsedContents(markdown, 1)).toEqual(["root", "Section"])
    // Three levels: a parent three down folds, under a heading as anywhere.
    expect(collapsedContents(markdown, 3)).toEqual(["deep", "detail"])
    // Ten levels: nothing here is deep enough to fold.
    expect(collapsedContents(markdown, 10)).toEqual([])
  })

  it("counts levels from where the walk starts: a zoomed root at 0", () => {
    const markdown = ["- root", "  - middle", "    - deep", "      - deeper", ""].join("\n")
    // Rooted at the block itself (level 0), its children are level 1 and
    // `deep`, at level 2, is the first to fold — one level further than
    // when the same rows are counted from a note's top.
    expect(collapsedContents(markdown)).toEqual(["middle"])
    const parsed = doc(markdown)
    expect(
      collapsedKeysOf(parsed, expandedByDepth(2), 0).map((key) => parsed.blocks[idOfKey(key)].text),
    ).toEqual(["deep"])
  })

  it("clamps the preference to the slider's range", () => {
    expect(clampExpandedLevels(0)).toBe(1)
    expect(clampExpandedLevels(11)).toBe(10)
    expect(clampExpandedLevels(2.6)).toBe(3)
    expect(clampExpandedLevels("x")).toBe(2)
    expect(clampExpandedLevels(undefined)).toBe(2)
  })
})
