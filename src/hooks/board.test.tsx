// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { buildGraphSnapshot, docToGraph } from "../data/graph"
import {
  githubUserAtom,
  isSignedOutAtom,
  notesAtom,
  ownSortedNotesAtom,
  sampleGraphAtom,
} from "../global-state"
import { useMakeBoard, useMakeNote } from "./board"

async function signedOutStore(notes: Record<string, string>) {
  const store = createStore()
  const unsubscribe = store.sub(githubUserAtom, () => {})
  await vi.waitFor(() => {
    expect(store.get(isSignedOutAtom)).toBe(true)
  })
  const nodes = []
  const links = []
  for (const [id, markdown] of Object.entries(notes)) {
    const g = docToGraph(id, serialize(parse(markdown)), 1, { title: id })
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, links))
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  return { store, wrapper, unsubscribe }
}

describe("useMakeBoard", () => {
  it("a board made from nothing is a note on the notes page at once", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({})
    const { result } = renderHook(() => useMakeBoard(), { wrapper })
    act(() => result.current("blk_wall0000000", { title: "Wall" }))
    expect(store.get(notesAtom).get("blk_wall0000000")?.type).toBe("board")
    expect(store.get(ownSortedNotesAtom).map((note) => note.id)).toContain("blk_wall0000000")
    unsubscribe()
  })

  it("a note made a board, and back, keeps its props", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ plain: "- a\n" })
    const makeBoard = renderHook(() => useMakeBoard(), { wrapper })
    act(() => makeBoard.result.current("plain"))
    expect(store.get(notesAtom).get("plain")?.type).toBe("board")
    const makeNote = renderHook(() => useMakeNote(), { wrapper })
    act(() => makeNote.result.current("plain"))
    expect(store.get(notesAtom).get("plain")?.type).toBe("note")
    unsubscribe()
  })
})
