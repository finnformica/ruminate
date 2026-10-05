// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { recentVisitsAtom } from "../global-state"
import { useTouchNote } from "./touch-note"

describe("useTouchNote", () => {
  beforeEach(() => localStorage.clear())

  function mount(noteId: string | undefined, block?: string) {
    const store = createStore()
    store.set(recentVisitsAtom, [])
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    )
    const hook = renderHook(({ id, block }) => useTouchNote(id, block), {
      wrapper,
      initialProps: { id: noteId, block },
    })
    return { store, ...hook }
  }
  const touched = (store: ReturnType<typeof createStore>) =>
    store.get(recentVisitsAtom).map(({ id, noteId }) => `${noteId}/${id}`)

  it("touches the note when it opens, and again when another opens in its place", () => {
    const { store, rerender } = mount("a")
    expect(touched(store)).toEqual(["a/a"])
    rerender({ id: "b", block: undefined })
    expect(touched(store)).toEqual(["b/b", "a/a"])
  })

  it("touches the focused block, not its note: focusing on a block opens it", () => {
    const { store, rerender } = mount("personal")
    rerender({ id: "personal", block: "fashion" })
    expect(touched(store)).toEqual(["personal/fashion", "personal/personal"])
  })

  it("touches nothing for no note", () => {
    const { store } = mount(undefined)
    expect(touched(store)).toEqual([])
  })

  it("a fold or an edit touches what is open: `touch` notes the touch", () => {
    vi.useFakeTimers()
    try {
      const { store, result } = mount("personal", "fashion")
      // A second later (the open's touch has aged past the coalescing window).
      vi.setSystemTime(Date.now() + 2000)
      const before = store.get(recentVisitsAtom)
      act(() => result.current())
      const after = store.get(recentVisitsAtom)
      expect(after).not.toBe(before)
      expect(after[0].id).toBe("fashion")
      expect(after[0].at).toBeGreaterThan(before[0].at)
    } finally {
      vi.useRealTimers()
    }
  })
})
