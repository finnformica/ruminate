// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import type { BlockDoc } from "../blocks/types"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { expandedLevelsAtom } from "../global-state"
import {
  MAX_STORED_NOTES,
  clearStoredFolds,
  readCollapsedKeys,
  useCollapseState,
  writeCollapsedKeys,
} from "./view-state"

/** A four-deep outline with stable ids — occurrence keys `a`, `a/b`, `a/b/c`,
 * `a/b/c/d`. The policy collapses `b` and `c` (a parent two or more levels
 * down) and leaves `a` and the leaf `d` open. */
const deep = parse(
  [
    "- alpha",
    "  id:: a",
    "  - beta",
    "    id:: b",
    "    - gamma",
    "      id:: c",
    "      - delta",
    "        id:: d",
    "",
  ].join("\n"),
)

/** The same note with `c`/`d` gone — a block the stored set may still name. */
const pruned = parse(["- alpha", "  id:: a", "  - beta", "    id:: b", ""].join("\n"))

/** What a note is on a cold load: nothing but the editor's starter blank,
 * because the note store hasn't opened yet. */
const empty: BlockDoc = {
  props: null,
  rootBlockIds: ["blank"],
  blocks: { blank: { id: "blank", type: "text", text: "", children: [] } },
}

const stored = (noteId: string): unknown => {
  const raw = localStorage.getItem(`collapse:${noteId}`)
  return raw === null ? null : JSON.parse(raw)
}

const keys = (set: ReadonlySet<string>) => [...set].sort()

/** The stored keys, sorted — a set has no meaningful order. */
const storedKeys = (noteId: string) => {
  const entry = stored(noteId) as { collapsed?: string[] } | string[] | null
  const list = Array.isArray(entry) ? entry : (entry?.collapsed ?? [])
  return [...list].sort()
}

/** Render the hook against a store with the given depth setting. */
function renderWithLevels(levels: number, noteId: string | undefined, initial: BlockDoc) {
  const store = createStore()
  store.set(expandedLevelsAtom, levels)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  const rendered = renderHook(({ doc }) => useCollapseState(noteId, doc), {
    initialProps: { doc: initial },
    wrapper,
  })
  return { ...rendered, store }
}

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("readCollapsedKeys", () => {
  it("degrades to a seed without a note id, an entry, or usable JSON", () => {
    expect(readCollapsedKeys(undefined, deep)).toBe(null)
    expect(readCollapsedKeys("nothing-stored", deep)).toBe(null)
    localStorage.setItem("collapse:bad", "[not json")
    expect(readCollapsedKeys("bad", deep)).toBe(null)
    localStorage.setItem("collapse:scalar", "5")
    expect(readCollapsedKeys("scalar", deep)).toBe(null)
  })

  it("reads back a stored key set, ignoring junk entries", () => {
    localStorage.setItem("collapse:note-a", JSON.stringify(["a/b", 7, null, "a/b/c"]))
    expect(readCollapsedKeys("note-a", deep)).toEqual(new Set(["a/b", "a/b/c"]))
    localStorage.setItem(
      "collapse:note-b",
      JSON.stringify({ v: 2, collapsed: ["a/b", 7, "a/b/c"], t: 1 }),
    )
    expect(readCollapsedKeys("note-b", deep)).toEqual(new Set(["a/b", "a/b/c"]))
  })

  it("resolves entries stored as block ids (pre-occurrence folds) to every occurrence", () => {
    localStorage.setItem("collapse:note-a", JSON.stringify(["b", "c"]))
    expect(readCollapsedKeys("note-a", deep)).toEqual(new Set(["a/b", "a/b/c"]))
    // A shared block folded by id is folded wherever it shows up.
    const shared: BlockDoc = {
      props: null,
      rootBlockIds: ["p", "q"],
      blocks: {
        p: { id: "p", type: "ul", text: "p", children: ["s"] },
        q: { id: "q", type: "ul", text: "q", children: ["s"] },
        s: { id: "s", type: "ul", text: "s", children: ["t"] },
        t: { id: "t", type: "ul", text: "t", children: [] },
      },
    }
    localStorage.setItem("collapse:shared", JSON.stringify(["s"]))
    expect(readCollapsedKeys("shared", shared)).toEqual(new Set(["p/s", "q/s"]))
  })

  it("migrates the old override shape against the document", () => {
    // Policy is {b, c}; the old record expanded `b` and collapsed `a`.
    localStorage.setItem("collapse:legacy", JSON.stringify({ expanded: ["b"], collapsed: ["a"] }))
    expect(readCollapsedKeys("legacy", deep)).toEqual(new Set(["a", "a/b/c"]))
  })

  it("resolves an old record naming the same id in both directions", () => {
    // The stuck-collapse bug: an id in both lists. It now resolves to one
    // membership — collapsed — which a single toggle can undo (below).
    localStorage.setItem("collapse:both", JSON.stringify({ expanded: ["b"], collapsed: ["b"] }))
    expect(readCollapsedKeys("both", deep)).toEqual(new Set(["a/b", "a/b/c"]))
  })

  it("tolerates an old record with garbage in its lists", () => {
    localStorage.setItem("collapse:junk", JSON.stringify({ expanded: "x", collapsed: [1] }))
    expect(readCollapsedKeys("junk", deep)).toEqual(new Set(["a/b", "a/b/c"]))
  })
})

