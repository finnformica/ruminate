// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import type { BlockDoc } from "../../blocks/types"
import { buildGraphSnapshot, childIdsOf, docToGraph, noteDoc } from "../../data/graph"
import {
  githubUserAtom,
  graphSnapshotAtom,
  isSignedOutAtom,
  sampleGraphAtom,
} from "../../global-state"
import { useNoteDoc } from "../../hooks/note-doc"
import { paletteRequestAtom } from "../palette"
import { BlockNoteEditor } from "./block-note-editor"

/**
 * **A second place for a block, by name** (docs/graph-storage.md, "Linking
 * by name"): the menu's Add downstream link and Add upstream link open the
 * palette as a picker, and the pick is written through the note page's own
 * wiring — `useNoteDoc` over the graph, the editor's doc back as ops — so
 * what lands in the graph is tested here, not what the editor was told.
 */

afterEach(cleanup)

const A = "blk_notea0000"
const B = "blk_noteb0000"
const EMPTY_DOC: BlockDoc = { props: null, rootBlockIds: [], blocks: {} }
const NOTES: Record<string, string> = {
  [A]: "- one\n  id:: blk_one0000000\n- two\n  id:: blk_two0000000\n  - deep\n    id:: blk_deep000000\n",
  [B]: "- other\n  id:: blk_other00000\n  - under other\n    id:: blk_under00000\n",
}

async function signedOutStore() {
  const store = createStore()
  const unsubscribe = store.sub(githubUserAtom, () => {})
  await vi.waitFor(() => {
    expect(store.get(isSignedOutAtom)).toBe(true)
  })
  const nodes = []
  const links = []
  for (const [id, markdown] of Object.entries(NOTES)) {
    const g = docToGraph(id, serialize(parse(markdown)), 1, { title: id })
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, links))
  return { store, unsubscribe }
}

/** The note page's wiring of note A, and nothing else of it. */
function Note() {
  const { doc, context, setDoc } = useNoteDoc({ noteId: A, defaultDoc: EMPTY_DOC })
  return <BlockNoteEditor noteId={A} doc={doc} onChange={setDoc} context={context} />
}

const walk = (store: ReturnType<typeof createStore>, id: string) =>
  serialize(noteDoc(id, store.get(graphSnapshotAtom)) as BlockDoc)

async function choose(container: HTMLElement, index: number, label: string) {
  await act(async () => {
    fireEvent.contextMenu(container.querySelectorAll("[data-occurrence]")[index]!, {
      clientX: 10,
      clientY: 10,
    })
  })
  await act(async () => {
    fireEvent.click(screen.getByText(label))
  })
}

describe("linking by name from the note", () => {
  it("Add downstream link links the picked block beneath the row, in the graph", async () => {
    const { store, unsubscribe } = await signedOutStore()
    const { container } = render(
      <Provider store={store}>
        <Note />
      </Provider>,
    )
    await choose(container, 0, "Add downstream link…")
    const request = store.get(paletteRequestAtom)!
    expect(request.label).toBe("Add downstream link")
    // The note's top rows, the row's own block left out; a note is no pick
    // beneath a block, nor is the row itself.
    expect(request.suggested).toEqual([{ id: "blk_two0000000", noteId: A }])
    expect(request.keep!({ id: B, noteId: B, kind: "note" })).toBe(false)
    expect(request.keep!({ id: "blk_one0000000", noteId: A, kind: "block" })).toBe(false)
    expect(request.keep!({ id: "blk_other00000", noteId: B, kind: "block" })).toBe(true)

    // A block of another note, picked: beneath `one` now, with what it holds,
    // and still in its own note — one block in two places.
    await act(async () => {
      request.onPick({ kind: "block", noteId: B, blockId: "blk_other00000" })
    })
    expect(walk(store, A)).toBe(
      [
        "- one",
        "  id:: blk_one0000000",
        "  - other",
        "    id:: blk_other00000",
        "    - under other",
        "      id:: blk_under00000",
        "- two",
        "  id:: blk_two0000000",
        "  - deep",
        "    id:: blk_deep000000",
        "",
      ].join("\n"),
    )
    expect(walk(store, B)).toBe(serialize(parse(NOTES[B])))
    unsubscribe()
  })

  it("Add upstream link links the row's block beneath the pick — a block, or a note", async () => {
    const { store, unsubscribe } = await signedOutStore()
    const { container } = render(
      <Provider store={store}>
        <Note />
      </Provider>,
    )
    await choose(container, 0, "Add upstream link…")
    const request = store.get(paletteRequestAtom)!
    expect(request.label).toBe("Add upstream link")
    expect(request.suggested).toEqual([{ id: "blk_two0000000", noteId: A }])
    // A note is a pick here: the block would join its top level.
    expect(request.keep!({ id: B, noteId: B, kind: "note" })).toBe(true)
    expect(request.keep!({ id: "blk_one0000000", noteId: A, kind: "block" })).toBe(false)

    // Beneath a block of another note: `one` is there now, last, and here still.
    await act(async () => {
      request.onPick({ kind: "block", noteId: B, blockId: "blk_under00000" })
    })
    expect(childIdsOf(store.get(graphSnapshotAtom), "blk_under00000")).toEqual(["blk_one0000000"])
    expect(walk(store, A)).toBe(serialize(parse(NOTES[A])))

    // Beneath a note: its top level, last.
    await choose(container, 0, "Add upstream link…")
    await act(async () => {
      store.get(paletteRequestAtom)!.onPick({ kind: "note", noteId: B })
    })
    expect(childIdsOf(store.get(graphSnapshotAtom), B)).toEqual([
      "blk_other00000",
      "blk_one0000000",
    ])
    unsubscribe()
  })
})
