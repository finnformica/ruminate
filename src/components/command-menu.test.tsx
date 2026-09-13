// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The palette lives inside the app's router and global state machine — both
// far too heavy for jsdom. Navigation, note hooks, and the global-state atoms
// are mocked (the atoms as plain Jotai atoms, which is all the palette needs);
// the pure pieces (outline builder, filter/rank) are tested exhaustively in
// note-outline.test.ts, so these tests focus on the palette's mode/reveal
// behavior.
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  match: { params: { _splat: "note-1" } } as
    { params: { _splat: string }; search?: { block?: string } } | undefined,
  // What the query resolves to, injected at `useSearchResults`; the rows
  // themselves are walked out of the mocked graph (see the global-state mock).
  results: { mode: "notes", hits: [], notes: [], titleMatches: [], rows: [] } as {
    mode: "blocks" | "notes"
    hits: unknown[]
    notes: unknown[]
    titleMatches: unknown[]
    rows: { id: string; noteId: string; kind: "note" | "block"; score?: number }[]
  },
}))

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useMatch: () => mocks.match,
}))

vi.mock("../hooks/note", () => ({
  useNoteById: () => undefined,
  useCreateNote: () => vi.fn(),
}))

vi.mock("../hooks/search-results", () => ({
  useSearchResults: () => mocks.results,
}))
vi.mock("../data/store", () => ({ useApplyOps: () => () => {} }))
// The real module underneath (the block editor behind the rows reads several
// of its atoms), with the palette's own inputs pinned.
vi.mock("../global-state", async (importOriginal) => {
  const original = await importOriginal<typeof import("../global-state")>()
  const { atom } = await import("jotai")
  const { parse } = await import("../blocks/parse")
  const { serialize } = await import("../blocks/serialize")
  const { buildGraphSnapshot, docToGraph } = await import("../data/graph")
  // The corpus the result rows are walked out of (the palette's results are
  // the block editor over the graph — see ResultsEditor). Ids are pinned so
  // the hits below can name them.
  const CORPUS: Record<string, string> = {
    research: [
      "# Semiconductors",
      "  id:: blk_semis",
      "  - GPUs",
      "    id:: blk_gpus",
      "    - nvidia",
      "      id:: blk_nvidia",
      "      - H100 supply",
      "        id:: blk_h100",
      "      - datacenter revenue",
      "        id:: blk_rev",
      "- [ ] buy milk",
      "  id:: blk_milk",
      "",
    ].join("\n"),
    journal: ["- [ ] ship it", "  id:: blk_ship", "- in another note", "  id:: blk_else", ""].join(
      "\n",
    ),
  }
  const nodes = []
  const links = []
  for (const [id, markdown] of Object.entries(CORPUS)) {
    const g = docToGraph(id, serialize(parse(markdown)), 1)
    nodes.push(...g.nodes)
    links.push(...g.links)
  }
  const graph = buildGraphSnapshot(nodes, links)
  return {
    ...original,
    graphSnapshotAtom: atom(graph),
    sampleGraphAtom: atom(graph),
    isDatabaseModeAtom: atom(false),
    notesAtom: atom(new Map()),
    sortedNotesAtom: atom([]),
    recentTouchesAtom: atom([]),
    noteOutlineAtom: atom(null),
    blockRevealAtom: atom(null),
    // The block index only serves the scope pill's label here.
    blockIndexAtom: atom({ hits: [], getBlock: () => undefined }),
  }
})

import {
  blockRevealAtom,
  noteOutlineAtom,
  recentTouchesAtom,
  sortedNotesAtom,
} from "../global-state"
import type { BlockRevealRequest } from "../utils/note-outline"
import { CommandMenu, isCommandMenuOpenAtom } from "./command-menu"

// cmdk scrolls the selected item into view and measures its list with a
// ResizeObserver; jsdom implements neither.
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup)
beforeEach(() => {
  mocks.match = { params: { _splat: "note-1" } }
  mocks.navigate.mockClear()
  mocks.results = { mode: "notes", hits: [], notes: [], titleMatches: [], rows: [] }
})

const OUTLINE = {
  noteId: "note-1",
  items: [
    { id: "blk_alpha", text: "Alpha", depth: 0 },
    { id: "blk_beta", text: "Beta", depth: 1 },
    { id: "blk_gamma", text: "Gamma", depth: 0 },
  ],
}

