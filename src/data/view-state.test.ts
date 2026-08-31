// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parse } from "../blocks/parse"
import type { BlockDoc } from "../blocks/types"
import { readCollapsedIds, useCollapseState, writeCollapsedIds } from "./view-state"

/** A four-deep outline with stable ids. The policy collapses `b` and `c` (a
 * parent two or more levels down) and leaves `a` and the leaf `d` open. */
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
  frontmatter: null,
  rootBlockIds: ["blank"],
  blocks: { blank: { id: "blank", content: "", children: [] } },
}

const stored = (noteId: string): unknown => {
  const raw = localStorage.getItem(`collapse:${noteId}`)
  return raw === null ? null : JSON.parse(raw)
}

const ids = (set: ReadonlySet<string>) => [...set].sort()

/** The stored ids, sorted — a set has no meaningful order. */
const storedIds = (noteId: string) => [...((stored(noteId) as string[] | null) ?? [])].sort()

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("readCollapsedIds", () => {
  it("degrades to a seed without a note id, an entry, or usable JSON", () => {
    expect(readCollapsedIds(undefined, deep)).toBe(null)
    expect(readCollapsedIds("nothing-stored", deep)).toBe(null)
    localStorage.setItem("collapse:bad", "[not json")
    expect(readCollapsedIds("bad", deep)).toBe(null)
    localStorage.setItem("collapse:scalar", "5")
    expect(readCollapsedIds("scalar", deep)).toBe(null)
  })

  it("reads back a stored id set, ignoring junk entries", () => {
    localStorage.setItem("collapse:note-a", JSON.stringify(["b", 7, null, "c"]))
    expect(readCollapsedIds("note-a", deep)).toEqual(new Set(["b", "c"]))
  })

  it("migrates the old override shape against the document", () => {
    // Policy is {b, c}; the old record expanded `b` and collapsed `a`.
    localStorage.setItem("collapse:legacy", JSON.stringify({ expanded: ["b"], collapsed: ["a"] }))
    expect(readCollapsedIds("legacy", deep)).toEqual(new Set(["a", "c"]))
  })

  it("resolves an old record naming the same id in both directions", () => {
    // The stuck-collapse bug: an id in both lists. It now resolves to one
    // membership — collapsed — which a single toggle can undo (below).
    localStorage.setItem("collapse:both", JSON.stringify({ expanded: ["b"], collapsed: ["b"] }))
    expect(readCollapsedIds("both", deep)).toEqual(new Set(["b", "c"]))
  })

  it("tolerates an old record with garbage in its lists", () => {
    localStorage.setItem("collapse:junk", JSON.stringify({ expanded: "x", collapsed: [1] }))
    expect(readCollapsedIds("junk", deep)).toEqual(new Set(["b", "c"]))
  })
})

describe("writeCollapsedIds", () => {
  it("drops ids the document no longer has", () => {
    writeCollapsedIds("note-a", new Set(["b", "c"]), pruned)
    expect(stored("note-a")).toEqual(["b"])
  })

  it("writes an empty entry rather than removing it (the note stays seeded)", () => {
    writeCollapsedIds("note-a", new Set(), deep)
    expect(stored("note-a")).toEqual([])
  })
})

