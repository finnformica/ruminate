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

vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  const { Searcher } = await import("fast-fuzzy")
  return {
    githubRepoAtom: atom(null),
    notesAtom: atom(new Map()),
    pinnedNotesAtom: atom([]),
    tagSearcherAtom: atom(
      new Searcher([] as [string, string[]][], { keySelector: ([tag]) => tag }),
    ),
    noteOutlineAtom: atom(null),
    blockRevealAtom: atom(null),
    isDatabaseModeAtom: atom(false),
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
