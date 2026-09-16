// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { emptyBlock, insertAfter, updateText } from "../blocks/ops"
import { buildGraphSnapshot, docToGraph, noteDoc } from "../data/graph"
import { applyOps, deleteBlockOps } from "../data/ops"
import { githubUserAtom, isSignedOutAtom, sampleGraphAtom } from "../global-state"
import { useBasketDoc, useNoteDoc } from "./note-doc"

/**
 * The note page's doc, over the signed-out sample graph: the walk in, ops
 * out. (Signed in the same ops go to the database runtime — covered in
 * database-mode.test.ts.)
 */

const NOTE = "- one\n  id:: blk_one0000000\n- two\n  id:: blk_two0000000\n"

/** The content lines of a doc: `id::` lines dropped. */
const body = (markdown: string) =>
  markdown
    .split("\n")
    .filter((line) => !line.trim().startsWith("id::"))
    .join("\n")

async function signedOutStore(notes: Record<string, string>) {
  const store = createStore()
  const unsubscribe = store.sub(githubUserAtom, () => {})
  await vi.waitFor(() => {
    expect(store.get(isSignedOutAtom)).toBe(true)
  })
  const nodes = []
  const links = []
  for (const [id, markdown] of Object.entries(notes)) {
    const g = docToGraph(id, serialize(parse(markdown)), 1)
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, links))
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  return { store, wrapper, unsubscribe }
}

describe("useNoteDoc", () => {
  it("walks the note out of the graph, and a change becomes ops applied to it", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ n: NOTE })
    const { result } = renderHook(() => useNoteDoc({ noteId: "n", defaultDoc: parse("") }), {
      wrapper,
    })
    expect(result.current.exists).toBe(true)
    expect(body(serialize(result.current.doc))).toBe(body(NOTE))

    act(() => result.current.setDoc(updateText(result.current.doc, "blk_one0000000", "edited")))
    const stored = noteDoc("n", store.get(sampleGraphAtom))!
    expect(body(serialize(stored))).toBe(body(NOTE.replace("- one", "- edited")))
    // The hook re-walks: what it holds IS the graph.
    expect(serialize(result.current.doc)).toBe(serialize(stored))
    // Every change stamps the note's updated_at.
    expect(typeof stored.props?.updated_at).toBe("string")
    unsubscribe()
  })

  it("zoomed, walks the block as the root, and an edit beneath it stamps the note", async () => {
    const deep =
      "- one\n  id:: blk_one0000000\n  - deep\n    id:: blk_deep000000\n- two\n  id:: blk_two0000000\n"
    const { store, wrapper, unsubscribe } = await signedOutStore({ n: deep })
    const { result } = renderHook(
      () => useNoteDoc({ noteId: "n", defaultDoc: parse(""), zoomBlockId: "blk_one0000000" }),
      { wrapper },
    )
    expect(result.current.exists).toBe(true)
    expect(result.current.doc.rootBlockIds).toEqual(["blk_one0000000"])
    expect(result.current.doc.props).toBe(null)

    act(() => result.current.setDoc(updateText(result.current.doc, "blk_deep000000", "edited")))
    const stored = noteDoc("n", store.get(sampleGraphAtom))!
    expect(body(serialize(stored))).toBe(body(deep.replace("- deep", "- edited")))
    expect(typeof stored.props?.updated_at).toBe("string")
    // The note's own root order is untouched by the zoomed diff.
    expect(stored.rootBlockIds).toEqual(["blk_one0000000", "blk_two0000000"])
    unsubscribe()
  })

  it("zoomed into a block the graph lacks, falls back to the note", async () => {
    const { wrapper, unsubscribe } = await signedOutStore({ n: NOTE })
    const { result } = renderHook(
      () => useNoteDoc({ noteId: "n", defaultDoc: parse(""), zoomBlockId: "blk_gone" }),
      { wrapper },
    )
    expect(result.current.doc.rootBlockIds).toEqual(["blk_one0000000", "blk_two0000000"])
    unsubscribe()
  })

  it("walks by the fold rule and reports what it folded", async () => {
    const deep =
      "- one\n  id:: blk_one0000000\n  - deep\n    id:: blk_deep000000\n    - deeper\n      id:: blk_deeper0000\n"
    const { wrapper, unsubscribe } = await signedOutStore({ n: deep })
    const { result } = renderHook(
      () =>
        useNoteDoc({
          noteId: "n",
          defaultDoc: parse(""),
          expanded: (_key, level) => level < 2,
        }),
      { wrapper },
    )
    expect([...result.current.collapsed]).toEqual(["blk_one0000000/blk_deep000000"])
    expect(result.current.doc.blocks.blk_deeper0000).toBeUndefined()
    unsubscribe()
  })

  it("a new note starts from the default doc and is created by its first real edit", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({})
    const { result } = renderHook(
      () => useNoteDoc({ noteId: "fresh", defaultDoc: parse("- from ?content=\n") }),
      { wrapper },
    )
    expect(result.current.exists).toBe(false)
    expect(body(serialize(result.current.doc))).toBe("- from ?content=\n")

    // An empty doc is not worth a note.
    act(() => result.current.setDoc(parse("")))
    expect(store.get(sampleGraphAtom).nodes.has("fresh")).toBe(false)

    act(() =>
      result.current.setDoc(
        insertAfter(
          result.current.doc,
          result.current.doc.rootBlockIds[0],
          emptyBlock("ul", "typed"),
        ),
      ),
    )
    expect(store.get(sampleGraphAtom).nodes.get("fresh")?.type).toBe("note")
    expect(result.current.exists).toBe(true)
    expect(body(serialize(result.current.doc))).toContain("- typed")
    unsubscribe()
  })

  it("a note deleted while open stays deleted — a trailing change never resurrects it", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ n: NOTE })
    const { result } = renderHook(() => useNoteDoc({ noteId: "n", defaultDoc: parse("") }), {
      wrapper,
    })
    const held = result.current.doc
    act(() => store.set(sampleGraphAtom, buildGraphSnapshot([], [])))
    expect(result.current.exists).toBe(false)

    act(() => result.current.setDoc(updateText(held, "blk_one0000000", "too late")))
    expect(store.get(sampleGraphAtom).nodes.size).toBe(0)
    unsubscribe()
  })

  it("an unchanged doc handed back is no change at all (no ops, no stamp)", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ n: NOTE })
    const before = store.get(sampleGraphAtom)
    const { result } = renderHook(() => useNoteDoc({ noteId: "n", defaultDoc: parse("") }), {
      wrapper,
    })
    act(() => result.current.setDoc(result.current.doc))
    // Only the stamp differs — and only the note row carries it.
    const after = store.get(sampleGraphAtom)
    expect(after.nodes.get("blk_one0000000")).toBe(before.nodes.get("blk_one0000000"))
    expect(after.childLinks.get("n")).toBe(before.childLinks.get("n"))
    unsubscribe()
  })
})

