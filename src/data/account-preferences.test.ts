// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  refreshPreferences,
  resetPreferences,
  saveAccountPreferences,
  seedPreferences,
  useAccountPreference,
} from "./account-preferences"

const failing = (async () => {
  throw new TypeError("Failed to fetch")
}) as unknown as typeof fetch

const card = () => renderHook(() => useAccountPreference("whatsNewCard")).result.current

afterEach(() => {
  resetPreferences()
  localStorage.clear()
})

describe("account preferences across a start with no network", () => {
  it("starts from the defaults, with the card off", () => {
    expect(card()).toBe(false)
  })

  it("remembers the server's answer per account, and starts from it next time", () => {
    localStorage.setItem("preferences:42", JSON.stringify({ whatsNewCard: true }))
    seedPreferences("42")
    expect(card()).toBe(true)
  })

  it("starts from the defaults for an account nothing is remembered for", () => {
    localStorage.setItem("preferences:42", JSON.stringify({ whatsNewCard: true }))
    seedPreferences("7")
    expect(card()).toBe(false)
  })

  it("keeps the remembered answer when the request cannot be made", async () => {
    localStorage.setItem("preferences:42", JSON.stringify({ whatsNewCard: true }))
    seedPreferences("42")
    await refreshPreferences(failing)
    expect(card()).toBe(true)
  })

  it("forgets the preferences on sign-out but not the device's memory of them", () => {
    localStorage.setItem("preferences:42", JSON.stringify({ whatsNewCard: true }))
    seedPreferences("42")
    resetPreferences()
    expect(card()).toBe(false)
    seedPreferences("42")
    expect(card()).toBe(true)
  })

  it("ignores a malformed memory", () => {
    localStorage.setItem("preferences:42", "{not json")
    seedPreferences("42")
    expect(card()).toBe(false)
  })

  it("puts a save back when the server cannot be reached, and says so", async () => {
    // Signed out in this test, so the save fails before it is sent: the
    // optimistic value must still be withdrawn.
    seedPreferences("42")
    await expect(saveAccountPreferences({ whatsNewCard: true }, failing)).rejects.toThrow()
    expect(card()).toBe(false)
  })
})