function renderMenu({
  outline = OUTLINE,
  open = false,
  notes = [],
  touches = [],
}: {
  outline?: typeof OUTLINE | null
  open?: boolean
  notes?: unknown[]
  touches?: { id: string; at: number }[]
} = {}) {
  const store = createStore()
  store.set(noteOutlineAtom, outline)
  // The corpus's notes, and the touches this device remembers: what the
  // palette's Recent list is merged from. The atoms are the mock's plain,
  // writable ones.
  store.set(sortedNotesAtom as never, notes as never)
  store.set(recentTouchesAtom as never, touches as never)
  if (open) store.set(isCommandMenuOpenAtom, true)
  render(
    <Provider store={store}>
      <CommandMenu />
    </Provider>,
  )
  return { store }
}

const pressCmdP = () => fireEvent.keyDown(document.body, { key: "p", code: "KeyP", metaKey: true })
const outlineInput = () => screen.getByPlaceholderText("Jump to a heading…") as HTMLInputElement
const commandsInput = () => screen.getByPlaceholderText("Search or jump to…") as HTMLInputElement

describe("outline palette (⌘P)", () => {
  it("⌘P opens the palette in outline mode listing the note's headings", () => {
    renderMenu()
    pressCmdP()
    expect(outlineInput()).toBeTruthy()
    expect(screen.getByText("Alpha")).toBeTruthy()
    expect(screen.getByText("Beta")).toBeTruthy()
    expect(screen.getByText("Gamma")).toBeTruthy()
    // Unfiltered items are indented by heading depth.
    const beta = screen.getByText("Beta").closest("[cmdk-item]") as HTMLElement
    expect(beta.style.paddingLeft).toBe("30px")
    const alpha = screen.getByText("Alpha").closest("[cmdk-item]") as HTMLElement
    expect(alpha.style.paddingLeft).toBe("6px")
  })

  it("shows an empty state when no note is open", () => {
    mocks.match = undefined
    renderMenu()
    pressCmdP()
    expect(screen.getByText("No note open")).toBeTruthy()
  })

  it("shows an empty state when the note has no headings", () => {
    renderMenu({ outline: { noteId: "note-1", items: [] } })
    pressCmdP()
    expect(screen.getByText("No headings in this note")).toBeTruthy()
  })

  it("ignores an outline published for a different note", () => {
    renderMenu({ outline: { ...OUTLINE, noteId: "other-note" } })
    pressCmdP()
    expect(screen.getByText("No headings in this note")).toBeTruthy()
  })

  it("typing @ first in the ⌘K palette switches to outline mode (and strips the @)", () => {
    renderMenu({ open: true })
    const input = commandsInput()
    fireEvent.change(input, { target: { value: "@" } })
    expect(outlineInput().value).toBe("")
    expect(screen.getByText("Alpha")).toBeTruthy()
  })

  it("Backspace on an empty query returns to the commands palette after @", () => {
    renderMenu({ open: true })
    fireEvent.change(commandsInput(), { target: { value: "@" } })
    fireEvent.keyDown(outlineInput(), { key: "Backspace" })
    expect(commandsInput()).toBeTruthy()
  })

  it("Backspace on an empty query stays in outline mode when opened via ⌘P", () => {
    renderMenu()
    pressCmdP()
    fireEvent.keyDown(outlineInput(), { key: "Backspace" })
    expect(outlineInput()).toBeTruthy()
  })

  it("filtering flattens the list and shows the ancestor path", async () => {
    renderMenu()
    pressCmdP()
    fireEvent.change(outlineInput(), { target: { value: "beta" } })
    // The query is debounced (150ms) before it filters.
    await waitFor(() => {
      expect(screen.queryByText("Gamma")).toBeNull()
    })
    const beta = screen.getByText("Beta").closest("[cmdk-item]") as HTMLElement
    expect(beta.textContent).toContain("Alpha") // the dimmed "Alpha" path
    expect(beta.style.paddingLeft).toBe("") // flat while filtering
  })

  it("Enter commits a reveal for the highlighted heading and closes", () => {
    const { store } = renderMenu()
    pressCmdP()
    // cmdk auto-highlights the first item (Alpha); Enter commits it.
    fireEvent.keyDown(outlineInput(), { key: "Enter" })
    const reveal = store.get(blockRevealAtom) as BlockRevealRequest
    expect(reveal).toMatchObject({ type: "commit", id: "blk_alpha" })
    expect(screen.queryByPlaceholderText("Jump to a heading…")).toBeNull()
  })

  it("arrowing previews the highlighted heading (initial auto-select doesn't)", () => {
    const { store } = renderMenu()
    pressCmdP()
    // Opening the palette must not scroll the note: the auto-select of the
    // first item is not a preview.
    expect(store.get(blockRevealAtom)).toBeNull()
    fireEvent.keyDown(outlineInput(), { key: "ArrowDown" })
    expect(store.get(blockRevealAtom)).toMatchObject({ type: "preview", id: "blk_beta" })
  })

  it("Escape after a preview closes and cancels (restoring the editor)", () => {
    const { store } = renderMenu()
    pressCmdP()
    fireEvent.keyDown(outlineInput(), { key: "ArrowDown" })
    expect(store.get(blockRevealAtom)).toMatchObject({ type: "preview" })
    fireEvent.keyDown(outlineInput(), { key: "Escape" })
    expect(screen.queryByPlaceholderText("Jump to a heading…")).toBeNull()
    expect(store.get(blockRevealAtom)).toMatchObject({ type: "cancel" })
  })

  it("leaving outline mode via Backspace cancels an active preview", () => {
    const { store } = renderMenu({ open: true })
    fireEvent.change(commandsInput(), { target: { value: "@" } })
    fireEvent.keyDown(outlineInput(), { key: "ArrowDown" })
    expect(store.get(blockRevealAtom)).toMatchObject({ type: "preview" })
    fireEvent.keyDown(outlineInput(), { key: "Backspace" })
    expect(store.get(blockRevealAtom)).toMatchObject({ type: "cancel" })
  })

  it("closing without any preview sends no cancel", () => {
    const { store } = renderMenu()
    pressCmdP()
    fireEvent.keyDown(outlineInput(), { key: "Escape" })
    expect(store.get(blockRevealAtom)).toBeNull()
  })
})

