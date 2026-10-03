// @vitest-environment jsdom
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { resetFeatures, seedFeatures } from "../data/features"
import { useAiAvailable } from "./ai"

/**
 * The hook over the router: signed out (the sample graph, no store) no AI
 * feature is on, whatever the flags say — the order behind it is pinned in
 * src/data/ai-router.test.ts.
 */

afterEach(() => {
  resetFeatures()
  localStorage.clear()
})

describe("useAiAvailable", () => {
  it("is nothing signed out", () => {
    expect(renderHook(() => useAiAvailable()).result.current).toEqual({
      available: false,
      provider: null,
    })
  })

  it("stays nothing signed out even with the Cloudflare flag remembered on", () => {
    localStorage.setItem(
      "features:42",
      JSON.stringify({ admin: true, features: { cloudflareAi: true } }),
    )
    seedFeatures("42")
    expect(renderHook(() => useAiAvailable()).result.current).toEqual({
      available: false,
      provider: null,
    })
  })
})
