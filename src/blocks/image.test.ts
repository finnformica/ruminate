import { describe, expect, it } from "vitest"
import { imageLine, imagePropsOf, parseImageLine } from "./image"

describe("image props", () => {
  it("reads where the picture is, leniently, and never the layout", () => {
    expect(
      imagePropsOf({ props: { src: "https://x/y.png", width: 640, height: 480, align: "right" } }),
    ).toEqual({ src: "https://x/y.png", width: 640, height: 480 })
    expect(imagePropsOf({ props: { image: "img_abcdefghijklmnop", width: -1 } })).toEqual({
      image: "img_abcdefghijklmnop",
    })
    expect(imagePropsOf({ props: null })).toEqual({})
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
