// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { expandedByDepth } from "../blocks/default-collapsed"
import { expandedLevelsAtom } from "../global-state"
import { foldRule, takeStoredFolds, useFoldRule, withFold, type HeldFolds } from "./view-state"

/** Keys of a four-deep outline: `a`, `a/b`, `a/b/c`, `a/b/c/d`. Levels 1–4. */
const sorted = (set: ReadonlySet<string>) => [...set].sort()

type Options = Parameters<typeof useFoldRule>[0]

/** Render the hook against a store with the given depth setting. */
function renderWithLevels(levels: number, options: Options = {}) {
  const store = createStore()
  store.set(expandedLevelsAtom, levels)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  const rendered = renderHook((props: Options) => useFoldRule(props), {
    initialProps: options,
    wrapper,
  })
  return { ...rendered, store }
}

/** Folds a caller holds, as a frame holds them, with every change kept. */
function heldFolds(): HeldFolds & { changes: unknown[] } {
  const held = {
    folds: { open: new Set<string>(), closed: new Set<string>() } as HeldFolds["folds"],
    changes: [] as unknown[],
    onChange: (next: HeldFolds["folds"]) => {
      held.changes.push(next)
      held.folds = next
    },
  }
  return held
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("takeStoredFolds (the seed, docs/graph-walk.md GW-10)", () => {
  it("is null without an entry, usable JSON or a fold", () => {
    expect(takeStoredFolds("n1")).toBe(null)
    localStorage.setItem("collapse:n1", "{not json")
    expect(takeStoredFolds("n1")).toBe(null)
    localStorage.setItem("collapse:n1", JSON.stringify({ v: 3, open: [], closed: [], t: 1 }))
    expect(takeStoredFolds("n1")).toBe(null)
  })

  it("reads back both lists, ignoring junk entries, and runs once", () => {
    localStorage.setItem(
      "collapse:n1",
      JSON.stringify({ v: 3, open: ["a/b", 7], closed: ["a", null], t: 1 }),
    )
    const folds = takeStoredFolds("n1")!
    expect(sorted(folds.open)).toEqual(["a/b"])
    expect(sorted(folds.closed)).toEqual(["a"])
    expect(localStorage.getItem("collapse:n1")).toBe(null)
    expect(takeStoredFolds("n1")).toBe(null)
  })

  it("reads the collapsed set of the previous shape, and a bare array, as closes", () => {
    localStorage.setItem("collapse:n1", JSON.stringify({ v: 2, collapsed: ["a/b"], t: 1 }))
    const folds = takeStoredFolds("n1")!
    expect(sorted(folds.closed)).toEqual(["a/b"])
    expect(folds.open.size).toBe(0)
    localStorage.setItem("collapse:n2", JSON.stringify(["a"]))
    expect(sorted(takeStoredFolds("n2")!.closed)).toEqual(["a"])
  })

  it("reads the old two-layer record as itself, dropping a key named both ways", () => {
    localStorage.setItem(
      "collapse:n1",
      JSON.stringify({ expanded: ["b", "c"], collapsed: ["a", "c"] }),
    )
    const folds = takeStoredFolds("n1")!
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

  it("closes a board's row whatever the depth says, until the reader opens it", () => {
    // A board linked under a block is a card standing for what is beneath
    // it (docs/boards.md, "A board in a note"); a note's row follows the
    // depth rule as any block does.
    const rule = foldRule({ open: new Set(), closed: new Set() }, byDepth)
    expect(rule("a", 1, "board")).toBe(false)
    expect(rule("a", 1, "note")).toBe(true)
    expect(rule("a", 1, "ul")).toBe(true)
    const opened = foldRule({ open: new Set(["a"]), closed: new Set() }, byDepth)
    expect(opened("a", 1, "board")).toBe(true)
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

  it("keeps nothing for a row the rule already puts there", () => {
    const start = { open: new Set(["a/b"]), closed: new Set<string>() }
    const back = withFold(start, "a/b", false, false)
    expect(back.open.size + back.closed.size).toBe(0)
    expect(sorted(withFold(start, "a/b", false, true).closed)).toEqual(["a/b"])
  })
})

describe("useFoldRule", () => {
  it("answers from the depth setting until the reader folds, and stores nothing", () => {
    const { result } = renderWithLevels(2)
    expect(result.current.expanded("a", 1)).toBe(true)
    expect(result.current.expanded("a/b", 2)).toBe(false)
    act(() => result.current.setFold("a/b", true))
    expect(result.current.expanded("a/b", 2)).toBe(true)
    expect(Object.keys(localStorage).filter((key) => key.startsWith("collapse:"))).toEqual([])
  })

  it("follows the depth setting, live, for every untouched row", () => {
    const { result, store } = renderWithLevels(1)
    expect(result.current.expanded("a", 1)).toBe(false)
    act(() => store.set(expandedLevelsAtom, 4))
    expect(result.current.expanded("a/b/c", 3)).toBe(true)
  })

  it("reads the frame's depth over the device's setting", () => {
    const { result } = renderWithLevels(1, { depth: 3 })
    expect(result.current.expanded("a/b", 2)).toBe(true)
    expect(result.current.expanded("a/b/c", 3)).toBe(false)
  })

  it("does not keep a fold equal to the default", () => {
    const held = heldFolds()
    const { result, rerender } = renderWithLevels(2, { owned: held })
    // The walk asks of each row before the reader can toggle it.
    expect(result.current.expanded("a", 1)).toBe(true)
    expect(result.current.expanded("a/b", 2)).toBe(false)
    act(() => result.current.setFold("a/b", true))
    rerender({ owned: held })
    expect(sorted(held.folds.open)).toEqual(["a/b"])
    // Closed again, the row is where the rule has it: nothing is kept.
    act(() => result.current.setFold("a/b", false))
    act(() => result.current.setFold("a", true))
    expect(held.folds.open.size + held.folds.closed.size).toBe(0)
  })

  it("never leaves a row un-openable, whatever an old record said", () => {
    // Regression, stuck fold: a bare-id entry used to win over the reader's
    // toggle. The toggle records the decision over any bare-id entry.
    const held = heldFolds()
    held.folds = { open: new Set(), closed: new Set(["b"]) }
    const { result, rerender } = renderWithLevels(1, { owned: held })
    expect(result.current.expanded("a/b", 2)).toBe(false)
    act(() => result.current.setFold("a/b", true))
    rerender({ owned: held })
    expect(result.current.expanded("a/b", 2)).toBe(true)
  })
})

describe("useFoldRule, with rows held open", () => {
  it("opens a held block's rows over the depth setting, and still folds on the reader's say", () => {
    const { result } = renderWithLevels(1, { held: new Set(["b", "c"]) })
    // Level 2 would be closed under the depth setting; held, it is open —
    // every occurrence of the block, by its id.
    expect(result.current.expanded("a/b", 2)).toBe(true)
    expect(result.current.expanded("x/c", 2)).toBe(true)
    expect(result.current.expanded("a/d", 2)).toBe(false)
    // The reader's own fold closes a held row like any other.
    act(() => result.current.setFold("a/b", false))
    expect(result.current.expanded("a/b", 2)).toBe(false)
    expect(result.current.expanded("x/c", 2)).toBe(true)
    act(() => result.current.setFold("a/b", true))
    expect(result.current.expanded("a/b", 2)).toBe(true)
  })
})

describe("useFoldRule, narrowed", () => {
  it("starts fully open whatever the depth setting says", () => {
    const { result } = renderWithLevels(1, { narrowed: true })
    // Level 1 would be closed under the note's depth setting; narrowed, it is open.
    expect(result.current.expanded("a", 1)).toBe(true)
    expect(result.current.expanded("a/b/c", 3)).toBe(true)
    act(() => result.current.setFold("a", false))
    expect(result.current.expanded("a", 1)).toBe(false)
  })
})

describe("folds a frame holds (docs/graph-walk.md, section 5)", () => {
  it("reads and writes the caller's folds, and stores nothing", () => {
    const held = heldFolds()
    held.folds = { open: new Set(), closed: new Set(["a"]) }
    const { result, rerender } = renderWithLevels(2, { owned: held })
    expect(result.current.expanded("a", 1)).toBe(false)
    expect(result.current.expanded("a/b", 2)).toBe(false)
    // Two toggles in one event build on each other.
    act(() => {
      result.current.setFold("a", true)
      result.current.setFold("a/b", true)
    })
    rerender({ owned: held })
    expect(held.changes).toHaveLength(2)
    expect(result.current.expanded("a", 1)).toBe(true)
    expect(result.current.expanded("a/b", 2)).toBe(true)
    expect(Object.keys(localStorage).filter((key) => key.startsWith("collapse:"))).toEqual([])
  })
})
