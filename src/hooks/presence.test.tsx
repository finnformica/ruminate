// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePresence } from "./presence"

describe("usePresence", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.documentElement.style.setProperty("--duration-slow", "300ms")
  })
  afterEach(() => vi.useRealTimers())

  it("is present at once when opened, and for the slow duration after closing", () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open), {
      initialProps: { open: false },
    })
    expect(result.current).toBe(false)

    rerender({ open: true })
    expect(result.current).toBe(true)

    rerender({ open: false })
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(299))
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(false)
  })

  it("stays put when reopened before the exit has finished", () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open), {
      initialProps: { open: true },
    })
    rerender({ open: false })
    act(() => vi.advanceTimersByTime(100))
    rerender({ open: true })
    act(() => vi.advanceTimersByTime(500))
    expect(result.current).toBe(true)
  })
})
