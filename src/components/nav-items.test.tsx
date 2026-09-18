// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Note } from "../schema"

// The sidebar sits inside the router and the whole global-state machine. Only
// the pieces the note list needs are real here: the sort preference, the
// order, and the rows. Everything the surrounding chrome wants is stubbed.
const mocks = vi.hoisted(() => ({
  moveNote: vi.fn(),
  pathname: "/",
}))

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to?: string }) => (
    <a href={to ?? "#"} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: mocks.pathname }),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { back: vi.fn(), forward: vi.fn() } }),
}))
vi.mock("../hooks/note", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/note")>()),
  useMoveNote: () => mocks.moveNote,
  useSetBlockProps: () => vi.fn(),
  useNoteById: () => undefined,
  useRenameNote: () => vi.fn(),
  useDeleteNote: () => vi.fn(),
  useSetNoteProps: () => vi.fn(),
}))
vi.mock("../hooks/share", () => ({ useNoteShare: () => null }))
vi.mock("../data/features", () => ({ useIsAdmin: () => false, useFeature: () => false }))
vi.mock("../data/store", () => ({ useApplyOps: () => () => {} }))
vi.mock("../hooks/app-update", async () => {
  const { atom } = await import("jotai")
  return { appUpdateAtom: atom({ needRefresh: false, apply: () => {} }) }
})
vi.mock("./sync-status", () => ({
  SyncStatusIcon: () => null,
  useSyncStatusText: () => null,
  useSyncStatusMeta: () => ({ action: null, tooltip: null }),
}))

vi.mock("../global-state", async (importOriginal) => {
  const original = await importOriginal<typeof import("../global-state")>()
  const { atom } = await import("jotai")
  const { buildGraphSnapshot } = await import("../data/graph")
  return {
    ...original,
    graphSnapshotAtom: atom(buildGraphSnapshot([], [])),
    isBootingAtom: atom(false),
    isSignedOutAtom: atom(false),
    pinnedBlocksAtom: atom([]),
    sharedNotesAtom: atom([]),
    // Derived from the graph in the real module; a plain writable atom here,
    // so a test can state the rows and be about the list rather than the sort.
    ownSortedNotesAtom: atom([]),
    noteSortAtom: atom("manual"),
  }
})

import { noteSortAtom, ownSortedNotesAtom, type NoteSort } from "../global-state"
import { NavItems } from "./nav-items"

const noteOf = (id: string, name: string, pinned = false): Note =>
  ({
    id,
    type: "note",
    displayName: name,
    title: name,
    props: {},
    pinned,
    updatedAt: null,
    dates: [],
    tasks: [],
    headings: [],
    text: "",
  }) as Note

afterEach(cleanup)
beforeEach(() => mocks.moveNote.mockClear())

function renderSidebar({ notes, sort = "manual" }: { notes: Note[]; sort?: NoteSort }) {
  const store = createStore()
  store.set(noteSortAtom, sort)
  // The sidebar reads its rows from `ownSortedNotesAtom`; pinning them into
  // the store keeps this about the list's behaviour rather than the sort.
  store.set(ownSortedNotesAtom as never, notes as never)
  render(
    <Provider store={store}>
      <NavItems />
    </Provider>,
  )
  return store
}

/** The note rows themselves — the top nav is a list of its own. */
const noteRows = () => within(screen.getByTestId("note-rows")).getAllByRole("listitem")

/** The note rows' names, in the order drawn. */
const rowNames = () => noteRows().map((li) => li.textContent?.trim() ?? "")

const THREE = [noteOf("a", "Alpha"), noteOf("b", "Bravo"), noteOf("c", "Charlie")]

describe("the sidebar's Notes list", () => {
  it("offers the three sorts, with the current one marked", async () => {
    renderSidebar({ notes: THREE, sort: "title" })
    fireEvent.click(screen.getByRole("button", { name: /^Sort notes by/ }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem")
    expect(items.map((item) => item.textContent)).toEqual(["Name", "Recently updated", "Manual"])
  })

  it("changes the sort preference when one is picked", async () => {
    const store = renderSidebar({ notes: THREE, sort: "title" })
    fireEvent.click(screen.getByRole("button", { name: /^Sort notes by/ }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    fireEvent.click(screen.getByRole("menuitem", { name: "Manual" }))
    await waitFor(() => expect(store.get(noteSortAtom)).toBe("manual"))
  })

  it("makes the rows draggable only in the manual sort", () => {
    renderSidebar({ notes: THREE, sort: "title" })
    expect(noteRows().every((li) => li.getAttribute("draggable") === null)).toBe(true)
    cleanup()
    renderSidebar({ notes: THREE, sort: "manual" })
    expect(noteRows().every((li) => li.getAttribute("draggable") === "true")).toBe(true)
  })

  it("draws the rows in the order it is given", () => {
    renderSidebar({ notes: THREE })
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie"])
  })

  it("asks for the move a drag describes", () => {
    renderSidebar({ notes: THREE })
    const rows = noteRows()
    const transfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "" }
    fireEvent.dragStart(rows[2], { dataTransfer: transfer })
    // Over the top half of the first row: `Charlie` lands above `Alpha`.
    fireEvent.dragOver(rows[0], { dataTransfer: transfer, clientY: 0 })
    fireEvent.drop(rows[0], { dataTransfer: transfer, clientY: 0 })
    expect(mocks.moveNote).toHaveBeenCalledWith("c", ["c", "a", "b"])
  })

  it("moves a row up from its actions menu — the keyboard's way to the same move", async () => {
    renderSidebar({ notes: THREE })
    const rows = noteRows()
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Note actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }))
    expect(mocks.moveNote).toHaveBeenCalledWith("b", ["b", "a", "c"])
  })

  it("offers no move at all outside the manual sort", async () => {
    renderSidebar({ notes: THREE, sort: "title" })
    const rows = noteRows()
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Note actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull()
  })

  it("ignores a drag that would carry a note across the pinned boundary", () => {
    // Pinned leads the list in every sort, so the row would spring back.
    renderSidebar({ notes: [noteOf("p", "Pinned one", true), ...THREE] })
    const rows = noteRows()
    const transfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "" }
    // Drag `Alpha` (unpinned) above the pinned row.
    fireEvent.dragStart(rows[1], { dataTransfer: transfer })
    fireEvent.dragOver(rows[0], { dataTransfer: transfer, clientY: 0 })
    fireEvent.drop(rows[0], { dataTransfer: transfer, clientY: 0 })
    expect(mocks.moveNote).not.toHaveBeenCalled()
  })

  it("offers no menu move across the pinned boundary either", async () => {
    // Pinned leads the list whatever the sort, so a move out of the band
    // would spring back — the menu does not offer it.
    renderSidebar({ notes: [noteOf("p", "Pinned one", true), ...THREE] })
    const rows = noteRows()
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Note actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    expect(screen.getByRole("menuitem", { name: "Move up" }).getAttribute("aria-disabled")).toBe(
      "true",
    )
  })
})

describe("the sidebar's bottom block", () => {
  it("names the changelog Changelog, and gives it a chord", () => {
    renderSidebar({ notes: THREE })
    const changelog = screen.getByRole("link", { name: /Changelog/ })
    expect(changelog.textContent).toContain("Changelog")
    expect(changelog.textContent).not.toContain("What's new")
    expect(changelog.textContent?.toUpperCase()).toContain("C")
  })
})
