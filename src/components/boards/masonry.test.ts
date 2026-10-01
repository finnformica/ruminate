import { describe, expect, it } from "vitest"
import { columnCount, masonryColumns } from "./masonry"

describe("masonryColumns", () => {
  it("drops each item onto the shortest column, counting height in widths", () => {
    // Two columns: a tall portrait (1/2 wide), then squares fill the other
    // column until it catches up.
    const items = [
      { id: "tall", ratio: 0.5 },
      { id: "a", ratio: 1 },
      { id: "b", ratio: 1 },
      { id: "c", ratio: 1 },
    ]
    const stacks = masonryColumns(items, 2, (item) => item.ratio).map((stack) =>
      stack.map((item) => item.id),
    )
    expect(stacks).toEqual([
      ["tall", "c"],
      ["a", "b"],
    ])
  })

  it("keeps the order given across columns when every picture is the same shape", () => {
    const stacks = masonryColumns(["1", "2", "3", "4", "5"], 3, () => 1)
    expect(stacks).toEqual([["1", "4"], ["2", "5"], ["3"]])
  })

  it("treats a shape it cannot read as square", () => {
    const stacks = masonryColumns(["x", "y"], 2, () => NaN)
    expect(stacks).toEqual([["x"], ["y"]])
  })

  it("has at least one column", () => {
    expect(masonryColumns(["x"], 0, () => 1)).toEqual([["x"]])
  })
})

describe("columnCount", () => {
  it("fits as many columns as the width allows, two to six", () => {
    expect(columnCount(0, 160, 12)).toBe(2)
    expect(columnCount(320, 160, 12)).toBe(2)
    expect(columnCount(520, 160, 12)).toBe(3)
    expect(columnCount(1100, 160, 12)).toBe(6)
    expect(columnCount(4000, 160, 12)).toBe(6)
  })
})
