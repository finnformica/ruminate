import { describe, expect, it } from "vitest"
import {
  clampImageSize,
  imageAlignOf,
  imageLine,
  imagePropsOf,
  parseImageLine,
  withImageLayout,
} from "./image"

describe("image layout props", () => {
  it("reads align and size leniently, and centres a picture that says nothing", () => {
    expect(imagePropsOf({ props: { src: "https://x/y.png", align: "right", size: 50 } })).toEqual({
      src: "https://x/y.png",
      align: "right",
      size: 50,
    })
    expect(imageAlignOf({ props: { src: "https://x/y.png" } })).toBe("center")
    // The default is stored as nothing; a stray value is the default.
    expect(imageAlignOf({ props: { align: "center" } })).toBe("center")
    expect(imageAlignOf({ props: { align: "top" } })).toBe("center")
    expect(imagePropsOf({ props: { size: "wide" } }).size).toBeUndefined()
    expect(imagePropsOf({ props: { size: NaN } }).size).toBeUndefined()
  })

  it("keeps a size within what a drag can reach", () => {
    expect(clampImageSize(0)).toBe(10)
    expect(clampImageSize(33.4)).toBe(33)
    expect(clampImageSize(250)).toBe(100)
    expect(imagePropsOf({ props: { size: 3 } }).size).toBe(10)
    expect(imagePropsOf({ props: { size: 140 } }).size).toBe(100)
  })

  it("writes a layout over the picture's other props, storing the defaults as nothing", () => {
    const block = { props: { image: "img_abcdefghijklmnop", width: 640, height: 480 } }
    const right = withImageLayout(block, { align: "right" })
    expect(right).toEqual({ ...block.props, align: "right" })
    expect(withImageLayout({ props: right }, { align: "center" })).toEqual(block.props)
    const half = withImageLayout({ props: right }, { size: 50.4 })
    expect(half).toEqual({ ...block.props, align: "right", size: 50 })
    expect(withImageLayout({ props: half }, { size: null })).toEqual(right)
    // The block itself is left alone.
    expect(block.props).toEqual({ image: "img_abcdefghijklmnop", width: 640, height: 480 })
  })

  it("is the row's layout only: the markdown line says nothing about it", () => {
    const block = { text: "A sunset", props: { src: "https://x/y.png", align: "left", size: 40 } }
    expect(imageLine(block)).toBe("![A sunset](https://x/y.png)")
    expect(parseImageLine(imageLine(block))).toEqual({
      text: "A sunset",
      props: { src: "https://x/y.png" },
    })
  })
})
