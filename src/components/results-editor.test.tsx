// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { buildGraphSnapshot, docToGraph } from "../data/graph"
import { githubUserAtom, isSignedOutAtom, sampleGraphAtom } from "../global-state"
import { resultsDoc, resultsToOps, type ResultRoot } from "../hooks/results-doc"
import { ResultsEditor } from "./results-editor"

// The editor's context menu (Base UI) measures with a ResizeObserver and
// scrolls the highlight into view; jsdom implements neither.
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup)

/**
 * The results view over the signed-out sample graph: two notes, one with a
 * nested outline. Ids are pinned so the roots can be named.
 */
const RESEARCH = [
  "# Semiconductors",
  "  id:: blk_semis",
  "  - GPUs",
  "    id:: blk_gpus",
  "    - nvidia",
  "      id:: blk_nvidia",
  "- [ ] buy milk",
  "  id:: blk_milk",
  "",
].join("\n")
const JOURNAL = ["- in another note", "  id:: blk_elsewhere", ""].join("\n")

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
  return { store, unsubscribe }
}

const NOTE_ROOTS: ResultRoot[] = [
  { id: "research", noteId: "research" },
  { id: "journal", noteId: "journal" },
]

const onOpen = vi.fn()

async function renderResults(roots: ResultRoot[], { readOnly = true } = {}) {
  onOpen.mockClear()
  const { store, unsubscribe } = await signedOutStore({ research: RESEARCH, journal: JOURNAL })
  const rendered = render(
    <Provider store={store}>
      <ResultsEditor roots={roots} resetKey="q" readOnly={readOnly} onOpen={onOpen} />
    </Provider>,
  )
  return { store, unsubscribe, ...rendered }
}

const editor = () => document.querySelector("[data-block-editor]") as HTMLElement
const rowIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-block-row]")).map(
    (row) => row.dataset.blockRow,
  )