// ── Block results ───────────────────────────────────────────────────────────
// The palette's primary results are the matching BLOCKS, at any depth — the
// two cases the owner reported (a `type:todo` filter, and a nested heading)
// are the literal fixtures below.

function makeNote(id: string) {
  return {
    id,
    type: "note",
    displayName: id,
    props: {},
    title: id,
    pinned: false,
    updatedAt: null,
    dates: [],
    tasks: [],
    headings: [],
    text: "",
  }
}

const RESEARCH = makeNote("research")
const JOURNAL = makeNote("journal")

function hit(blockId: string, text: string, type: string, note = RESEARCH) {
  return { blockId, noteId: note.id, text, type, ancestors: [], note }
}

/** A heading nested under two other blocks — invisible to the old note-only
 * results, a first-class row now. */
const NVIDIA = hit("blk_nvidia", "nvidia", "ul")
const TODO_MILK = hit("blk_milk", "buy milk", "todo")
const TODO_SHIP = hit("blk_ship", "ship it", "todo", JOURNAL)
const ELSEWHERE = hit("blk_else", "in another note", "text", JOURNAL)

/** The rows `useSearchResults` would rank: the hits, in the order given. */
const rowsOf = (hits: ReturnType<typeof hit>[]) =>
  hits.map((h) => ({ id: h.blockId, noteId: h.noteId, kind: "block" as const }))

async function openWithBlocks(hits: ReturnType<typeof hit>[], notes: unknown[] = [RESEARCH]) {
  mocks.results = { mode: "blocks", hits, notes, titleMatches: [], rows: rowsOf(hits) }
  const rendered = renderMenu({ open: true })
  const input = commandsInput()
  fireEvent.change(input, { target: { value: "nvidia" } })
  // Typing leaves the caret at the end of the query — which is where the
  // arrows hand over to the results tree (jsdom won't place it for us).
  input.setSelectionRange(input.value.length, input.value.length)
  // The query is debounced (150ms) before the palette re-derives its groups.
  await waitFor(() => {
    expect(screen.queryByText("Settings")).toBeNull()
  })
  return rendered
}

/** A result row: the editor's own, by block id. */
const rowOf = (id: string) =>
  document.querySelector(`[data-block-row="${id}"]`) as HTMLElement | null
const rowIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-block-row]")).map(
    (row) => row.dataset.blockRow,
  )
