// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { expandedByDepth } from "../blocks/default-collapsed"
import { expandedLevelsAtom } from "../global-state"
import {
  MAX_STORED_NOTES,
  foldRule,
  readFolds,
  useFoldRule,
  withFold,
  writeFolds,
} from "./view-state"

/** Keys of a four-deep outline: `a`, `a/b`, `a/b/c`, `a/b/c/d`. Levels 1–4. */
const stored = (noteId: string): unknown => {
  const raw = localStorage.getItem(`collapse:${noteId}`)
  return raw === null ? null : JSON.parse(raw)
}

const sorted = (set: ReadonlySet<string>) => [...set].sort()

/** Render the hook against a store with the given depth setting. */
function renderWithLevels(levels: number, noteId: string | undefined) {
  const store = createStore()
  store.set(expandedLevelsAtom, levels)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  const rendered = renderHook(({ id }) => useFoldRule(id), {
    initialProps: { id: noteId },
    wrapper,
  })
  return { ...rendered, store }
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("readFolds", () => {
  it("is null without a note id, an entry, or usable JSON", () => {
    expect(readFolds(undefined)).toBe(null)
    expect(readFolds("n1")).toBe(null)
    localStorage.setItem("collapse:n1", "{not json")
    expect(readFolds("n1")).toBe(null)
  })

  it("reads back both lists, ignoring junk entries", () => {
    localStorage.setItem(
      "collapse:n1",
      JSON.stringify({ v: 3, open: ["a/b", 7], closed: ["a", null], t: 1 }),
    )
    const folds = readFolds("n1")!
    expect(sorted(folds.open)).toEqual(["a/b"])
    expect(sorted(folds.closed)).toEqual(["a"])
  })

  it("reads the collapsed set of the previous shape, and a bare array, as closes", () => {
    localStorage.setItem("collapse:n1", JSON.stringify({ v: 2, collapsed: ["a/b"], t: 1 }))
    expect(sorted(readFolds("n1")!.closed)).toEqual(["a/b"])
    expect(readFolds("n1")!.open.size).toBe(0)
    localStorage.setItem("collapse:n2", JSON.stringify(["a"]))
    expect(sorted(readFolds("n2")!.closed)).toEqual(["a"])
  })

  it("reads the old two-layer record as itself, dropping a key named both ways", () => {
    localStorage.setItem(
      "collapse:n1",
      JSON.stringify({ expanded: ["b", "c"], collapsed: ["a", "c"] }),
    )
    const folds = readFolds("n1")!
    expect(sorted(folds.open)).toEqual(["b"])
    expect(sorted(folds.closed)).toEqual(["a"])
  })
})

describe("foldRule", () => {
  const byDepth = expandedByDepth(2)

  it("lets the depth rule decide a row nobody touched", () => {
    const rule = foldRule({ open: new Set(), closed: new Set() }, byDepth)
    expect(rule("a", 1)).toBe(true)
    expect(rule("a/b", 2)).toBe(false)
  })

  it("puts the reader's own folds over the rule, in both directions", () => {
    const rule = foldRule({ open: new Set(["a/b"]), closed: new Set(["a"]) }, byDepth)
    expect(rule("a", 1)).toBe(false)
    expect(rule("a/b", 2)).toBe(true)
  })

  it("applies an entry stored as a block id (pre-occurrence folds) to every occurrence", () => {
    const rule = foldRule({ open: new Set(["b"]), closed: new Set() }, byDepth)
    expect(rule("a/b", 2)).toBe(true)
    expect(rule("x/y/b", 3)).toBe(true)
    // A key's own entry beats the id's.
    const own = foldRule({ open: new Set(["b"]), closed: new Set(["a/b"]) }, byDepth)
    expect(own("a/b", 2)).toBe(false)
    expect(own("x/b", 2)).toBe(true)
  })
})

describe("withFold", () => {
  it("records one direction, forgetting the other and any bare-id entry for the block", () => {
    const start = { open: new Set(["b"]), closed: new Set(["a/b"]) }
    const opened = withFold(start, "a/b", true)
    expect(sorted(opened.open)).toEqual(["a/b"])
    expect(sorted(opened.closed)).toEqual([])
    const closed = withFold(opened, "a/b", false)
    expect(sorted(closed.open)).toEqual([])
    expect(sorted(closed.closed)).toEqual(["a/b"])
    // The input is untouched.
    expect(sorted(start.open)).toEqual(["b"])
  })
})

describe("writeFolds", () => {
  it("writes both lists, empty ones included (a fold put back is a state)", () => {
    writeFolds("n1", { open: new Set(), closed: new Set() })
    expect(stored("n1")).toMatchObject({ v: 3, open: [], closed: [] })
  })

  it("keeps at most MAX_STORED_NOTES notes, dropping the least recently written", () => {
    for (let i = 0; i < MAX_STORED_NOTES; i += 1) {
      localStorage.setItem(
        `collapse:old-${i}`,
        JSON.stringify({ v: 3, open: [], closed: ["a"], t: i + 1 }),
      )
    }
    writeFolds("new", { open: new Set(), closed: new Set(["a"]) })
    expect(localStorage.getItem("collapse:old-0")).toBe(null)
    expect(localStorage.getItem("collapse:old-1")).not.toBe(null)
    expect(localStorage.getItem("collapse:new")).not.toBe(null)
  })
})

describe("useFoldRule", () => {
  it("answers from the depth setting until the reader folds, and stores nothing", () => {
    const { result } = renderWithLevels(2, "n1")
    expect(result.current.expanded("a", 1)).toBe(true)
    expect(result.current.expanded("a/b", 2)).toBe(false)
    expect(stored("n1")).toBe(null)
  })

  it("follows the depth the reader chose, live, for every untouched row", () => {
    const { result, store } = renderWithLevels(1, "n1")
    expect(result.current.expanded("a", 1)).toBe(false)
    act(() => store.set(expandedLevelsAtom, 4))
    expect(result.current.expanded("a/b/c", 3)).toBe(true)
  })

  it("a fold the reader made stays where they put it when the setting moves", () => {
    const { result, store } = renderWithLevels(2, "n1")
    act(() => result.current.setFold("a/b", true))
    act(() => result.current.setFold("a", false))
    act(() => store.set(expandedLevelsAtom, 4))
    expect(result.current.expanded("a/b", 2)).toBe(true)
    expect(result.current.expanded("a", 1)).toBe(false)
    act(() => store.set(expandedLevelsAtom, 1))
    expect(result.current.expanded("a/b", 2)).toBe(true)
  })

  it("persists each decision, and remembers them across a remount", () => {
    const first = renderWithLevels(2, "n1")
    act(() => first.result.current.setFold("a/b", true))
    expect(stored("n1")).toMatchObject({ v: 3, open: ["a/b"], closed: [] })
    first.unmount()

    const second = renderWithLevels(2, "n1")
    expect(second.result.current.expanded("a/b", 2)).toBe(true)
    // And a row put back where the rule has it is remembered as the
    // reader's, not re-decided by a later change of setting.
    act(() => second.result.current.setFold("a/b", false))
    act(() => second.store.set(expandedLevelsAtom, 10))
    expect(second.result.current.expanded("a/b", 2)).toBe(false)
  })

  it("re-reads on a different note, so one note's folds never paint on another", () => {
    const { result, rerender } = renderWithLevels(2, "n1")
    act(() => result.current.setFold("a", false))
    rerender({ id: "n2" })
    expect(result.current.expanded("a", 1)).toBe(true)
    rerender({ id: "n1" })
    expect(result.current.expanded("a", 1)).toBe(false)
  })

  it("never leaves a row un-openable, whatever was stored", () => {
    // Regression, stuck fold: an old record naming `b` in both directions
    // used to make it permanently collapsed. The read drops the conflict,
    // and a toggle records the reader's decision over any bare-id entry.
    localStorage.setItem("collapse:n1", JSON.stringify({ expanded: ["b"], collapsed: ["b"] }))
    const { result } = renderWithLevels(1, "n1")
    expect(result.current.expanded("a/b", 2)).toBe(false)
    act(() => result.current.setFold("a/b", true))
    expect(result.current.expanded("a/b", 2)).toBe(true)
    expect(stored("n1")).toMatchObject({ v: 3, open: ["a/b"], closed: [] })
  })

  it("works without a note id (Storybook / standalone) and stores nothing", () => {
    const { result } = renderWithLevels(2, undefined)
    expect(result.current.expanded("a/b", 2)).toBe(false)
    act(() => result.current.setFold("a/b", true))
    expect(result.current.expanded("a/b", 2)).toBe(true)
    expect(Object.keys(localStorage).filter((key) => key.startsWith("collapse:"))).toEqual([])
  })
})
