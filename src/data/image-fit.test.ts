// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { MAX_IMAGE_BYTES } from "../../worker/handlers/image-policy"
import {
  FIT_MAX_EDGE,
  VISION_MAX_EDGE,
  fitImage,
  fitImageFor,
  fittedName,
  fittedSize,
  needsFitting,
  visionCopy,
} from "./image-fit"

describe("needsFitting", () => {
  it("is a supported picture over the limit, or a format only the browser reads", () => {
    expect(needsFitting({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 })).toBe(true)
    expect(needsFitting({ type: "image/png", size: MAX_IMAGE_BYTES + 1 })).toBe(true)
    expect(needsFitting({ type: "image/heic", size: 1000 })).toBe(true)
    expect(needsFitting({ type: "image/heif; charset=x", size: 1000 })).toBe(true)
  })

  it("leaves a picture that fits, a GIF, and a format nobody reads alone", () => {
    expect(needsFitting({ type: "image/jpeg", size: MAX_IMAGE_BYTES })).toBe(false)
    expect(needsFitting({ type: "image/gif", size: MAX_IMAGE_BYTES * 2 })).toBe(false)
    expect(needsFitting({ type: "image/svg+xml", size: MAX_IMAGE_BYTES * 2 })).toBe(false)
    expect(needsFitting({ type: "application/pdf", size: MAX_IMAGE_BYTES * 2 })).toBe(false)
  })
})

describe("fittedSize", () => {
  it("keeps a picture within the edge as it is", () => {
    expect(fittedSize(3000, 2000)).toEqual({ width: 3000, height: 2000 })
    expect(fittedSize(FIT_MAX_EDGE, 10)).toEqual({ width: FIT_MAX_EDGE, height: 10 })
  })

  it("scales the longest edge down to the limit and keeps the shape", () => {
    expect(fittedSize(8064, 6048)).toEqual({ width: 3200, height: 2400 })
    expect(fittedSize(6048, 8064)).toEqual({ width: 2400, height: 3200 })
    expect(fittedSize(10000, 1, 100)).toEqual({ width: 100, height: 1 })
  })

  it("fits a phone photo to the vision edge: a few megapixels become a couple", () => {
    expect(VISION_MAX_EDGE).toBe(1568)
    expect(fittedSize(4032, 3024, VISION_MAX_EDGE)).toEqual({ width: 1568, height: 1176 })
    expect(fittedSize(3024, 4032, VISION_MAX_EDGE)).toEqual({ width: 1176, height: 1568 })
    expect(fittedSize(4000, 3000, VISION_MAX_EDGE)).toEqual({ width: 1568, height: 1176 })
    // Already within it: left as it is.
    expect(fittedSize(1200, 800, VISION_MAX_EDGE)).toEqual({ width: 1200, height: 800 })
    expect(fittedSize(1568, 1568, VISION_MAX_EDGE)).toEqual({ width: 1568, height: 1568 })
  })
})

describe("fittedName", () => {
  it("is the original's name with a JPEG's ending", () => {
    expect(fittedName("IMG_0042.HEIC")).toBe("IMG_0042.jpg")
    expect(fittedName("kitchen.png")).toBe("kitchen.jpg")
    expect(fittedName("noext")).toBe("noext.jpg")
    expect(fittedName("")).toBe("image.jpg")
  })
})

describe("fitImage", () => {
  it("hands back a picture that fits, untouched", async () => {
    const file = new File([new Uint8Array(10)], "a.png", { type: "image/png" })
    expect(await fitImage(file)).toBe(file)
  })

  it("is nothing where there is no canvas to re-encode with", async () => {
    const file = new File([new Uint8Array(10)], "a.heic", { type: "image/heic" })
    expect(await fitImage(file)).toBeNull()
  })
})

describe("fitImageFor and visionCopy", () => {
  // jsdom has no canvas that draws, so the re-encode cannot happen here;
  // the sizing it would use is pinned above, and the browser check in the
  // pull request measures the copy itself.
  it("are nothing where there is no canvas to re-encode with", async () => {
    const blob = new Blob([new Uint8Array(10)], { type: "image/jpeg" })
    expect(await fitImageFor(blob, { maxEdge: 100, quality: 0.8, type: "image/jpeg" })).toBeNull()
    expect(await visionCopy(blob)).toBeNull()
  })
})