const editor = () => document.querySelector("[data-block-editor]") as HTMLElement

/** ↓ in the query walks cmdk's items; past the last it hands the keyboard to
 * the rows. A search query matches no item, so the first press crosses over. */
function handOffToRows() {
  const input = commandsInput()
  for (let i = 0; i < 3 && document.activeElement !== editor(); i += 1) {
    fireEvent.keyDown(input, { key: "ArrowDown" })
  }
  expect(document.activeElement).toBe(editor())
}

describe("block results", () => {
  it("lists a nested heading as its own row — the editor's, with no breadcrumb", async () => {
    await openWithBlocks([NVIDIA, ELSEWHERE], [RESEARCH, JOURNAL])
    expect(rowIds()).toEqual(["blk_nvidia", "blk_else"])
    expect(rowOf("blk_nvidia")?.querySelector('[data-testid="block-body"]')?.textContent).toBe(
      "nvidia",
    )
    expect(rowOf("blk_nvidia")?.textContent).not.toContain("Semiconductors")
  })

  it("lists matching todo blocks as rows (the type:todo case)", async () => {
    await openWithBlocks([TODO_MILK, TODO_SHIP])
    expect(rowIds()).toEqual(["blk_milk", "blk_ship"])
    expect(rowOf("blk_milk")?.querySelector('input[type="checkbox"]')).not.toBeNull()
  })

  it("shows the count of matched blocks, and the notes they live in — the page's line", async () => {
    await openWithBlocks([NVIDIA, TODO_MILK, TODO_SHIP])
    expect(screen.getByTestId("result-count").textContent).toBe("3 matching blocks in 1 note")
    // No "See all" item: ↵ on the query is what opens the results view.
    expect(document.querySelector("[cmdk-item]")).toBeNull()
  })

  it("says so plainly when nothing matches", async () => {
    await openWithBlocks([], [])
    expect(screen.getByText("No matching blocks")).toBeTruthy()
  })

  it("typing never hands the keyboard to the rows", async () => {
    mocks.results = {
      mode: "blocks",
      hits: [NVIDIA, TODO_MILK],
      notes: [RESEARCH],
      titleMatches: [],
      rows: rowsOf([NVIDIA, TODO_MILK]),
    }
    renderMenu({ open: true })
    const input = commandsInput()
    input.focus()
    // Each letter is a new query, and new rows beneath — which must not
    // take the focus from the box mid-word.
    for (const value of ["nv", "nvi", "nvid"]) {
      fireEvent.change(input, { target: { value } })
      await waitFor(() => {
        expect(screen.queryByText("Settings")).toBeNull()
      })
      expect(rowIds()).toEqual(["blk_nvidia", "blk_milk"])
      expect(document.activeElement).toBe(input)
    }
  })

  it("Enter straight after typing opens the full results view at ?query=", async () => {
    // Outside a note there is nothing to scope to.
    mocks.match = undefined
    await openWithBlocks([NVIDIA])
    // Nothing arrowed: no item is highlighted, so ↵ is the query's.
    expect(document.querySelector('[cmdk-item][aria-selected="true"]')).toBeNull()
    fireEvent.keyDown(commandsInput(), { key: "Enter" })
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", search: { query: "nvidia" } })
  })

  it("Enter on a highlighted item picks the item, not the results view", async () => {
    mocks.match = undefined
    renderMenu({ open: true })
    const input = commandsInput()
    fireEvent.change(input, { target: { value: "sett" } })
    // The debounce has filtered the items down to the one match.
    await waitFor(() => {
      expect(screen.queryByText("Notes")).toBeNull()
    })
    expect(screen.getByText("Settings")).toBeTruthy()
    // ↓ puts cmdk's highlight on the first item.
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent).toContain(
      "Settings",
    )
    fireEvent.keyDown(input, { key: "Enter" })
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings" })
    expect(mocks.navigate).not.toHaveBeenCalledWith(expect.objectContaining({ to: "/" }))
  })

  it("inside a note, scopes the search to it — an `in:` the results view inherits", async () => {
    await openWithBlocks([NVIDIA])
    // Said plainly under the query, as a pill naming the note.
    expect(screen.getByTestId("query-scopes").textContent).toContain("note-1")
    fireEvent.keyDown(commandsInput(), { key: "Enter" })
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { query: "in:note-1 nvidia" },
    })
  })

  it("the scope comes off with its pill", async () => {
    await openWithBlocks([NVIDIA])
    fireEvent.click(screen.getByTestId("query-scopes").querySelector("button")!)
    expect(screen.queryByTestId("query-scopes")).toBeNull()
    fireEvent.keyDown(commandsInput(), { key: "Enter" })
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", search: { query: "nvidia" } })
  })

  it("a typed in: replaces the automatic scope rather than stacking on it", async () => {
    await openWithBlocks([NVIDIA])
    const input = commandsInput()
    fireEvent.change(input, { target: { value: "in:other nvidia" } })
    await waitFor(() => {
      expect(screen.getByTestId("query-scopes").textContent).not.toContain("note-1")
    })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { query: "in:other nvidia" },
    })
  })

  it("zoomed into a block, the scope is that block", async () => {
    mocks.match = { params: { _splat: "note-1" }, search: { block: "blk_zoom" } }
    await openWithBlocks([NVIDIA])
    expect(screen.getByTestId("query-scopes").textContent).toContain("blk_zoom")
    fireEvent.keyDown(commandsInput(), { key: "Enter" })
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/",
      search: { query: "in:blk_zoom nvidia" },
    })
  })

  it("↓ past the items hands the keyboard to the rows; Enter opens the note zoomed to the block", async () => {
    await openWithBlocks([NVIDIA])
    handOffToRows()
    // The first row is the highlight, as in a note.
    expect(rowOf("blk_nvidia")?.querySelector(".block-highlight")).not.toBeNull()
    fireEvent.keyDown(editor(), { key: "Enter" })
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/notes/$",
      params: { _splat: "research" },
      search: { query: undefined, block: "blk_nvidia" },
    })
  })

  it("→ and space open a hit in place, one level at a time; ← closes it", async () => {
    await openWithBlocks([NVIDIA])
    handOffToRows()
    expect(rowIds()).toEqual(["blk_nvidia"])

    fireEvent.keyDown(editor(), { key: "ArrowRight" })
    expect(rowIds()).toEqual(["blk_nvidia", "blk_h100", "blk_rev"])

    fireEvent.keyDown(editor(), { key: "ArrowLeft" })
    expect(rowIds()).toEqual(["blk_nvidia"])

    fireEvent.keyDown(editor(), { key: " " })
    expect(rowIds()).toEqual(["blk_nvidia", "blk_h100", "blk_rev"])
  })

  it("↑ from the first row, or Escape, returns to the query", async () => {
    await openWithBlocks([NVIDIA])
    handOffToRows()
    fireEvent.keyDown(editor(), { key: "ArrowUp" })
    expect(document.activeElement).toBe(commandsInput())

    handOffToRows()
    fireEvent.keyDown(editor(), { key: "Escape" })
    expect(document.activeElement).toBe(commandsInput())
    // The palette is still open, the query still there.
    expect(commandsInput().value).toBe("nvidia")
  })

  it("creates a note from the query — the footer, or ⌘↵ from anywhere", async () => {
    await openWithBlocks([NVIDIA])
    expect(screen.getByTestId("palette-create").textContent).toContain('Create new note "nvidia"')
    fireEvent.keyDown(commandsInput(), { key: "Enter", metaKey: true })
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/notes/$", search: { query: undefined } }),
    )
  })

  it("the create footer is there with nothing typed, and makes an untitled note", () => {
    renderMenu({ open: true })
    const footer = screen.getByTestId("palette-create")
    expect(footer.textContent).toContain("Create new note")
    expect(footer.textContent).not.toContain('"')
    fireEvent.click(footer)
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/notes/$", search: { query: undefined } }),
    )
  })

  it("clicking the chevron expands and collapses the same way", async () => {
    await openWithBlocks([NVIDIA])
    fireEvent.click(screen.getByLabelText("Expand"))
    expect(rowOf("blk_h100")).not.toBeNull()
    // The click expanded rather than opening the result.
    expect(mocks.navigate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText("Collapse"))
    expect(rowOf("blk_h100")).toBeNull()
  })

  it("a leaf hit draws no expand affordance", async () => {
    await openWithBlocks([TODO_MILK])
    // Like a leaf in the editor: its marker slot holds only its key.
    expect(screen.queryByLabelText("Expand")).toBeNull()
  })
})

