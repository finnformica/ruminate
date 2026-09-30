// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { MAX_IMAGE_BYTES } from "../../worker/handlers/image-policy"
import { FIT_MAX_EDGE, fitImage, fittedName, fittedSize, needsFitting } from "./image-fit"

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