describe("writeCollapsedKeys", () => {
  it("drops occurrences the document no longer has", () => {
    writeCollapsedKeys("note-a", new Set(["a/b", "a/b/c"]), pruned)
    expect(storedKeys("note-a")).toEqual(["a/b"])
  })

  it("writes an empty entry rather than removing it (everything unfolded is a state)", () => {
    writeCollapsedKeys("note-a", new Set(), deep)
    expect(stored("note-a")).toMatchObject({ v: 2, collapsed: [] })
  })

  it("keeps at most MAX_STORED_NOTES notes, dropping the least recently written", () => {
    for (let i = 0; i < MAX_STORED_NOTES - 1; i += 1) {
      localStorage.setItem(`collapse:n${i}`, JSON.stringify({ v: 2, collapsed: [], t: i + 1 }))
    }
    // An entry in the old shape has no time: it is the oldest of all.
    localStorage.setItem("collapse:old", JSON.stringify(["a/b"]))
    writeCollapsedKeys("fresh", new Set(["a/b"]), deep)
    expect(stored("old")).toBe(null)
    expect(stored("n0")).not.toBe(null)
    expect(stored("fresh")).not.toBe(null)
    // One more, and the oldest timed entry goes.
    writeCollapsedKeys("fresher", new Set(), deep)
    expect(stored("n0")).toBe(null)
    expect(stored("n1")).not.toBe(null)
  })

  it("clearStoredFolds forgets every note's folds and nothing else", () => {
    writeCollapsedKeys("a", new Set(["a/b"]), deep)
    writeCollapsedKeys("b", new Set(), deep)
    localStorage.setItem("accent", "cyan")
    expect(clearStoredFolds()).toBe(2)
    expect(stored("a")).toBe(null)
    expect(localStorage.getItem("accent")).toBe("cyan")
  })
})