// ── Note results ────────────────────────────────────────────────────────────
// A note is a node whose children are its blocks, so a note result (its
// title matched) is a root row of the same editor as a block result — in the
// same list, ranked by score among the blocks — and opens exactly as one.

describe("note results", () => {
  /** Open with the ranked rows `useSearchResults` would hand over: notes
   * and hits in the order given. */
  async function openWithRows(rows: (ReturnType<typeof makeNote> | ReturnType<typeof hit>)[]) {
    const hits = rows.filter((row): row is ReturnType<typeof hit> => "blockId" in row)
    const titleMatches = rows.filter((row) => !("blockId" in row))
    mocks.results = {
      mode: "blocks",
      hits,
      notes: [RESEARCH],
      titleMatches,
      rows: rows.map((row) =>
        "blockId" in row
          ? { id: row.blockId, noteId: row.noteId, kind: "block" as const }
          : { id: row.id, noteId: row.id, kind: "note" as const },
      ),
    }
    const rendered = renderMenu({ open: true })
    const input = commandsInput()
    fireEvent.change(input, { target: { value: "research" } })
    input.setSelectionRange(input.value.length, input.value.length)
    await waitFor(() => {
      expect(screen.queryByText("Settings")).toBeNull()
    })
    return rendered
  }
  const openWithNotes = (notes: ReturnType<typeof makeNote>[]) => openWithRows(notes)

  it("draws a note as an editor row, keyed by its favicon", async () => {
    await openWithNotes([RESEARCH])
    const row = rowOf("research")
    expect(row?.querySelector('[data-testid="block-body"]')?.textContent).toBe("research")
    expect(row?.querySelector('[data-testid="note-favicon-slot"]')).not.toBeNull()
  })

  it("lists notes and blocks as one list, in the ranked order — a block above a note", async () => {
    await openWithRows([TODO_SHIP, RESEARCH])
    expect(rowIds()).toEqual(["blk_ship", "research"])
    expect(screen.getByTestId("result-count").textContent).toBe(
      "1 matching block in 1 note, 1 note by title",
    )
  })

  /** A note with when it was last edited. */
  const edited = (id: string, updatedAt: number) => ({ ...makeNote(id), updatedAt })

  it("with nothing typed, lists the recently touched notes — edits and opens merged, most recent first", () => {
    // `research` was edited last; `journal` was opened on this device more
    // recently still, so it leads. Nothing is highlighted, and no count.
    renderMenu({
      open: true,
      notes: [edited("research", 5000), edited("journal", 1000)],
      touches: [{ id: "journal", at: 9000 }],
    })
    expect(screen.getByText("Recent")).toBeTruthy()
    expect(rowIds()).toEqual(["journal", "research"])
    expect(screen.queryByTestId("result-count")).toBeNull()
    expect(document.querySelector('[cmdk-item][aria-selected="true"]')).toBeNull()
  })

  it("a note beyond the fifth most recently touched is not recent", () => {
    // Five notes newer than `research` (the rows are walked out of the
    // corpus, which holds `research` and `journal` only).
    const notes = [
      ...["n1", "n2", "n3", "n4"].map((id, i) => edited(id, 9000 - i)),
      edited("journal", 8000),
      edited("research", 100),
    ]
    renderMenu({ open: true, notes })
    expect(rowIds()).toEqual(["journal"])
    // A touch brings it back in, at the top — and `journal`, now sixth,
    // drops out.
    cleanup()
    renderMenu({ open: true, notes, touches: [{ id: "research", at: 10000 }] })
    expect(rowIds()).toEqual(["research"])
  })

  it("Recent gives way to the results the moment a query is typed", async () => {
    mocks.results = {
      mode: "blocks",
      hits: [TODO_SHIP],
      notes: [JOURNAL],
      titleMatches: [],
      rows: rowsOf([TODO_SHIP]),
    }
    renderMenu({ open: true, notes: [edited("research", 5000)] })
    expect(screen.getByText("Recent")).toBeTruthy()
    expect(rowIds()).toEqual(["research"])
    const input = commandsInput()
    fireEvent.change(input, { target: { value: "ship" } })
    await waitFor(() => {
      expect(screen.queryByText("Recent")).toBeNull()
    })
    expect(screen.getByText("Results")).toBeTruthy()
    expect(rowIds()).toEqual(["blk_ship"])
    // And comes back when the query is cleared.
    fireEvent.change(input, { target: { value: "" } })
    await waitFor(() => {
      expect(screen.getByText("Recent")).toBeTruthy()
    })
    expect(rowIds()).toEqual(["research"])
  })

  it("expands a note in the palette to its top-level blocks", async () => {
    await openWithNotes([RESEARCH])
    handOffToRows()
    fireEvent.keyDown(editor(), { key: "ArrowRight" })
    expect(rowIds()).toEqual(["research", "blk_semis", "blk_milk"])
    fireEvent.keyDown(editor(), { key: "ArrowLeft" })
    expect(rowIds()).toEqual(["research"])
  })

  it("Enter on a note row opens the note whole — not zoomed to a block", async () => {
    await openWithNotes([RESEARCH])
    handOffToRows()
    fireEvent.keyDown(editor(), { key: "Enter" })
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/notes/$",
      params: { _splat: "research" },
      search: { query: undefined, block: undefined },
    })
  })

  it("a block revealed under a note opens that block", async () => {
    await openWithNotes([RESEARCH])
    fireEvent.click(screen.getByLabelText("Expand"))
    fireEvent.click(screen.getByText("buy milk"))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/notes/$",
      params: { _splat: "research" },
      search: { query: undefined, block: "blk_milk" },
    })
  })
})

