// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { buildGraphSnapshot, docToGraph, noteDoc } from "../data/graph"
import { notePropsEntries } from "../data/note-meta"
import { githubUserAtom, isSignedOutAtom, notesAtom, sampleGraphAtom } from "../global-state"
import { useCreateNote, useDeleteNote, useRenameNote, useSetNoteProps } from "./note"

/**
 * The note-level writers, over the signed-out sample graph: each is one
 * batch of ops on the note node (or, for delete, the note and what only it
 * held). Signed in the same ops go to the database runtime.
 */

/** A note fixture: its markdown body, with its metadata as props. */
type Note = string | { markdown: string; props: Record<string, unknown> }

async function signedOutStore(notes: Record<string, Note>) {
  const store = createStore()
  const unsubscribe = store.sub(githubUserAtom, () => {})
  await vi.waitFor(() => {
    expect(store.get(isSignedOutAtom)).toBe(true)
  })
  const nodes = []
  const links = []
  for (const [id, note] of Object.entries(notes)) {
    const { markdown, props } = typeof note === "string" ? { markdown: note, props: null } : note
    const g = docToGraph(id, serialize(parse(markdown)), 1, props)
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, links))
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  return { store, wrapper, unsubscribe }
}

const NOTE = { markdown: "- body\n  id:: blk_body000000\n", props: { title: "Old Name" } }

describe("useRenameNote", () => {
  it("sets the note node's text — one row, same id, nothing deleted", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ blk_note00000: NOTE })
    const { result } = renderHook(() => useRenameNote(), { wrapper })
    let changed = false
    act(() => {
      changed = result.current({ noteId: "blk_note00000", newTitle: "New Name" })
    })
    expect(changed).toBe(true)
    const snapshot = store.get(sampleGraphAtom)
    expect(snapshot.nodes.get("blk_note00000")?.text).toBe("New Name")
    expect(store.get(notesAtom).get("blk_note00000")?.title).toBe("New Name")
    // The blocks are untouched, and the rename stamps updated_at.
    expect(serialize(noteDoc("blk_note00000", snapshot)!)).toContain(
      "- body\n  id:: blk_body000000",
    )
    expect(notePropsEntries(snapshot.nodes.get("blk_note00000")!.props).updated_at).toBeDefined()
    unsubscribe()
  })

  it("accepts titles the old filename charset forbade", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ blk_note00000: NOTE })
    const { result } = renderHook(() => useRenameNote(), { wrapper })
    for (const title of ["Q3: the plan", "What? [draft]", "a|b#c"]) {
      act(() => {
        result.current({ noteId: "blk_note00000", newTitle: title })
      })
      expect(store.get(sampleGraphAtom).nodes.get("blk_note00000")?.text).toBe(title)
    }
    unsubscribe()
  })

  it("an emptied title puts the note back to untitled (its text is its id)", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ blk_note00000: NOTE })
    const { result } = renderHook(() => useRenameNote(), { wrapper })
    act(() => {
      result.current({ noteId: "blk_note00000", newTitle: "   " })
    })
    expect(store.get(sampleGraphAtom).nodes.get("blk_note00000")?.text).toBe("blk_note00000")
    expect(store.get(notesAtom).get("blk_note00000")?.title).toBe("")
    unsubscribe()
  })

  it("does nothing when the title is unchanged, or the note unknown", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ blk_note00000: NOTE })
    const before = store.get(sampleGraphAtom)
    const { result } = renderHook(() => useRenameNote(), { wrapper })
    expect(result.current({ noteId: "blk_note00000", newTitle: "  Old Name  " })).toBe(false)
    expect(result.current({ noteId: "nope", newTitle: "x" })).toBe(false)
    expect(store.get(sampleGraphAtom)).toBe(before)
    unsubscribe()
  })
})

describe("useSetNoteProps", () => {
  it("merges a patch into the note's props, removing null keys, and stamps updated_at", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({
      p: { markdown: "- x\n", props: { pinned: true } },
    })
    const { result } = renderHook(() => useSetNoteProps(), { wrapper })
    act(() => result.current("p", { width: "full", pinned: null }))
    const entries = notePropsEntries(store.get(sampleGraphAtom).nodes.get("p")!.props)
    expect(entries.width).toBe("full")
    expect(entries.pinned).toBeUndefined()
    expect(typeof entries.updated_at).toBe("string")
    const note = store.get(notesAtom).get("p")!
    expect(note.props.width).toBe("full")
    unsubscribe()
  })
})

describe("useCreateNote", () => {
  it("creates a titled note node, once", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({})
    const { result } = renderHook(() => useCreateNote(), { wrapper })
    act(() => result.current("blk_fresh00000", { title: "Fresh", props: { width: "full" } }))
    const note = store.get(notesAtom).get("blk_fresh00000")!
    expect(note.title).toBe("Fresh")
    expect(note.props.width).toBe("full")
    expect(note.updatedAt).not.toBeNull()
    // A second create of the same id is a no-op.
    act(() => result.current("blk_fresh00000", { title: "Again" }))
    expect(store.get(notesAtom).get("blk_fresh00000")?.title).toBe("Fresh")
    unsubscribe()
  })
})

describe("useDeleteNote", () => {
  it("deletes the note and what only it held; a shared block survives", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({
      a: "- shared\n  id:: blk_shared0000\n- only a\n  id:: blk_onlya00000\n",
      b: "- b\n  id:: blk_b000000000\n",
    })
    // b links the shared block too.
    const linked = { ...store.get(sampleGraphAtom) }
    const list = [...(linked.childLinks.get("b") ?? [])]
    list.push({
      source_id: "b",
      destination_id: "blk_shared0000",
      kind: "child",
      sort_key: "a1",
      updated_at: 2,
    })
    linked.childLinks = new Map(linked.childLinks)
    linked.childLinks.set("b", list)
    store.set(sampleGraphAtom, linked)

    const { result } = renderHook(() => useDeleteNote(), { wrapper })
    await act(() => result.current("a"))
    const snapshot = store.get(sampleGraphAtom)
    expect(snapshot.nodes.has("a")).toBe(false)
    expect(snapshot.nodes.has("blk_onlya00000")).toBe(false)
    expect(snapshot.nodes.has("blk_shared0000")).toBe(true)
    expect(store.get(notesAtom).has("a")).toBe(false)
    expect(serialize(noteDoc("b", snapshot)!)).toContain("- shared")
    unsubscribe()
  })
})
