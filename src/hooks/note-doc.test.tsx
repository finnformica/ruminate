// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import type { BlockDoc } from "../blocks/types"
import { buildGraphSnapshot, childIdsOf, docToGraph } from "../data/graph"
import {
  githubUserAtom,
  graphSnapshotAtom,
  isSignedOutAtom,
  sampleGraphAtom,
} from "../global-state"
import { useNoteDoc } from "./note-doc"

/**
 * **A filtered view is a selection of the note, and must never be mistaken
 * for the note.** Its doc holds only the rows that survived, so reconciling
 * it against the graph would read every hidden row as removed — and a
 * removal is an unlink. These tests hold that line: what a narrowed view
 * writes is the value of the row you touched, and nothing else.
 */

const NOTE_ID = "blk_note00000"

const NOTE = `- Shopping
  id:: blk_shop000000
  - [ ] milk
    id:: blk_milk000000
  - [x] bread
    id:: blk_bread00000
- Reading
  id:: blk_read000000
  - a book
    id:: blk_book000000
`

async function signedOutStore(markdown: string) {
  const store = createStore()
  const unsubscribe = store.sub(githubUserAtom, () => {})
  await vi.waitFor(() => {
    expect(store.get(isSignedOutAtom)).toBe(true)
  })
  const { nodes, links } = docToGraph(NOTE_ID, serialize(parse(markdown)), 1, { title: "Note" })
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, links))
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  return { store, wrapper, unsubscribe }
}

const EMPTY_DOC: BlockDoc = { props: null, rootBlockIds: [], blocks: {} }

/** The rows a view draws, outermost first, each with whether it is dimmed. */
function rows(doc: BlockDoc, context: ReadonlySet<string>): string[] {
  const out: string[] = []
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block) continue
      out.push(`${"  ".repeat(depth)}${context.has(id) ? "~" : ""}${block.text}`)
      walk(block.children, depth + 1)
    }
  }
  walk(doc.rootBlockIds, 0)
  return out
}

type Wrapper = ({ children }: { children: ReactNode }) => ReactNode

function renderNote(wrapper: Wrapper, filter = "", sort = "") {
  return renderHook(() => useNoteDoc({ noteId: NOTE_ID, defaultDoc: EMPTY_DOC, filter, sort }), {
    wrapper,
  })
}

describe("useNoteDoc, filtered", () => {
  it("draws the matches with their ancestors, the ancestors dimmed", async () => {
    const { wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result } = renderNote(wrapper, "type:todo")
    expect(rows(result.current.doc, result.current.context)).toEqual(["~Shopping", "  milk"])
    expect(result.current.matches).toBe(1)
    unsubscribe()
  })

  it("leaves the note whole when nothing is filtered", async () => {
    const { wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result } = renderNote(wrapper)
    expect(rows(result.current.doc, result.current.context)).toEqual([
      "Shopping",
      "  milk",
      "  bread",
      "Reading",
      "  a book",
    ])
    expect(result.current.matches).toBe(null)
    unsubscribe()
  })

  it("ticking a to-do writes the type and strands nothing", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result } = renderNote(wrapper, "type:todo")

    // Tick `milk`, exactly as the editor would hand it back: the same doc,
    // the row's type changed.
    act(() => {
      const doc = result.current.doc
      result.current.setDoc({
        ...doc,
        blocks: { ...doc.blocks, blk_milk000000: { ...doc.blocks.blk_milk000000, type: "done" } },
      })
    })

    const graph = store.get(graphSnapshotAtom)
    expect(graph.nodes.get("blk_milk000000")?.type).toBe("done")
    // Everything the filter hid is still exactly where it was.
    expect(childIdsOf(graph, NOTE_ID)).toEqual(["blk_shop000000", "blk_read000000"])
    expect(childIdsOf(graph, "blk_shop000000")).toEqual(["blk_milk000000", "blk_bread00000"])
    expect(childIdsOf(graph, "blk_read000000")).toEqual(["blk_book000000"])
    expect(graph.nodes.get("blk_bread00000")?.text).toBe("bread")
    expect(graph.nodes.get("blk_book000000")?.text).toBe("a book")
    unsubscribe()
  })

  it("refuses a structural change while narrowed, and strands nothing", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result } = renderNote(wrapper, "type:todo")

    // The worst case: the view hands back a doc with a root removed.
    act(() => {
      const doc = result.current.doc
      result.current.setDoc({ ...doc, rootBlockIds: [] })
    })

    const graph = store.get(graphSnapshotAtom)
    expect(childIdsOf(graph, NOTE_ID)).toEqual(["blk_shop000000", "blk_read000000"])
    expect(childIdsOf(graph, "blk_shop000000")).toEqual(["blk_milk000000", "blk_bread00000"])
    unsubscribe()
  })

  it("a sort reorders the rows without reordering the note", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result } = renderNote(wrapper, "", "text")
    expect(rows(result.current.doc, result.current.context)).toEqual([
      "Reading",
      "  a book",
      "Shopping",
      "  bread",
      "  milk",
    ])

    // Handing that sorted doc back must not write the order into the graph.
    act(() => {
      result.current.setDoc(result.current.doc)
    })
    const graph = store.get(graphSnapshotAtom)
    expect(childIdsOf(graph, NOTE_ID)).toEqual(["blk_shop000000", "blk_read000000"])
    expect(childIdsOf(graph, "blk_shop000000")).toEqual(["blk_milk000000", "blk_bread00000"])
    unsubscribe()
  })

  it("still edits the note's structure when nothing is narrowed", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result } = renderNote(wrapper)

    act(() => {
      const doc = result.current.doc
      result.current.setDoc({
        ...doc,
        rootBlockIds: doc.rootBlockIds.filter((id) => id !== "blk_read000000"),
      })
    })

    // Unfiltered, a removed row is a removed row (an unlink — the block
    // itself survives in the note's Unassigned basket).
    expect(childIdsOf(store.get(graphSnapshotAtom), NOTE_ID)).toEqual(["blk_shop000000"])
    unsubscribe()
  })
})
