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
  match: { params: { _splat: "note-1" } } as { params: { _splat: string } } | undefined,
  // The block-search data source, injected at its single seam
  // (`useBlockSearchSource`) — see src/utils/block-search-source.ts.
  results: { mode: "notes", hits: [], notes: [] } as {
    mode: "blocks" | "notes"
    hits: unknown[]
    notes: unknown[]
  },
  children: new Map<string, unknown[]>(),
  childCalls: [] as string[],
}))

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useMatch: () => mocks.match,
}))

vi.mock("../hooks/note", () => ({
  useNoteById: () => undefined,
  useSaveNote: () => vi.fn(),
}))

vi.mock("../hooks/search-notes", () => ({
  useSearchNotes: () => () => [],
}))

vi.mock("../hooks/search-results", () => ({
  useSearchResults: () => mocks.results,
  useBlockSearchSource: () => ({
    search: () => mocks.results.hits,
    children: (hit: { blockId: string }) => {
      mocks.childCalls.push(hit.blockId)
      return mocks.children.get(hit.blockId) ?? []
    },
  }),
}))

vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  const { Searcher } = await import("fast-fuzzy")
  return {
    notesAtom: atom(new Map()),
    pinnedNotesAtom: atom([]),
    tagSearcherAtom: atom(
      new Searcher([] as [string, string[]][], { keySelector: ([tag]) => tag }),
    ),
    noteOutlineAtom: atom(null),
    blockRevealAtom: atom(null),
  }
})

import { blockRevealAtom, noteOutlineAtom } from "../global-state"
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
  mocks.results = { mode: "notes", hits: [], notes: [] }
  mocks.children = new Map()
  mocks.childCalls = []
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
}: { outline?: typeof OUTLINE | null; open?: boolean } = {}) {
  const store = createStore()
  store.set(noteOutlineAtom, outline)
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
    expect(beta.style.paddingLeft).toBe("36px")
    const alpha = screen.getByText("Alpha").closest("[cmdk-item]") as HTMLElement
    expect(alpha.style.paddingLeft).toBe("12px")
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
    content: "",
    type: "note",
    displayName: id,
    frontmatter: {},
    title: id,
    url: null,
    alias: null,
    aliases: [],
    pinned: false,
    updatedAt: null,
    dates: [],
    tags: [],
    tasks: [],
  }
}

const RESEARCH = makeNote("research")

function hit(
  blockId: string,
  text: string,
  type: string,
  ancestors: { id: string; text: string }[] = [],
  childCount = 0,
) {
  return { blockId, noteId: RESEARCH.id, text, type, ancestors, childCount, note: RESEARCH }
}

/** A heading nested under two other blocks — invisible to the old note-only
 * results, a first-class row now. */
const NVIDIA = hit(
  "blk_nvidia",
  "nvidia",
  "h3",
  [
    { id: "blk_semis", text: "Semiconductors" },
    { id: "blk_gpus", text: "GPUs" },
  ],
  2,
)
const TODO_MILK = hit("blk_milk", "buy milk", "todo")
const TODO_SHIP = hit("blk_ship", "ship it", "todo")

