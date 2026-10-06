// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { buildGraphSnapshot, docToGraph } from "../data/graph"
import { viewByRootAtom, viewsAtom, type ViewRow } from "../data/views"
import {
  githubUserAtom,
  isSignedOutAtom,
  notesAtom,
  sampleGraphAtom,
  viewEntriesAtom,
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

const row = (rootId: string, patch: Partial<ViewRow> = {}): ViewRow => ({
  id: rootId,
  root_id: rootId,
  filter: null,
  sort: null,
  pinned: true,
  sort_key: null,
  updated_at: 1,
  ...patch,
})

describe("useMakeBoard", () => {
  it("a board made from nothing is created listed: its view row lands with the node", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({})
    store.set(viewsAtom, new Map())
    const { result } = renderHook(() => useMakeBoard(), { wrapper })
    act(() => result.current("blk_wall0000000", { title: "Wall" }))
    expect(store.get(notesAtom).get("blk_wall0000000")?.type).toBe("board")
    expect(store.get(viewByRootAtom).get("blk_wall0000000")).toMatchObject({ pinned: true })
    expect(store.get(viewEntriesAtom).map((entry) => entry.id)).toEqual(["blk_wall0000000"])
    unsubscribe()
  })

  it("a note made a board keeps the row it has, whatever it says — one row per root", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore({ plain: "- a\n" })
    // Removed from Views, with a saved filter: nothing of that is the
    // board's to change, and a note never made a board is as it was.
    const kept = row("plain", { pinned: false, filter: "type:todo", updated_at: 5 })
    store.set(viewsAtom, new Map([["plain", kept]]))
    const makeBoard = renderHook(() => useMakeBoard(), { wrapper })
    act(() => makeBoard.result.current("plain"))
    expect(store.get(notesAtom).get("plain")?.type).toBe("board")
    expect(store.get(viewByRootAtom).get("plain")).toBe(kept)
    const makeNote = renderHook(() => useMakeNote(), { wrapper })
    act(() => makeNote.result.current("plain"))
    expect(store.get(notesAtom).get("plain")?.type).toBe("note")
    expect(store.get(viewByRootAtom).get("plain")).toBe(kept)
    unsubscribe()
  })
})
