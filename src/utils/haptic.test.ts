// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { haptic } from "./haptic"

describe("haptic", () => {
  const setVibrate = (value: unknown) =>
    Object.defineProperty(navigator, "vibrate", { value, configurable: true })
  afterEach(() => setVibrate(undefined))

  it("is one short pulse where the Vibration API exists", () => {
    const vibrate = vi.fn(() => true)
    setVibrate(vibrate)
    haptic()
    expect(vibrate).toHaveBeenCalledWith(12)
  })

  it("is nothing, quietly, where there is neither the API nor a switch control", () => {
    expect(() => haptic()).not.toThrow()
    // No hidden switch is left behind on an engine without the control.
    expect(document.querySelector("input[switch]")).toBeNull()
  })

  it("shrugs off a browser that refuses the call", () => {
    setVibrate(
      vi.fn(() => {
        throw new Error("no")
      }),
    )
    expect(() => haptic()).not.toThrow()
  })
})