describe("useCollapseState", () => {
  it("seeds from the policy on first open and persists the seed", () => {
    const { result } = renderHook(() => useCollapseState("n1", deep))
    expect(ids(result.current.collapsed)).toEqual(["b", "c"])
    expect(storedIds("n1")).toEqual(["b", "c"])
  })

  it("toggles in both directions — one meaning, one direction", () => {
    const { result } = renderHook(() => useCollapseState("n1", deep))
    act(() => result.current.toggleCollapse("b"))
    expect(ids(result.current.collapsed)).toEqual(["c"])
    expect(storedIds("n1")).toEqual(["c"])

    act(() => result.current.toggleCollapse("a"))
    expect(ids(result.current.collapsed)).toEqual(["a", "c"])
    expect(storedIds("n1")).toEqual(["a", "c"])
  })

  it("remembers folds across a remount, without re-seeding", () => {
    const first = renderHook(() => useCollapseState("n1", deep))
    act(() => first.result.current.toggleCollapse("b"))
    act(() => first.result.current.toggleCollapse("c"))
    expect(ids(first.result.current.collapsed)).toEqual([])
    first.unmount()

    // Unfolding everything is a state of its own, not an absent one: the
    // policy must not seed over it on the next open.
    const second = renderHook(() => useCollapseState("n1", deep))
    expect(ids(second.result.current.collapsed)).toEqual([])
  })

  it("seeds a note whose content arrives after mount", () => {
    const { result, rerender } = renderHook(({ doc }) => useCollapseState("late", doc), {
      initialProps: { doc: empty },
    })
    // Nothing to seed from yet — and nothing written, or the note would be
    // stuck fully expanded once its content landed.
    expect(ids(result.current.collapsed)).toEqual([])
    expect(stored("late")).toBe(null)

    rerender({ doc: deep })
    expect(ids(result.current.collapsed)).toEqual(["b", "c"])
    expect(storedIds("late")).toEqual(["b", "c"])
  })

  it("leaves blocks added after the first open expanded", () => {
    const { result, rerender } = renderHook(({ doc }) => useCollapseState("n1", doc), {
      initialProps: { doc: pruned },
    })
    // `pruned` has nothing deep enough to collapse.
    expect(ids(result.current.collapsed)).toEqual([])
    rerender({ doc: deep })
    expect(ids(result.current.collapsed)).toEqual([])
  })

  it("prunes ids the document has lost when it next writes", () => {
    const { result, rerender } = renderHook(({ doc }) => useCollapseState("n1", doc), {
      initialProps: { doc: deep },
    })
    expect(stored("n1")).toEqual(["b", "c"])
    rerender({ doc: pruned })
    act(() => result.current.toggleCollapse("a"))
    expect(storedIds("n1")).toEqual(["a", "b"])
  })

  it("migrates an old override entry on open and rewrites it in the new shape", () => {
    localStorage.setItem("collapse:n1", JSON.stringify({ expanded: ["b"], collapsed: ["a"] }))
    const { result } = renderHook(() => useCollapseState("n1", deep))
    expect(ids(result.current.collapsed)).toEqual(["a", "c"])
    expect(storedIds("n1")).toEqual(["a", "c"])
  })

  it("never leaves a block un-expandable, whatever was stored", () => {
    // Regression, stuck collapse: an old record naming `b` in both directions
    // used to make it permanently collapsed — every toggle recorded another
    // opinion and the collapse won. One toggle now opens it, for good.
    localStorage.setItem("collapse:n1", JSON.stringify({ expanded: ["b"], collapsed: ["b"] }))
    const { result, rerender } = renderHook(({ doc }) => useCollapseState("n1", doc), {
      initialProps: { doc: pruned },
    })
    expect(result.current.collapsed.has("b")).toBe(true)
    act(() => result.current.toggleCollapse("b"))
    expect(result.current.collapsed.has("b")).toBe(false)

    // Regression, the way that record used to be minted: `b` gains children,
    // so the policy would now collapse it. It must not re-collapse behind the
    // reader — the policy is a seed, never consulted again.
    rerender({ doc: deep })
    expect(result.current.collapsed.has("b")).toBe(false)
    act(() => result.current.toggleCollapse("b"))
    act(() => result.current.toggleCollapse("b"))
    expect(result.current.collapsed.has("b")).toBe(false)
  })

  it("works without a note id (Storybook / standalone) and stores nothing", () => {
    const { result } = renderHook(() => useCollapseState(undefined, deep))
    expect(ids(result.current.collapsed)).toEqual(["b", "c"])
    act(() => result.current.toggleCollapse("b"))
    expect(ids(result.current.collapsed)).toEqual(["c"])
    expect(localStorage.length).toBe(0)
  })
})