async function openWithBlocks(hits: unknown[], notes: unknown[] = [RESEARCH]) {
  mocks.results = { mode: "blocks", hits, notes }
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

const rowFor = (text: string) => screen.getByText(text).closest("[cmdk-item]") as HTMLElement | null

describe("block results", () => {
  it("lists a nested heading as its own row, with its breadcrumb", async () => {
    await openWithBlocks([NVIDIA])
    const row = rowFor("nvidia")
    expect(row).toBeTruthy()
    // Where it lives: note, then ancestry.
    expect(row?.textContent).toContain("research")
    expect(row?.textContent).toContain("Semiconductors")
    expect(row?.textContent).toContain("GPUs")
  })

  it("lists matching todo blocks as rows (the type:todo case)", async () => {
    await openWithBlocks([TODO_MILK, TODO_SHIP])
    expect(rowFor("buy milk")).toBeTruthy()
    expect(rowFor("ship it")).toBeTruthy()
  })

  it("shows the count of matched blocks, and the notes they live in", async () => {
    await openWithBlocks([NVIDIA, TODO_MILK, TODO_SHIP])
    expect(screen.getByText("See all 3 matching blocks in 1 note")).toBeTruthy()
  })

  it("says so plainly when nothing matches", async () => {
    await openWithBlocks([], [])
    expect(screen.getByText("No matching blocks")).toBeTruthy()
  })

  it("Enter on the query opens the full results view at ?query=", async () => {
    await openWithBlocks([NVIDIA])
    // Nothing arrowed: cmdk highlights the first row, which is "see all".
    fireEvent.keyDown(commandsInput(), { key: "Enter" })
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", search: { query: "nvidia" } })
  })

  it("Enter on a highlighted hit opens its note, zoomed to the block", async () => {
    await openWithBlocks([NVIDIA])
    fireEvent.keyDown(commandsInput(), { key: "ArrowDown" })
    fireEvent.keyDown(commandsInput(), { key: "Enter" })
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/notes/$",
      params: { _splat: "research" },
      search: { query: undefined, block: "blk_nvidia" },
    })
  })

  it("→ expands a hit in place, resolving its children once; ← collapses", async () => {
    mocks.children.set("blk_nvidia", [
      hit("blk_h100", "H100 supply", "bullet"),
      hit("blk_rev", "datacenter revenue", "bullet"),
    ])
    await openWithBlocks([NVIDIA])

    fireEvent.keyDown(commandsInput(), { key: "ArrowDown" })
    expect(screen.queryByText("H100 supply")).toBeNull()

    fireEvent.keyDown(commandsInput(), { key: "ArrowRight" })
    expect(screen.getByText("H100 supply")).toBeTruthy()
    expect(screen.getByText("datacenter revenue")).toBeTruthy()
    expect(mocks.childCalls).toEqual(["blk_nvidia"])

    fireEvent.keyDown(commandsInput(), { key: "ArrowLeft" })
    expect(screen.queryByText("H100 supply")).toBeNull()

    // Re-expanding is served from the tree's own cache — no second fetch.
    fireEvent.keyDown(commandsInput(), { key: "ArrowRight" })
    expect(screen.getByText("H100 supply")).toBeTruthy()
    expect(mocks.childCalls).toEqual(["blk_nvidia", "blk_nvidia"])
  })

  it("clicking the chevron expands and collapses the same way", async () => {
    mocks.children.set("blk_nvidia", [hit("blk_h100", "H100 supply", "bullet")])
    await openWithBlocks([NVIDIA])

    const toggle = screen.getByLabelText("Expand")
    fireEvent.click(toggle)
    expect(screen.getByText("H100 supply")).toBeTruthy()
    // The click expanded rather than opening the result.
    expect(mocks.navigate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText("Collapse"))
    expect(screen.queryByText("H100 supply")).toBeNull()
  })

  it("a leaf hit draws no expand affordance", async () => {
    await openWithBlocks([TODO_MILK])
    const toggle = screen.getByLabelText("Expand")
    expect(toggle.className).toContain("opacity-0")
  })

  it("leaves the arrows to the query input while the caret is inside the text", async () => {
    mocks.children.set("blk_nvidia", [hit("blk_h100", "H100 supply", "bullet")])
    await openWithBlocks([NVIDIA])
    fireEvent.keyDown(commandsInput(), { key: "ArrowDown" })

    const input = commandsInput()
    input.setSelectionRange(2, 2)
    fireEvent.keyDown(input, { key: "ArrowRight" })
    expect(screen.queryByText("H100 supply")).toBeNull()
    expect(mocks.childCalls).toEqual([])
  })
})
