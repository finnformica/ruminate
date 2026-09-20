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
    pinnedNotesAtom: atom([]),
    sharedNotesAtom: atom([]),
    // Derived from the graph in the real module; a plain writable atom here,
    // so a test can state the rows and be about the list rather than the sort.
    ownSortedNotesAtom: atom([]),
    noteSortAtom: atom("manual"),
  }
})

import {
  noteSortAtom,
  ownSortedNotesAtom,
  pinnedBlocksAtom,
  pinnedNotesAtom,
  type NoteSort,
} from "../global-state"
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

function renderSidebar({
  notes,
  sort = "manual",
  pinnedNotes = [],
  pinnedBlocks = [],
}: {
  notes: Note[]
  sort?: NoteSort
  pinnedNotes?: Note[]
  pinnedBlocks?: { id: string; noteId: string; text: string; note: Note }[]
}) {
  const store = createStore()
  store.set(noteSortAtom, sort)
  store.set(pinnedNotesAtom as never, pinnedNotes as never)
  store.set(pinnedBlocksAtom as never, pinnedBlocks as never)
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

  it("has no pinned band to be stopped at — a pinned row drags like any other", () => {
    // A pin lists a note under Pinned above; it does not move the note or
    // fence off part of the list, so every row may go anywhere.
    renderSidebar({ notes: [noteOf("p", "Pinned one", true), ...THREE] })
    const rows = noteRows()
    const transfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "" }
    // Drag `Alpha` (unpinned) above the pinned row.
    fireEvent.dragStart(rows[1], { dataTransfer: transfer })
    fireEvent.dragOver(rows[0], { dataTransfer: transfer, clientY: 0 })
    fireEvent.drop(rows[0], { dataTransfer: transfer, clientY: 0 })
    expect(mocks.moveNote).toHaveBeenCalledWith("a", ["a", "p", "b", "c"])
  })

  it("offers the menu move to a pinned row too", async () => {
    renderSidebar({ notes: [noteOf("p", "Pinned one", true), ...THREE] })
    const rows = noteRows()
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Note actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }))
    expect(mocks.moveNote).toHaveBeenCalledWith("a", ["a", "p", "b", "c"])
  })
})

describe("the sidebar's Pinned list", () => {
  it("is not drawn when nothing is pinned", () => {
    renderSidebar({ notes: THREE })
    const headings = screen.getAllByTestId("section-heading").map((el) => el.textContent?.trim())
    expect(headings).toEqual(["Notes"])
  })

  it("holds the pinned notes and the pinned blocks together, above Notes", () => {
    const pinnedNote = noteOf("p", "Pinned one", true)
    renderSidebar({
      notes: [pinnedNote, ...THREE],
      pinnedNotes: [pinnedNote],
      pinnedBlocks: [{ id: "blk_x", noteId: "a", text: "A pinned block", note: THREE[0] }],
    })
    const headings = screen.getAllByTestId("section-heading").map((el) => el.textContent?.trim())
    expect(headings).toEqual(["Pinned", "Notes"])
    // Both kinds are in the one band.
    expect(screen.getAllByText("Pinned one")).toHaveLength(2)
    expect(screen.getByText("A pinned block")).toBeTruthy()
  })

  it("tints BOTH pin variants, so the current row's filled pin stays a pin", () => {
    // The filled variant is the one the current row shows. Untinted, it took
    // the row's selected ink and the pin stopped looking like a pin; the
    // `nav-item-tint` class is what exempts it from that (index.css).
    const pinnedNote = noteOf("p", "Pinned one", true)
    renderSidebar({ notes: [pinnedNote, ...THREE], pinnedNotes: [pinnedNote] })
    const row = noteRows()[0].querySelector(".nav-item")!
    const icons = [...row.querySelectorAll(".nav-item-icon")]
    expect(icons).toHaveLength(2)
    for (const icon of icons) {
      expect(icon.className).toContain("text-text-pinned")
      expect(icon.className).toContain("nav-item-tint")
    }
  })

  it("leaves an unpinned row's icon to lean with the label", () => {
    // A favicon NAMES the row, so it hands itself to the selected ink — only
    // an icon reporting something about the row opts out.
    renderSidebar({ notes: THREE })
    const icons = [...noteRows()[0].querySelectorAll(".nav-item-icon")]
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) expect(icon.className).not.toContain("nav-item-tint")
  })

  it("draws a note row and a block row identically — same icon, same classes", () => {
    const pinnedNote = noteOf("p", "Pinned one", true)
    renderSidebar({
      notes: [pinnedNote, ...THREE],
      pinnedNotes: [pinnedNote],
      pinnedBlocks: [{ id: "blk_x", noteId: "a", text: "A pinned block", note: THREE[0] }],
    })
    const band = screen
      .getAllByTestId("section-heading")
      .find((h) => h.textContent?.trim() === "Pinned")!.parentElement!
    const icons = [...band.querySelectorAll("li .nav-item")].map((row) => {
      const icon = row.querySelector(".nav-item-icon:not(.hidden)")
      return `${icon?.className} ${icon?.querySelector("svg")?.innerHTML}`
    })
    expect(icons).toHaveLength(2)
    // The pin, both times — the note's own icon does not appear under Pinned.
    expect(new Set(icons).size).toBe(1)
  })

  it("gives a pinned note the pin in Notes too, in place of its own icon", () => {
    const pinnedNote = noteOf("p", "Pinned one", true)
    renderSidebar({ notes: [pinnedNote, ...THREE], pinnedNotes: [pinnedNote] })
    const iconOf = (row: Element) => {
      const icon = row.querySelector(".nav-item-icon:not(.hidden)")
      return `${icon?.className} ${icon?.querySelector("svg")?.innerHTML}`
    }
    const rows = noteRows()
    // The pinned note's row in Notes wears the pin, tinted as a pin...
    expect(iconOf(rows[0])).toContain("text-text-pinned")
    // ...and it is the same icon the row under Pinned wears.
    const band = screen
      .getAllByTestId("section-heading")
      .find((h) => h.textContent?.trim() === "Pinned")!.parentElement!
    expect(iconOf(rows[0])).toBe(iconOf(band.querySelector("li .nav-item")!))
    // An unpinned note keeps its own icon.
    expect(iconOf(rows[1])).not.toContain("text-text-pinned")
  })

  it("draws no second pin beside the name — the row's icon is the one", () => {
    const pinnedNote = noteOf("p", "Pinned one", true)
    renderSidebar({ notes: [pinnedNote, ...THREE], pinnedNotes: [pinnedNote] })
    // The name sits on its own: the marker that used to precede it is gone,
    // because the row's icon already says the note is pinned.
    const row = noteRows()[0].querySelector(".nav-item")!
    const name = row.querySelector("span.flex.min-w-0")!
    expect(name.querySelectorAll("svg")).toHaveLength(0)
    expect(name.textContent).toBe("Pinned one")
  })

  it("leaves the pinned note in its sorted place in Notes", () => {
    const pinnedNote = noteOf("b2", "Bravo two", true)
    renderSidebar({
      notes: [THREE[0], pinnedNote, THREE[1]],
      pinnedNotes: [pinnedNote],
    })
    // The pin does not float it: Notes keeps the order it was given.
    expect(rowNames()).toEqual(["Alpha", "Bravo two", "Bravo"])
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
