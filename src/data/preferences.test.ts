import { describe, expect, it } from "vitest"
import { DEFAULT_PREFERENCES, readPreferences, withDefaults } from "./preferences"

describe("readPreferences", () => {
  it("keeps only the keys this build knows, with the right types", () => {
    expect(readPreferences({ whatsNewCard: true, other: 1 })).toEqual({ whatsNewCard: true })
    expect(readPreferences({ whatsNewCard: "yes" })).toEqual({})
    expect(readPreferences({ useCloudflareAi: true })).toEqual({ useCloudflareAi: true })
    expect(readPreferences({ useCloudflareAi: 1 })).toEqual({})
  })

  it("reads anything that is not an object as saying nothing", () => {
    expect(readPreferences(null)).toEqual({})
    expect(readPreferences("{}")).toEqual({})
    expect(readPreferences([true])).toEqual({})
    expect(readPreferences(undefined)).toEqual({})
  })
})

describe("withDefaults", () => {
  it("fills what was not stated from the defaults, and the card is off by default", () => {
    expect(DEFAULT_PREFERENCES.whatsNewCard).toBe(false)
    expect(withDefaults({})).toEqual(DEFAULT_PREFERENCES)
    expect(withDefaults({ whatsNewCard: true })).toEqual({
      whatsNewCard: true,
      useCloudflareAi: false,
    })
  })
})
