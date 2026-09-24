// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  refreshPreferences,
  resetPreferences,
  saveAccountPreferences,
  useAccountPreference,
} from "./account-preferences"

const failing = (async () => {
  throw new TypeError("Failed to fetch")
}) as unknown as typeof fetch

const card = () => renderHook(() => useAccountPreference("whatsNewCard")).result.current

afterEach(() => {
  resetPreferences()
})

describe("account preferences", () => {
  it("starts from the defaults, with the card off", () => {
    expect(card()).toBe(false)
  })

  it("keeps the defaults when the request cannot be made", async () => {
    await refreshPreferences(failing)
    expect(card()).toBe(false)
  })

  it("keeps nothing on the device", () => {
    expect(localStorage.length).toBe(0)
  })

  it("puts a save back when the server cannot be reached, and says so", async () => {
    // Signed out in this test, so the save fails before it is sent: the
    // optimistic value must still be withdrawn.
    await expect(saveAccountPreferences({ whatsNewCard: true }, failing)).rejects.toThrow()
    expect(card()).toBe(false)
    expect(localStorage.length).toBe(0)
  })
})
