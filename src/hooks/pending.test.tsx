// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { usePending } from "./pending"

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("usePending", () => {
  it("is pending from the call until the promise settles", async () => {
    const d = deferred()
    const { result } = renderHook(() => usePending(() => d.promise))
    expect(result.current[1]).toBe(false)

    act(() => result.current[0]())
    expect(result.current[1]).toBe(true)

    await act(async () => {
      d.resolve()
      await d.promise
    })
    expect(result.current[1]).toBe(false)
  })

  it("settles on rejection too, leaving the error to the action", async () => {
    const d = deferred()
    const { result } = renderHook(() => usePending(() => d.promise.catch(() => {})))
    act(() => result.current[0]())
    expect(result.current[1]).toBe(true)

    await act(async () => {
      d.reject(new Error("no"))
      await d.promise.catch(() => {})
    })
    expect(result.current[1]).toBe(false)
  })

  it("drops a second call while pending, and passes arguments through", async () => {
    const d = deferred()
    const action = vi.fn((_id: string) => d.promise)
    const { result } = renderHook(() => usePending(action))

    act(() => result.current[0]("a"))
    act(() => result.current[0]("b"))
    expect(action).toHaveBeenCalledTimes(1)
    expect(action).toHaveBeenCalledWith("a")

    await act(async () => {
      d.resolve()
      await d.promise
    })
    act(() => result.current[0]("c"))
    expect(action).toHaveBeenCalledTimes(2)
  })

  it("is over at once for an action that returns nothing", () => {
    const action = vi.fn()
    const { result } = renderHook(() => usePending(action))
    act(() => result.current[0]())
    expect(action).toHaveBeenCalledTimes(1)
    expect(result.current[1]).toBe(false)
  })

  it("uses the latest action", async () => {
    const first = vi.fn(() => Promise.resolve())
    const second = vi.fn(() => Promise.resolve())
    const { result, rerender } = renderHook(({ action }) => usePending(action), {
      initialProps: { action: first },
    })
    rerender({ action: second })
    await act(async () => result.current[0]())
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
