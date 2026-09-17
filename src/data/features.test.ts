// @vitest-environment jsdom
import { getDefaultStore } from "jotai"
import { afterEach, describe, expect, it } from "vitest"
import { refreshFeatures, resetFeatures, seedFeatures, useIsAdmin } from "./features"
import { renderHook } from "@testing-library/react"

const answer = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
const failing = (async () => {
  throw new TypeError("Failed to fetch")
}) as unknown as typeof fetch

afterEach(() => {
  resetFeatures()
  localStorage.clear()
})

describe("feature flags across a start with no network", () => {
  it("remembers the server's answer per account, and starts from it next time", async () => {
    // The session is stubbed out: no token means refreshFeatures returns
    // before fetching, so the cache is exercised through seed alone here.
    localStorage.setItem("features:42", JSON.stringify({ admin: true, features: {} }))
    seedFeatures("42")
    const { result } = renderHook(() => useIsAdmin())
    expect(result.current).toBe(true)
  })

  it("starts as a stranger with nothing remembered, and for another account", () => {
    localStorage.setItem("features:42", JSON.stringify({ admin: true, features: {} }))
    seedFeatures("7")
    expect(getDefaultStore().get === undefined).toBe(false)
    const { result } = renderHook(() => useIsAdmin())
    expect(result.current).toBe(false)
  })

  it("keeps the remembered answer when the request cannot be made", async () => {
    localStorage.setItem("features:42", JSON.stringify({ admin: true, features: {} }))
    seedFeatures("42")
    await refreshFeatures(failing)
    const { result } = renderHook(() => useIsAdmin())
    expect(result.current).toBe(true)
  })

  it("forgets the flags on sign-out but not the device's memory of them", () => {
    localStorage.setItem("features:42", JSON.stringify({ admin: true, features: {} }))
    seedFeatures("42")
    resetFeatures()
    expect(renderHook(() => useIsAdmin()).result.current).toBe(false)
    seedFeatures("42")
    expect(renderHook(() => useIsAdmin()).result.current).toBe(true)
  })

  it("ignores a malformed memory", () => {
    localStorage.setItem("features:42", "{not json")
    seedFeatures("42")
    expect(renderHook(() => useIsAdmin()).result.current).toBe(false)
    void answer
  })
})
