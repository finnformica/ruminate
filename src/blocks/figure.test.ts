import { describe, expect, it } from "vitest"
import {
  clampFigureSize,
  figureAlignOf,
  figureLayoutOf,
  isFigureType,
  withFigureLayout,
} from "./figure"

describe("figure layout props", () => {
  it("names the types laid out as figures", () => {
    expect(isFigureType("image")).toBe(true)
    expect(isFigureType("link")).toBe(true)
    expect(isFigureType("text")).toBe(false)
    expect(isFigureType("note")).toBe(false)
  })

  it("reads align and size leniently, and centres a figure that says nothing", () => {
    expect(figureLayoutOf({ props: { src: "https://x/y.png", align: "right", size: 50 } })).toEqual(
      { align: "right", size: 50 },
    )
    expect(figureAlignOf({ props: { src: "https://x/y.png" } })).toBe("center")
    // The default is stored as nothing; a stray value is the default.
    expect(figureAlignOf({ props: { align: "center" } })).toBe("center")
    expect(figureAlignOf({ props: { align: "top" } })).toBe("center")
    expect(figureLayoutOf({ props: { size: "wide" } }).size).toBeUndefined()
    expect(figureLayoutOf({ props: { size: NaN } }).size).toBeUndefined()
  })

  it("keeps a size within what a drag can reach", () => {
    expect(clampFigureSize(0)).toBe(10)
    expect(clampFigureSize(33.4)).toBe(33)
    expect(clampFigureSize(250)).toBe(100)
    expect(figureLayoutOf({ props: { size: 3 } }).size).toBe(10)
    expect(figureLayoutOf({ props: { size: 140 } }).size).toBe(100)
  })

  it("writes a layout over the figure's other props, storing the defaults as nothing", () => {
    const block = { props: { image: "img_abcdefghijklmnop", width: 640, height: 480 } }
    const right = withFigureLayout(block, { align: "right" })
    expect(right).toEqual({ ...block.props, align: "right" })
    expect(withFigureLayout({ props: right }, { align: "center" })).toEqual(block.props)
    const half = withFigureLayout({ props: right }, { size: 50.4 })
    expect(half).toEqual({ ...block.props, align: "right", size: 50 })
    expect(withFigureLayout({ props: half }, { size: null })).toEqual(right)
    // The block itself is left alone.
    expect(block.props).toEqual({ image: "img_abcdefghijklmnop", width: 640, height: 480 })
    // A link block's address and preview are kept the same way.
    const link = { props: { url: "https://e.com/", site: "E" } }
    expect(withFigureLayout(link, { align: "left", size: 40 })).toEqual({
      url: "https://e.com/",
      site: "E",
      align: "left",
      size: 40,
    })
  })
})
