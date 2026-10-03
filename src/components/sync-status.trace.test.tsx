// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SAVE_TRACE_HOLD_MS, useSteadySaveTrace, type SaveTrace } from "./sync-status"

describe("useSteadySaveTrace", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function trace(initial: SaveTrace) {
    return renderHook(({ trace }: { trace: SaveTrace }) => useSteadySaveTrace(trace), {
      initialProps: { trace: initial },
    })
  }

  it("shows a save the instant it starts", () => {
    const { result, rerender } = trace(null)
    expect(result.current).toBe(null)
    rerender({ trace: "saving" })
    expect(result.current).toBe("saving")
  })

  it("holds Saving… through a burst of typing, offline and on", () => {
    const { result, rerender } = trace("saving")
    // Each keystroke's write lands on the device within a moment…
    rerender({ trace: "saved-offline" })
    expect(result.current).toBe("saving")
    act(() => {
      vi.advanceTimersByTime(SAVE_TRACE_HOLD_MS / 2)
    })
    // …and the next keystroke stirs the save again before the hold is up.
    rerender({ trace: "saving" })
    act(() => {
      vi.advanceTimersByTime(SAVE_TRACE_HOLD_MS - 1)
    })
    expect(result.current).toBe("saving")
    // Online, a push landing between words is the same pause.
    rerender({ trace: null })
    act(() => {
      vi.advanceTimersByTime(SAVE_TRACE_HOLD_MS - 1)
    })
    expect(result.current).toBe("saving")
  })

  it("settles once the typing has", () => {
    const { result, rerender } = trace("saving")
    rerender({ trace: "saved-offline" })
    act(() => {
      vi.advanceTimersByTime(SAVE_TRACE_HOLD_MS)
    })
    expect(result.current).toBe("saved-offline")
    rerender({ trace: null })
    act(() => {
      vi.advanceTimersByTime(SAVE_TRACE_HOLD_MS)
    })
    expect(result.current).toBe(null)
  })
})