const press = (key: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(editor(), { key, ...init })
const textOf = (id: string) => (store: ReturnType<typeof createStore>) =>
  store.get(sampleGraphAtom).nodes.get(id)?.text

describe("resultsDoc", () => {
  it("walks only the roots until one is opened, and then only that level", async () => {
    const { store } = await signedOutStore({ research: RESEARCH, journal: JOURNAL })
    const graph = store.get(sampleGraphAtom)

    const closed = resultsDoc(NOTE_ROOTS, graph, new Set())
    expect(closed.rootBlockIds).toEqual(["research", "journal"])
    expect(Object.keys(closed.blocks).sort()).toEqual(["journal", "research"])
    // A root knows its children's IDS (the chevron is drawn from them)…
    expect(closed.blocks.research.children).toEqual(["blk_semis", "blk_milk"])

    // …and opening it brings in exactly those blocks, not their subtrees.
    const opened = resultsDoc(NOTE_ROOTS, graph, new Set(["research"]))
    expect(Object.keys(opened.blocks).sort()).toEqual([
      "blk_milk",
      "blk_semis",
      "journal",
      "research",
    ])
    expect(opened.blocks.blk_semis.children).toEqual(["blk_gpus"])
    expect(opened.blocks.blk_gpus).toBeUndefined()
  })

  it("lists a block matched in two notes once", async () => {
    const { store } = await signedOutStore({ research: RESEARCH })
    const doc = resultsDoc(
      [
        { id: "blk_milk", noteId: "research" },
        { id: "blk_milk", noteId: "other" },
      ],
      store.get(sampleGraphAtom),
      new Set(),
    )
    expect(doc.rootBlockIds).toEqual(["blk_milk"])
  })
})

describe("resultsToOps", () => {
  it("is nothing for an unchanged view, and a setText for a retyped block", async () => {
    const { store } = await signedOutStore({ research: RESEARCH })
    const graph = store.get(sampleGraphAtom)
    const roots: ResultRoot[] = [{ id: "blk_milk", noteId: "research" }]
    const doc = resultsDoc(roots, graph, new Set())
    expect(resultsToOps(doc, roots, graph)).toEqual([])

    const edited = {
      ...doc,
      blocks: { ...doc.blocks, blk_milk: { ...doc.blocks.blk_milk, text: "buy oat milk" } },
    }
    expect(resultsToOps(edited, roots, graph)).toEqual([
      { op: "setText", id: "blk_milk", text: "buy oat milk" },
    ])
  })

  it("creates a new child in the root's note, linked under its parent", async () => {
    const { store } = await signedOutStore({ research: RESEARCH })
    const graph = store.get(sampleGraphAtom)
    const roots: ResultRoot[] = [{ id: "blk_milk", noteId: "research" }]
    const doc = resultsDoc(roots, graph, new Set())
    const withChild = {
      ...doc,
      blocks: {
        ...doc.blocks,
        blk_milk: { ...doc.blocks.blk_milk, children: ["blk_new"] },
        blk_new: { id: "blk_new", type: "text" as const, text: "oat", children: [] },
      },
    }
    const ops = resultsToOps(withChild, roots, graph)
    expect(ops).toContainEqual({
      op: "create",
      id: "blk_new",
      type: "text",
      text: "oat",
      props: null,
      notesId: "research",
    })
    expect(
      ops.some(
        (op) => op.op === "link" && op.source === "blk_milk" && op.destination === "blk_new",
      ),
    ).toBe(true)
  })
})

describe("ResultsEditor (browsing the notes list)", () => {
  it("lists every note as a closed root with the editor's chevron, and opens one to its blocks", async () => {
    const { store } = await renderResults(NOTE_ROOTS)
    expect(rowIds()).toEqual(["research", "journal"])
    expect(screen.getAllByLabelText("Expand")).toHaveLength(2)
    // The note's favicon is its key, and its title its text.
    expect(document.querySelector('[data-testid="note-favicon-slot"]')).not.toBeNull()

    fireEvent.click(screen.getAllByLabelText("Expand")[0])
    // One level: the note's top-level blocks, themselves closed.
    expect(rowIds()).toEqual(["research", "blk_semis", "blk_milk", "journal"])
    expect(document.querySelector('[data-testid="heading-hash"]')).not.toBeNull()
    expect(document.querySelector('input[type="checkbox"]')).not.toBeNull()
    // Nothing was written.
    expect(textOf("research")(store)).toBe("research")
  })

  it("browses with the editor's own keys: space folds, → opens a level, Enter opens", async () => {
    await renderResults(NOTE_ROOTS)
    // As in a note, the first row starts highlighted (quietly, until the
    // keyboard is in the editor).
    expect(
      document
        .querySelector(".block-highlight")
        ?.closest("[data-block-row]")
        ?.getAttribute("data-block-row"),
    ).toBe("research")
    press(" ")
    expect(rowIds()).toEqual(["research", "blk_semis", "blk_milk", "journal"])
    // Down into a child, and open that one with →.
    press("ArrowDown")
    press("ArrowRight")
    expect(rowIds()).toEqual(["research", "blk_semis", "blk_gpus", "blk_milk", "journal"])
    // Enter opens the note zoomed to the highlighted block…
    press("Enter")
    expect(onOpen).toHaveBeenLastCalledWith("research", "blk_semis")
    // …and on the note row, the note whole.
    press("ArrowUp")
    press("Enter")
    expect(onOpen).toHaveBeenLastCalledWith("research", undefined)
  })

  it("a click opens the row; nothing edits", async () => {
    const { store } = await renderResults(NOTE_ROOTS)
    fireEvent.click(screen.getByText("journal"))
    expect(onOpen).toHaveBeenLastCalledWith("journal", undefined)
    press("ArrowDown")
    press("Backspace")
    expect(rowIds()).toEqual(["research", "journal"])
    expect(store.get(sampleGraphAtom).nodes.has("research")).toBe(true)
  })
})

describe("ResultsEditor (editing a filtered view)", () => {
  const HITS: ResultRoot[] = [
    { id: "blk_nvidia", noteId: "research" },
    { id: "blk_milk", noteId: "research" },
  ]

  it("Enter edits the row, and the change lands in the note", async () => {
    const { store } = await renderResults(HITS, { readOnly: false })
    press("Enter")
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement
    expect(textarea.value).toBe("nvidia")
    fireEvent.change(textarea, { target: { value: "nvidia (NVDA)" } })
    expect(textOf("blk_nvidia")(store)).toBe("nvidia (NVDA)")
    // The row is still a result: the view's roots never move.
    expect(rowIds()).toEqual(["blk_nvidia", "blk_milk"])
  })

  it("ticks a to-do found by search", async () => {
    const { store } = await renderResults(HITS, { readOnly: false })
    const box = document.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.disabled).toBe(false)
    fireEvent.click(box)
    expect(store.get(sampleGraphAtom).nodes.get("blk_milk")?.type).toBe("done")
  })

  it("retitles a note from its row, and never changes its type", async () => {
    const { store } = await renderResults(NOTE_ROOTS, { readOnly: false })
    press("-") // turnIntoBullet — refused for a note
    expect(store.get(sampleGraphAtom).nodes.get("research")?.type).toBe("note")
    press("Enter")
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "Research notes" } })
    expect(textOf("research")(store)).toBe("Research notes")
  })

  it("refuses an edit that would add to or remove from the root list", async () => {
    const { store } = await renderResults(HITS, { readOnly: false })
    press("Backspace") // deleteBlock on a root
    expect(rowIds()).toEqual(["blk_nvidia", "blk_milk"])
    expect(store.get(sampleGraphAtom).nodes.has("blk_nvidia")).toBe(true)
    press("Enter", { shiftKey: true }) // insertSiblingBelow on a root
    expect(rowIds()).toEqual(["blk_nvidia", "blk_milk"])
    press("ArrowDown")
    press("Tab") // indent milk under nvidia: a root leaving the root list
    expect(rowIds()).toEqual(["blk_nvidia", "blk_milk"])
    expect(store.get(sampleGraphAtom).childLinks.get("blk_nvidia")).toBeUndefined()
  })

  it("adds a block beneath a matched one, in its note, and keeps it in view", async () => {
    const { store } = await renderResults([{ id: "blk_semis", noteId: "research" }], {
      readOnly: false,
    })
    fireEvent.click(screen.getByLabelText("Expand"))
    expect(rowIds()).toEqual(["blk_semis", "blk_gpus"])
    // Down onto the child and split it at its end: a new sibling of the
    // child is a new block under the heading — allowed, and shown.
    press("ArrowDown")
    press("Enter")
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement
    expect(textarea.value).toBe("GPUs")
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    fireEvent.keyDown(textarea, { key: "Enter" })
    const children = store.get(sampleGraphAtom).childLinks.get("blk_semis") ?? []
    expect(children).toHaveLength(2)
    const created = children[1].destination_id
    expect(store.get(sampleGraphAtom).nodes.get(created)?.notes_id).toBe("research")
    expect(rowIds()).toEqual(["blk_semis", "blk_gpus", created])
  })
})