describe("useCollapseState", () => {
  it("opens as the policy says, and stores nothing until the reader folds", () => {
    const { result } = renderHook(() => useCollapseState("n1", deep))
    expect(keys(result.current.collapsed)).toEqual(["a/b", "a/b/c"])
    expect(stored("n1")).toBe(null)
  })

  it("opens to the depth the reader chose", () => {
    expect(keys(renderWithLevels(1, "n1", deep).result.current.collapsed)).toEqual([
      "a",
      "a/b",
      "a/b/c",
    ])
    expect(keys(renderWithLevels(4, "n1", deep).result.current.collapsed)).toEqual([])
  })

  it("a changed depth re-seeds a note the reader never touched, and leaves one they did", () => {
    const untouched = renderWithLevels(2, "n1", deep)
    expect(keys(untouched.result.current.collapsed)).toEqual(["a/b", "a/b/c"])
    act(() => untouched.store.set(expandedLevelsAtom, 4))
    expect(keys(untouched.result.current.collapsed)).toEqual([])

    const touched = renderWithLevels(2, "n2", deep)
    act(() => touched.result.current.toggleCollapse("a/b"))
    expect(keys(touched.result.current.collapsed)).toEqual(["a/b/c"])
    act(() => touched.store.set(expandedLevelsAtom, 4))
    expect(keys(touched.result.current.collapsed)).toEqual(["a/b/c"])
  })

  it("toggles in both directions — one meaning, one direction", () => {
    const { result } = renderHook(() => useCollapseState("n1", deep))
    act(() => result.current.toggleCollapse("a/b"))
    expect(keys(result.current.collapsed)).toEqual(["a/b/c"])
    expect(storedKeys("n1")).toEqual(["a/b/c"])

    act(() => result.current.toggleCollapse("a"))
    expect(keys(result.current.collapsed)).toEqual(["a", "a/b/c"])
    expect(storedKeys("n1")).toEqual(["a", "a/b/c"])
  })

  it("remembers folds across a remount, without re-seeding", () => {
    const first = renderHook(() => useCollapseState("n1", deep))
    act(() => first.result.current.toggleCollapse("a/b"))
    act(() => first.result.current.toggleCollapse("a/b/c"))
    expect(keys(first.result.current.collapsed)).toEqual([])
    first.unmount()

    // Unfolding everything is a state of its own, not an absent one: the
    // policy must not seed over it on the next open.
    const second = renderHook(() => useCollapseState("n1", deep))
    expect(keys(second.result.current.collapsed)).toEqual([])
  })

  it("seeds a note whose content arrives after mount", () => {
    const { result, rerender } = renderHook(({ doc }) => useCollapseState("late", doc), {
      initialProps: { doc: empty },
    })
    // Nothing to seed from yet.
    expect(keys(result.current.collapsed)).toEqual([])
    rerender({ doc: deep })
    expect(keys(result.current.collapsed)).toEqual(["a/b", "a/b/c"])
  })

  it("leaves blocks added after the first open expanded", () => {
    const { result, rerender } = renderHook(({ doc }) => useCollapseState("n1", doc), {
      initialProps: { doc: pruned },
    })
    // `pruned` has nothing deep enough to collapse.
    expect(keys(result.current.collapsed)).toEqual([])
    rerender({ doc: deep })
    expect(keys(result.current.collapsed)).toEqual([])
  })

  it("prunes ids the document has lost when it next writes", () => {
    const { result, rerender } = renderHook(({ doc }) => useCollapseState("n1", doc), {
      initialProps: { doc: deep },
    })
    act(() => result.current.toggleCollapse("a"))
    expect(storedKeys("n1")).toEqual(["a", "a/b", "a/b/c"])
    rerender({ doc: pruned })
    act(() => result.current.toggleCollapse("a"))
    expect(storedKeys("n1")).toEqual(["a/b"])
  })

  it("migrates an old override entry on open and rewrites it in the new shape", () => {
    localStorage.setItem("collapse:n1", JSON.stringify({ expanded: ["b"], collapsed: ["a"] }))
    const { result } = renderHook(() => useCollapseState("n1", deep))
    expect(keys(result.current.collapsed)).toEqual(["a", "a/b/c"])
    expect(storedKeys("n1")).toEqual(["a", "a/b/c"])
    expect(stored("n1")).toMatchObject({ v: 2 })
  })

  it("never leaves a block un-expandable, whatever was stored", () => {
    // Regression, stuck collapse: an old record naming `b` in both directions
    // used to make it permanently collapsed — every toggle recorded another
    // opinion and the collapse won. One toggle now opens it, for good.
    localStorage.setItem("collapse:n1", JSON.stringify({ expanded: ["b"], collapsed: ["b"] }))
    const { result, rerender } = renderHook(({ doc }) => useCollapseState("n1", doc), {
      initialProps: { doc: pruned },
    })
    expect(result.current.collapsed.has("a/b")).toBe(true)
    act(() => result.current.toggleCollapse("a/b"))
    expect(result.current.collapsed.has("a/b")).toBe(false)

    // Regression, the way that record used to be minted: `b` gains children,
    // so the policy would now collapse it. It must not re-collapse behind the
    // reader — the policy is a seed, never consulted again.
    rerender({ doc: deep })
    expect(result.current.collapsed.has("a/b")).toBe(false)
    act(() => result.current.toggleCollapse("a/b"))
    act(() => result.current.toggleCollapse("a/b"))
    expect(result.current.collapsed.has("a/b")).toBe(false)
  })

  it("works without a note id (Storybook / standalone) and stores nothing", () => {
    const { result } = renderHook(() => useCollapseState(undefined, deep))
    expect(keys(result.current.collapsed)).toEqual(["a/b", "a/b/c"])
    act(() => result.current.toggleCollapse("a/b"))
    expect(keys(result.current.collapsed)).toEqual(["a/b/c"])
    expect(localStorage.length).toBe(0)
  })
})
