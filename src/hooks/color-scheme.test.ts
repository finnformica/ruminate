import { describe, expect, it } from "vitest"
import { resolveColorScheme } from "./color-scheme"

describe("resolveColorScheme", () => {
  it("a chosen scheme is that scheme, whatever the device prefers", () => {
    expect(resolveColorScheme("light", true)).toBe("light")
    expect(resolveColorScheme("dark", false)).toBe("dark")
  })

  it("system follows the device", () => {
    expect(resolveColorScheme("system", true)).toBe("dark")
    expect(resolveColorScheme("system", false)).toBe("light")
  })
})
