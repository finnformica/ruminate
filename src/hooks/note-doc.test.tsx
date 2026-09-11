// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { emptyBlock, insertAfter, updateText } from "../blocks/ops"
import { buildGraphSnapshot, docToGraph, pageDoc } from "../data/graph"
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

async function signedOutStore(pages: Record<string, string>) {
  const store = createStore()
  const unsubscribe = store.sub(githubUserAtom, () => {})
  await vi.waitFor(() => {
    expect(store.get(isSignedOutAtom)).toBe(true)
  })
  const nodes = []
  const links = []
  for (const [id, markdown] of Object.entries(pages)) {
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
  it("walks the page out of the graph, and a change becomes ops applied to it", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ n: NOTE })
    const { result } = renderHook(() => useNoteDoc({ noteId: "n", defaultDoc: parse("") }), {
      wrapper,
    })
    expect(result.current.exists).toBe(true)
    expect(body(serialize(result.current.doc))).toBe(body(NOTE))

    act(() => result.current.setDoc(updateText(result.current.doc, "blk_one0000000", "edited")))
    const stored = pageDoc("n", store.get(sampleGraphAtom))!
    expect(body(serialize(stored))).toBe(body(NOTE.replace("- one", "- edited")))
    // The hook re-walks: what it holds IS the graph.
    expect(serialize(result.current.doc)).toBe(serialize(stored))
    // Every change stamps the page's updated_at.
    expect(typeof stored.props?.updated_at).toBe("string")
    unsubscribe()
  })

  it("a new page starts from the default doc and is created by its first real edit", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({})
    const { result } = renderHook(
      () => useNoteDoc({ noteId: "fresh", defaultDoc: parse("- from ?content=\n") }),
      { wrapper },
    )
    expect(result.current.exists).toBe(false)
    expect(body(serialize(result.current.doc))).toBe("- from ?content=\n")

    // An empty doc is not worth a page.
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
    expect(store.get(sampleGraphAtom).nodes.get("fresh")?.type).toBe("page")
    expect(result.current.exists).toBe(true)
    expect(body(serialize(result.current.doc))).toContain("- typed")
    unsubscribe()
  })

  it("a page deleted while open stays deleted — a trailing change never resurrects it", async () => {
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
    // Only the stamp differs — and only the page row carries it.
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
    expect(body(serialize(pageDoc("n", store.get(sampleGraphAtom))!))).toBe("- two\n")
    // Deleting it from the basket deletes it for good.
    act(() => result.current.setDoc(parse("")))
    expect(result.current.count).toBe(0)
    expect(store.get(sampleGraphAtom).nodes.has("blk_under00000")).toBe(false)
    unsubscribe()
  })
})