// ── Qualifier suggestions ───────────────────────────────────────────────────
// Typing `type:` (or `in:`, `has:`, …) opens the value picker inside the
// palette; its keys are the picker's until it closes, so cmdk's list never
// moves under it.

describe("qualifier suggestions", () => {
  /** Type into the palette with the caret parked at the end (jsdom doesn't
   * place it for us). */
  function type(value: string) {
    const input = commandsInput()
    fireEvent.change(input, { target: { value } })
    input.setSelectionRange(value.length, value.length)
    fireEvent.keyUp(input, { key: value.slice(-1) })
    return input
  }

  it("opens on `type:` with the block types, and Enter picks the highlighted one", () => {
    renderMenu({ open: true })
    const input = type("type:")
    const picker = screen.getByTestId("qualifier-suggestions")
    expect(picker.textContent).toContain("todo")
    expect(picker.textContent).toContain("heading")
    // ↓ moves the highlight within the picker, not cmdk's list.
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(input.value).toBe("type:done ")
    expect(mocks.navigate).not.toHaveBeenCalled()
    // Picked: the picker is gone, the query carries on.
    expect(screen.queryByTestId("qualifier-suggestions")).toBeNull()
  })

  it("narrows as you type, and Tab picks too", () => {
    renderMenu({ open: true })
    const input = type("milk type:qu")
    const picker = screen.getByTestId("qualifier-suggestions")
    expect(picker.querySelectorAll('[role="option"]')).toHaveLength(1)
    fireEvent.keyDown(input, { key: "Tab" })
    expect(input.value).toBe("milk type:quote ")
  })

  it("Escape closes it and leaves the query as typed — the palette stays open", () => {
    renderMenu({ open: true })
    const input = type("type:")
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByTestId("qualifier-suggestions")).toBeNull()
    expect(input.value).toBe("type:")
    // The dialog's own Escape (close) must not fire for the picker's Escape.
    expect(screen.getByPlaceholderText("Search or jump to…")).toBe(input)
    expect(input.isConnected).toBe(true)
  })

  it("points the palette's input at the highlighted row, and hands cmdk its ARIA back", () => {
    renderMenu({ open: true })
    const input = commandsInput()
    const cmdkControls = input.getAttribute("aria-controls")
    type("type:")
    const list = screen.getByTestId("qualifier-suggestions")
    expect(input.getAttribute("aria-controls")).toBe(list.id)
    const rows = list.querySelectorAll('[role="option"]')
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(input.getAttribute("aria-activedescendant")).toBe(rows[1].id)
    fireEvent.keyDown(input, { key: "Escape" })
    expect(input.getAttribute("aria-controls")).toBe(cmdkControls)
    expect(input.getAttribute("aria-activedescendant")).toBeNull()
  })

  it("stays shut for plain text and for unknown keys", () => {
    renderMenu({ open: true })
    type("nvidia")
    expect(screen.queryByTestId("qualifier-suggestions")).toBeNull()
    type("https://example.com")
    expect(screen.queryByTestId("qualifier-suggestions")).toBeNull()
  })
})
