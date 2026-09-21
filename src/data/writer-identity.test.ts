// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { WRITER_BUILD_HEADER, WRITER_DEVICE_HEADER, writerHeaders } from "./writer-identity"

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("writerHeaders", () => {
  it("names a device that outlives the page and a tab that does not", () => {
    const first = writerHeaders()[WRITER_DEVICE_HEADER]
    expect(first).toMatch(/^[0-9a-z]{8}\.[0-9a-z]{6}$/)
    expect(writerHeaders()[WRITER_DEVICE_HEADER]).toBe(first)
    expect(localStorage.getItem("ruminate.device")).toBe(first.split(".")[0])
  })

  it("says only what the replica will store: short, and plain", () => {
    for (const value of Object.values(writerHeaders())) expect(value).toMatch(/^[\w.:+-]{1,64}$/)
    expect(writerHeaders()[WRITER_BUILD_HEADER].length).toBeGreaterThan(0)
  })

  it("still names the tab when storage refuses", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(writerHeaders()[WRITER_DEVICE_HEADER]).toMatch(/^nostore\.[0-9a-z]{6}$/)
  })
})
