// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { recentTouchesAtom } from "../global-state"
import { useTouchNote } from "./touch-note"

describe("useTouchNote", () => {
  beforeEach(() => localStorage.clear())

  function mount(noteId: string | undefined) {
    const store = createStore()
    store.set(recentTouchesAtom, [])
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    )
    const hook = renderHook(({ id }) => useTouchNote(id), { wrapper, initialProps: { id: noteId } })
    return { store, ...hook }
  }
  const touched = (store: ReturnType<typeof createStore>) =>
    store.get(recentTouchesAtom).map((touch) => touch.id)

  it("touches the note when it opens, and again when another opens in its place", () => {
    const { store, rerender } = mount("a")
    expect(touched(store)).toEqual(["a"])
    rerender({ id: "b" })
    expect(touched(store)).toEqual(["b", "a"])
  })

  it("touches nothing for no note", () => {
    const { store } = mount(undefined)
    expect(touched(store)).toEqual([])
  })

  it("a zoom (or a fold, or an edit) touches: `touching` notes the touch and runs the callback", () => {
    vi.useFakeTimers()
    try {
      const { store, result } = mount("a")
      // A second later (the open's touch has aged past the coalescing window).
      vi.setSystemTime(Date.now() + 2000)
      const navigate = vi.fn()
      const zoom = result.current.touching((id: string | null) => navigate(id))
      const before = store.get(recentTouchesAtom)
      act(() => zoom("blk_1"))
      expect(navigate).toHaveBeenCalledWith("blk_1")
      const after = store.get(recentTouchesAtom)
      expect(after).not.toBe(before)
      expect(after[0].id).toBe("a")
      expect(after[0].at).toBeGreaterThan(before[0].at)
    } finally {
      vi.useRealTimers()
    }
  })
})
