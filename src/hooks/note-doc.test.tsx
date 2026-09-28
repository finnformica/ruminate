// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { emptyBlock, indentBlock, insertAfter, removeBlock } from "../blocks/ops"
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
 * **A narrowed view edits as the note does, and never touches what it
 * hid.** Its doc holds only the rows that survived the filter, in the
 * order the sort put them, and an edit to it is read as exactly that
 * (`docToOps`, `shown`): a row added lands beside the rows it was put
 * between, in the note's own order; a row removed is unlinked; the rows the
 * filter hid, and the note's order under a sort, are never written. These
 * tests hold both halves of that line.
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

  it("speaks the whole query language, because the search engine answers it", async () => {
    const { wrapper, unsubscribe } = await signedOutStore(NOTE)
    const read = (filter: string) => {
      const { result } = renderNote(wrapper, filter)
      return rows(result.current.doc, result.current.context)
    }
    // `type:` on the block, an exclusion, a comma list, and free text — each
    // meaning here exactly what it means in the search box.
    expect(read("type:task")).toEqual(["~Shopping", "  milk", "  bread"])
    expect(read("type:task -type:done")).toEqual(["~Shopping", "  milk"])
    expect(read("type:todo,done")).toEqual(["~Shopping", "  milk", "  bread"])
    expect(read("book")).toEqual(["~Reading", "  a book"])
    // `in:` scopes to a subtree, as it does in a search.
    expect(read("type:task in:blk_shop000000")).toEqual(["~Shopping", "  milk", "  bread"])
    expect(read("type:task in:blk_read000000")).toEqual([])
    unsubscribe()
  })

  it("keeps a note-level qualifier honest: the whole note, or none of it", async () => {
    const { wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result: hit } = renderNote(wrapper, "type:todo title:Note")
    expect(rows(hit.current.doc, hit.current.context)).toEqual(["~Shopping", "  milk"])
    const { result: miss } = renderNote(wrapper, "type:todo title:Nothing")
    expect(rows(miss.current.doc, miss.current.context)).toEqual([])
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

  it("a row added beneath a match lands beside it in the note, ahead of the rows the filter hid", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result } = renderNote(wrapper, "type:todo")

    // Enter at the end of `milk`: a new to-do after it. The view shows
    // nothing after `milk`; the note has `bread` there.
    const fresh = emptyBlock("todo", "eggs")
    act(() => {
      result.current.setDoc(insertAfter(result.current.doc, "blk_shop000000/blk_milk000000", fresh))
    })

    const graph = store.get(graphSnapshotAtom)
    expect(childIdsOf(graph, "blk_shop000000")).toEqual([
      "blk_milk000000",
      fresh.id,
      "blk_bread00000",
    ])
    expect(graph.nodes.get(fresh.id)).toMatchObject({
      text: "eggs",
      type: "todo",
      notes_id: NOTE_ID,
    })
    // The rest of the note is exactly as it was.
    expect(childIdsOf(graph, NOTE_ID)).toEqual(["blk_shop000000", "blk_read000000"])
    expect(childIdsOf(graph, "blk_read000000")).toEqual(["blk_book000000"])
    // And the view shows the new row where it was made, still narrowed.
    expect(rows(result.current.doc, result.current.context)).toEqual([
      "~Shopping",
      "  milk",
      "  eggs",
    ])
    unsubscribe()
  })

  it("removing a shown row unlinks that row and nothing the filter hid", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result } = renderNote(wrapper, "type:todo")

    // The view's one root goes: `Shopping`, with `bread` hidden beneath it.
    act(() => {
      result.current.setDoc(removeBlock(result.current.doc, "blk_shop000000").doc)
    })

    const graph = store.get(graphSnapshotAtom)
    // `Shopping` left the note (an unlink — it is in the Unassigned basket,
    // still holding both its rows); `Reading`, which the filter hid, stands.
    expect(childIdsOf(graph, NOTE_ID)).toEqual(["blk_read000000"])
    expect(childIdsOf(graph, "blk_shop000000")).toEqual(["blk_milk000000", "blk_bread00000"])
    expect(graph.nodes.get("blk_shop000000")?.text).toBe("Shopping")
    expect(childIdsOf(graph, "blk_read000000")).toEqual(["blk_book000000"])
    unsubscribe()
  })

  it("indenting a shown row moves it in the note as it does in the note", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result } = renderNote(wrapper, "type:task")
    expect(rows(result.current.doc, result.current.context)).toEqual([
      "~Shopping",
      "  milk",
      "  bread",
    ])

    act(() => {
      result.current.setDoc(indentBlock(result.current.doc, "blk_shop000000/blk_bread00000").doc)
    })

    const graph = store.get(graphSnapshotAtom)
    expect(childIdsOf(graph, "blk_shop000000")).toEqual(["blk_milk000000"])
    expect(childIdsOf(graph, "blk_milk000000")).toEqual(["blk_bread00000"])
    expect(childIdsOf(graph, NOTE_ID)).toEqual(["blk_shop000000", "blk_read000000"])
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

  it("a row added under a sort lands after the row it was made beneath, in the note's order", async () => {
    const { store, wrapper, unsubscribe } = await signedOutStore(NOTE)
    const { result } = renderNote(wrapper, "", "text")

    // Sorted, `milk` is the last row under Shopping; in the note it is the
    // first. A row made beneath it follows it in the note — before `bread`
    // — and the sort then puts it where its text falls.
    const fresh = emptyBlock("ul", "cheese")
    act(() => {
      result.current.setDoc(insertAfter(result.current.doc, "blk_shop000000/blk_milk000000", fresh))
    })

    const graph = store.get(graphSnapshotAtom)
    expect(childIdsOf(graph, "blk_shop000000")).toEqual([
      "blk_milk000000",
      fresh.id,
      "blk_bread00000",
    ])
    expect(childIdsOf(graph, NOTE_ID)).toEqual(["blk_shop000000", "blk_read000000"])
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
