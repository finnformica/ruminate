// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { NodeRow } from "../../worker/handlers/replica-payload"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import type { BlockDoc } from "../blocks/types"
import { BlockNoteEditor } from "../components/block-editor/block-note-editor"
import { CORPUS_ROOT_ID, buildGraphSnapshot, childIdsOf, docToGraph } from "../data/graph"
import { ROOT_DEPTH } from "../data/root-frame"
import { useFoldRule } from "../data/view-state"
import { githubUserAtom, isSignedOutAtom, sampleGraphAtom } from "../global-state"
import { useNoteDoc } from "./note-doc"

/**
 * **Root is the note page's own editor** (docs/graph-walk.md, decision 5):
 * the walk of the corpus root through `useNoteDoc`, drawn by
 * `BlockNoteEditor` as the note page draws it. A note row and a board row
 * are block rows with their type's icon in the key slot; they open and
 * close as any row, and a move of one writes the root's link.
 */

// The editor's context menu (Base UI) measures with a ResizeObserver and
// scrolls the highlight into view; jsdom implements neither.
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup)

const RESEARCH = ["- GPUs", "  id:: blk_gpus", "- [ ] buy milk", "  id:: blk_milk", ""].join("\n")
const JOURNAL = ["- in another note", "  id:: blk_elsewhere", ""].join("\n")
const KITCHEN: NodeRow = {
  id: "kitchen",
  type: "board",
  text: "Kitchen",
  props: null,
  updated_at: 1,
}
const EMPTY: BlockDoc = { props: null, rootBlockIds: [], blocks: {} }

/** The page's Root, as `NotePage` puts it together. */
function RootPage() {
  const { expanded, setFold } = useFoldRule({ depth: ROOT_DEPTH })
  const { doc, collapsed, setDoc } = useNoteDoc({
    noteId: CORPUS_ROOT_ID,
    defaultDoc: EMPTY,
    expanded,
  })
  return (
    <BlockNoteEditor
      noteId={CORPUS_ROOT_ID}
      doc={doc}
      onChange={setDoc}
      folds={{
        collapsed,
        toggle: (key) => setFold(key, collapsed.has(key)),
        setOpen: (key) => setFold(key, true),
      }}
      starter={false}
      fixedRoots
      movableRoots
    />
  )
}

async function renderRoot() {
  const store = createStore()
  store.sub(githubUserAtom, () => {})
  await vi.waitFor(() => {
    expect(store.get(isSignedOutAtom)).toBe(true)
  })
  const nodes: NodeRow[] = [KITCHEN]
  const links = []
  for (const [id, markdown] of Object.entries({ research: RESEARCH, journal: JOURNAL })) {
    const g = docToGraph(id, serialize(parse(markdown)), 1)
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, links))
  render(
    <Provider store={store}>
      <RootPage />
    </Provider>,
  )
  return store
}

const editor = () => document.querySelector("[data-block-editor]") as HTMLElement
const rowIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-block-row]")).map(
    (row) => row.dataset.blockRow,
  )
const press = (key: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(editor(), { key, ...init })
const iconIn = (id: string, testId: string) =>
  document.querySelector(`[data-block-row="${id}"] [data-testid="${testId}"]`)
const chevron = (id: string, label: string) =>
  document.querySelector(`[data-block-row="${id}"] button[aria-label="${label}"]`)!

describe("the Root frame, drawn by the note page's editor", () => {
  it("lists every note, closed, each row with its type's icon", async () => {
    await renderRoot()
    expect(rowIds()).toEqual(["journal", "kitchen", "research"])
    expect(iconIn("research", "favicon-default")).not.toBeNull()
    expect(iconIn("kitchen", "favicon-board")).not.toBeNull()
    expect(document.querySelector('[data-testid="board-figure"]')).toBeNull()
  })

  it("opens and closes a note row as any row", async () => {
    await renderRoot()
    fireEvent.click(chevron("research", "Expand"))
    expect(rowIds()).toEqual(["journal", "kitchen", "research", "blk_gpus", "blk_milk"])
    fireEvent.click(chevron("research", "Collapse"))
    expect(rowIds()).toEqual(["journal", "kitchen", "research"])
  })

  it("moves a note row with the keys, and writes the root's links", async () => {
    const store = await renderRoot()
    // The first row is selected on mount; two rows down is Research.
    press("ArrowDown")
    press("ArrowDown")
    press("ArrowUp", { altKey: true })
    await vi.waitFor(() => {
      expect(childIdsOf(store.get(sampleGraphAtom), CORPUS_ROOT_ID)).toEqual([
        "journal",
        "research",
        "kitchen",
      ])
    })
    expect(rowIds()).toEqual(["journal", "research", "kitchen"])
  })

  it("filters over every note: a match keeps its note row as its path", async () => {
    const store = await renderRoot()
    const { result } = renderHook(
      () => useNoteDoc({ noteId: CORPUS_ROOT_ID, defaultDoc: EMPTY, filter: "milk" }),
      { wrapper: ({ children }) => <Provider store={store}>{children}</Provider> },
    )
    expect(result.current.doc.rootBlockIds).toEqual(["research"])
    expect(result.current.doc.blocks.research.children).toEqual(["blk_milk"])
    expect(result.current.context).toEqual(new Set(["research"]))
  })
})
