import { describe, expect, it } from "vitest"
import { thumbHashDataUrl, thumbHashOf } from "./image-thumbhash"

describe("thumbHashDataUrl", () => {
  it("draws a ThumbHash as a small picture", () => {
    expect(thumbHashDataUrl("YyUKNJh2d3eAiHh3iIeGcGgHdw==")).toMatch(/^data:image\/png;base64,/)
  })

  it("draws nothing for a hash that does not decode", () => {
    expect(thumbHashDataUrl("not base64!")).toBeNull()
  })
})

describe("thumbHashOf", () => {
  it("measures nothing where there is no canvas to draw on", () => {
    expect(thumbHashOf({} as CanvasImageSource, 10, 10)).toBeNull()
  })
})