describe("useBasketDoc", () => {
  const OUTLINE =
    "- one\n  id:: blk_one0000000\n  - under\n    id:: blk_under00000\n- two\n  id:: blk_two0000000\n"

  it("is empty until a block falls out of reach, then edits it like the outline", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ n: OUTLINE })
    // `graphOf`-style seeding carries no note ids; give `under` n's by hand.
    const graph = store.get(sampleGraphAtom)
    graph.nodes.set("blk_under00000", { ...graph.nodes.get("blk_under00000")!, notes_id: "n" })
    store.set(sampleGraphAtom, { ...graph })
    const { result } = renderHook(() => useBasketDoc("n"), { wrapper })
    expect(result.current.count).toBe(0)

    act(() => {
      const graph = store.get(sampleGraphAtom)
      store.set(sampleGraphAtom, applyOps(graph, deleteBlockOps("blk_one0000000", graph), 5))
    })
    expect(result.current.count).toBe(1)
    expect(body(serialize(result.current.doc!))).toBe("- under\n")

    // Editing the basket row is a setText on the block; the outline is untouched.
    act(() => result.current.setDoc(updateText(result.current.doc!, "blk_under00000", "kept")))
    expect(store.get(sampleGraphAtom).nodes.get("blk_under00000")?.text).toBe("kept")
    expect(body(serialize(noteDoc("n", store.get(sampleGraphAtom))!))).toBe("- two\n")
    // Deleting it from the basket deletes it for good.
    act(() => result.current.setDoc(parse("")))
    expect(result.current.count).toBe(0)
    expect(store.get(sampleGraphAtom).nodes.has("blk_under00000")).toBe(false)
    unsubscribe()
  })
})
