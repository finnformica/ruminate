import { describe, expect, it } from "vitest"
import { BOARD_TYPE } from "../data/graph"
import { foldRule, type Folds } from "../data/view-state"
import { expandedByDepth } from "./default-collapsed"
import {
  levelBeneath,
  queryAt,
  rootDirection,
  type LinkPivots,
  type QueryRow,
  type WalkRule,
} from "./query"

const NO_FOLDS: Folds = { open: new Set(), closed: new Set() }

/** The rule a frame walks by: its pivots, and its folds over the depth rule
 * (two levels open, the default). */
const ruleOf = (pivots: LinkPivots = new Map(), folds: Folds = NO_FOLDS): WalkRule => ({
  pivots,
  expanded: foldRule(folds, expandedByDepth(2)),
})

const row = (id: string, level = 1, type?: string): QueryRow => ({
  key: `N/${id}`,
  id,
  level,
  type,
})

describe("queryAt", () => {
  it("collapses a folded row, over a pivot on its block", () => {
    const rule = ruleOf(new Map([["X", "up"]]), { open: new Set(), closed: new Set(["N/X"]) })
    expect(queryAt(rule, row("X"), "down")).toEqual({ type: "collapse" })
  })

  it("applies the pivot again when the folded row opens", () => {
    const pivots: LinkPivots = new Map([["X", "up"]])
    const closed = ruleOf(pivots, { open: new Set(), closed: new Set(["N/X"]) })
    const opened = ruleOf(pivots, { open: new Set(["N/X"]), closed: new Set() })
    expect(queryAt(closed, row("X"), "down")).toEqual({ type: "collapse" })
    expect(queryAt(opened, row("X"), "down")).toEqual({ type: "links", direction: "up" })
  })

  it("lets a pivot beat the inherited direction, both ways", () => {
    const rule = ruleOf(
      new Map([
        ["X", "up"],
        ["P", "down"],
      ]),
    )
    expect(queryAt(rule, row("X"), "down")).toEqual({ type: "links", direction: "up" })
    expect(queryAt(rule, row("P"), "up")).toEqual({ type: "links", direction: "down" })
  })

  it("inherits the direction when the block has no pivot", () => {
    const rule = ruleOf(new Map([["X", "up"]]))
    expect(queryAt(rule, row("A"), "down")).toEqual({ type: "links", direction: "down" })
    expect(queryAt(rule, row("A"), "up")).toEqual({ type: "links", direction: "up" })
  })

  it("closes a row from the depth rule's level down", () => {
    const rule = ruleOf()
    expect(queryAt(rule, row("A", 1), "down")).toEqual({ type: "links", direction: "down" })
    expect(queryAt(rule, row("A", 2), "down")).toEqual({ type: "collapse" })
  })

  it("starts a board's row closed, and opens it when the reader opens it", () => {
    expect(queryAt(ruleOf(), row("B", 1, BOARD_TYPE), "down")).toEqual({ type: "collapse" })
    const opened = ruleOf(new Map(), { open: new Set(["N/B"]), closed: new Set() })
    expect(queryAt(opened, row("B", 1, BOARD_TYPE), "down")).toEqual({
      type: "links",
      direction: "down",
    })
  })
})

describe("levelBeneath", () => {
  it("counts one level down beneath a row with no pivot", () => {
    expect(levelBeneath(ruleOf(), row("A", 1))).toBe(2)
    expect(levelBeneath(ruleOf(), row("A", 4))).toBe(5)
  })

  it("starts the depth count again at a pivot, whatever the row's depth", () => {
    const rule = ruleOf(new Map([["X", "up"]]), { open: new Set(["N/X"]), closed: new Set() })
    const deep = row("X", 5)
    expect(queryAt(rule, deep, "down")).toEqual({ type: "links", direction: "up" })
    expect(levelBeneath(rule, deep)).toBe(1)
    // So the holders beneath it are open, as a note's roots are.
    expect(queryAt(rule, row("P", levelBeneath(rule, deep)), "up")).toEqual({
      type: "links",
      direction: "up",
    })
  })
})

describe("rootDirection", () => {
  it("is down with no pivot on the root", () => {
    expect(rootDirection(new Map([["X", "up"]]), "N")).toBe("down")
  })

  it("reads a pivot on the root", () => {
    expect(rootDirection(new Map([["N", "up"]]), "N")).toBe("up")
  })
})
