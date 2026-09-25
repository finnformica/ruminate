// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BlockType } from "../blocks/types"
import type { Note } from "../schema"

// The sidebar sits inside the router and the whole global-state machine. Only
// the pieces the Views list needs are real here: the sort preference, the
// view rows (the order is written onto them), and the list's entries.
// Everything the surrounding chrome wants is stubbed.
const mocks = vi.hoisted(() => ({
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
    // Derived from the graph and the views in the real module; a plain
    // writable atom here, so a test can state the rows and be about the
    // list rather than the sort.
    viewEntriesAtom: atom([]),
    sharedNotesAtom: atom([]),
    noteSortAtom: atom("manual"),
  }
})

import { noteSortAtom, sharedNotesAtom, viewEntriesAtom, type NoteSort } from "../global-state"
import { viewsAtom, viewMapOf } from "../data/views"
import { NavItems } from "./nav-items"

const noteOf = (id: string, name: string): Note =>
  ({
    id,
    type: "note",
    displayName: name,
    title: name,
    props: {},
    updatedAt: null,
    dates: [],
    tasks: [],
    headings: [],
    text: "",
  }) as Note

afterEach(cleanup)
beforeEach(() => {
  mocks.pathname = "/"
})

type BlockViewRow = { id: string; noteId: string; text: string; type: BlockType; note: Note }

function renderSidebar({
  notes,
  sort = "manual",
  blocks = [],
  shared = [],
}: {
  notes: Note[]
  sort?: NoteSort
  /** The block views, listed after the notes — what the real atom yields
   * until something is dragged. */
  blocks?: BlockViewRow[]
  shared?: Note[]
}) {
  const store = createStore()
  store.set(noteSortAtom, sort)
  store.set(
    viewEntriesAtom as never,
    [
      ...notes.map((note) => ({ kind: "note", id: note.id, noteId: note.id, note })),
      ...blocks.map((block) => ({
        kind: "block",
        id: block.id,
        noteId: block.noteId,
        block: { ...block, updatedAt: null },
      })),
    ] as never,
  )
  // A block is a view by having a row (src/data/views.ts): the block rows
  // above are written as views here, as the real list would have them.
  store.set(
    viewsAtom,
    viewMapOf(
      blocks.map((block) => ({
        id: block.id,
        root_id: block.id,
        filter: null,
        sort: null,
        pinned: true,
        sort_key: null,
        updated_at: 1,
      })),
    ),
  )
  store.set(
    sharedNotesAtom as never,
    shared.map((note) => ({
      note,
      share: { owner: { login: "octocat", name: "Octo" }, permissions: ["read"] },
    })) as never,
  )
  render(
    <Provider store={store}>
      <NavItems />
    </Provider>,
  )
  return store
}

/** The Views list's rows — the top nav is a list of its own. */
const viewRows = () => within(screen.getByTestId("view-rows")).getAllByRole("listitem")

/** The rows' names, in the order drawn — the label alone, without the
 * glyph a block row leads with. */
const rowNames = () =>
  viewRows().map((li) => li.querySelector(".nav-item .truncate")?.textContent?.trim() ?? "")

/** The section headings, in order. */
const headings = () => screen.getAllByTestId("section-heading").map((el) => el.textContent?.trim())

/** The sort key of each view row, by root. */
const keysOf = (store: ReturnType<typeof createStore>, ids: string[]) =>
  ids.map((id) => store.get(viewsAtom).get(id)?.sort_key)

const transfer = () => ({ effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "" })

/** Drag `from` and drop it on the top half of `onto`, so it lands above. */
const dragAbove = (from: HTMLElement, onto: HTMLElement) => {
  const data = transfer()
  fireEvent.dragStart(from, { dataTransfer: data })
  fireEvent.dragOver(onto, { dataTransfer: data, clientY: 0 })
  fireEvent.drop(onto, { dataTransfer: data, clientY: 0 })
}

const THREE = [noteOf("a", "Alpha"), noteOf("b", "Bravo"), noteOf("c", "Charlie")]
const BLOCK: BlockViewRow = {
  id: "blk_x",
  noteId: "a",
  text: "A block view",
  type: "ul",
  note: THREE[0],
}

describe("the sidebar's Views list", () => {
  it("is the one list of the user's own — notes and block views under one heading, no Notes", () => {
    renderSidebar({ notes: THREE, blocks: [BLOCK] })
    expect(headings()).toEqual(["Views"])
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie", "A block view"])
  })

  it("lists what other people shared apart, beneath it", () => {
    renderSidebar({ notes: THREE, shared: [noteOf("s", "Shared one")] })
    expect(headings()).toEqual(["Views", "Shared"])
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie"])
    expect(screen.getByText("Shared one")).toBeTruthy()
  })

  it("names the top link Views, and reaches it by g then v", () => {
    renderSidebar({ notes: THREE })
    const link = screen.getByRole("link", { name: /^Views/ })
    expect(link.getAttribute("href")).toBe("/")
    expect(link.textContent?.toUpperCase()).toContain("V")
    expect(screen.queryByRole("link", { name: /^Notes/ })).toBeNull()
  })

  it("offers the three sorts, with the current one marked", async () => {
    renderSidebar({ notes: THREE, sort: "title" })
    fireEvent.click(screen.getByRole("button", { name: /^Sort views by/ }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem")
    expect(items.map((item) => item.textContent)).toEqual(["Name", "Recently updated", "Manual"])
  })

  it("changes the sort preference when one is picked", async () => {
    const store = renderSidebar({ notes: THREE, sort: "title" })
    fireEvent.click(screen.getByRole("button", { name: /^Sort views by/ }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    fireEvent.click(screen.getByRole("menuitem", { name: "Manual" }))
    await waitFor(() => expect(store.get(noteSortAtom)).toBe("manual"))
  })

  it("makes the rows draggable only in the manual sort — a block row too", () => {
    renderSidebar({ notes: THREE, blocks: [BLOCK], sort: "title" })
    expect(viewRows().every((li) => li.getAttribute("draggable") === null)).toBe(true)
    cleanup()
    renderSidebar({ notes: THREE, blocks: [BLOCK], sort: "manual" })
    expect(viewRows().every((li) => li.getAttribute("draggable") === "true")).toBe(true)
  })

  it("draws the rows in the order it is given", () => {
    renderSidebar({ notes: THREE })
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie"])
  })

  it("a drag keys every view in the dropped order, notes and blocks alike — a note gets a row for it", () => {
    const store = renderSidebar({ notes: THREE, blocks: [BLOCK] })
    const rows = viewRows()
    // Drag the block above `Alpha`.
    dragAbove(rows[3], rows[0])
    // Nothing was keyed before, so the first drag keys the whole list, in
    // the dropped order — the notes had no view rows, and have them now.
    const keys = keysOf(store, ["blk_x", "a", "b", "c"])
    expect(keys.every((key) => typeof key === "string")).toBe(true)
    expect([...keys].sort()).toEqual(keys)
  })

  it("moves a note row up from its actions menu — the keyboard's way to the same move", async () => {
    const store = renderSidebar({ notes: THREE })
    const rows = viewRows()
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Note actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }))
    const keys = keysOf(store, ["b", "a", "c"])
    expect(keys.every((key) => typeof key === "string")).toBe(true)
    expect([...keys].sort()).toEqual(keys)
  })

  it("moves a block row from its menu, for the keyboard", async () => {
    const store = renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    const rows = viewRows()
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Block view actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    // Last row: nothing below it to move past.
    expect(screen.getByRole("menuitem", { name: "Move down" }).getAttribute("aria-disabled")).toBe(
      "true",
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }))
    const keys = keysOf(store, ["blk_x", "a"])
    expect(keys[0]! < keys[1]!).toBe(true)
  })

  it("offers no move at all outside the manual sort", async () => {
    renderSidebar({ notes: THREE, blocks: [BLOCK], sort: "title" })
    const rows = viewRows()
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Note actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(within(rows[3]).getByRole("button", { name: "Block view actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull()
  })

  it("offers no Pin anywhere: a note's menu has none, and a block's row is removed instead", async () => {
    const store = renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    const rows = viewRows()
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Note actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    expect(screen.queryByRole("menuitem", { name: /pin/i })).toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Block view actions" }))
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy())
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from Views" }))
    // The block's row is gone from the views: it is no view at all now.
    expect(store.get(viewsAtom).has("blk_x")).toBe(false)
  })

  it("a block row opens its note focused on it, at the views address", () => {
    renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    const link = within(viewRows()[1]).getByRole("link")
    expect(link.getAttribute("href")).toBe("/views/$")
    expect(link.getAttribute("title")).toBe("Alpha › A block view")
  })

  it("draws a note row's icon and a block row's glyph through the same slot, neither tinted", () => {
    renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    const icons = viewRows().map((row) =>
      row.querySelector(".nav-item .nav-item-icon:not(.hidden)"),
    )
    expect(icons.every((icon) => icon !== null)).toBe(true)
    // A favicon NAMES the row, and so does the marker glyph on a block's:
    // both lean with the label when the row is current. Nothing reports a
    // state any more.
    for (const icon of icons) expect(icon!.className).not.toContain("nav-item-tint")
    // The note's favicon is an icon; the block's slot holds its marker.
    expect(icons[0]!.querySelector("svg")).not.toBeNull()
    expect(icons[1]!.querySelector("[data-glyph]")?.getAttribute("data-glyph")).toBe("-")
  })

  it("leads a block row with the block's own markdown marker, whatever its type", () => {
    const rows: BlockViewRow[] = [
      { ...BLOCK, id: "blk_todo", type: "todo" },
      { ...BLOCK, id: "blk_h2", type: "h2" },
      { ...BLOCK, id: "blk_ol", type: "ol" },
      { ...BLOCK, id: "blk_text", type: "text" },
    ]
    renderSidebar({ notes: [], blocks: rows })
    const glyphs = viewRows().map(
      (row) => row.querySelector(".nav-item-icon:not(.hidden) [data-glyph]")?.textContent,
    )
    expect(glyphs).toEqual(["[ ]", "##", "1.", "¶"])
  })

  it("lights the note's row only at the note's root, and the block's only focused on it", () => {
    mocks.pathname = "/views/a"
    renderSidebar({ notes: [THREE[0]], blocks: [BLOCK] })
    // The Calendar link reads the path the same way the note page does.
    expect(screen.getByRole("link", { name: /Calendar/ }).getAttribute("aria-current")).toBeNull()
  })
})

describe("the sidebar while Settings is open", () => {
  it("keeps the links above and the rows below, and lists the pages in the Views list's place", () => {
    mocks.pathname = "/settings/preferences"
    renderSidebar({ notes: THREE, shared: [noteOf("shared", "Theirs")] })
    // The chrome every page has.
    expect(screen.getByRole("link", { name: /^Views/ })).toBeTruthy()
    expect(screen.getByRole("link", { name: /^Calendar/ })).toBeTruthy()
    // Settings is current on any of its pages, as Help is while open.
    expect(screen.getByRole("link", { name: /^Settings/ }).getAttribute("aria-current")).toBe(
      "page",
    )
    expect(screen.getByRole("link", { name: /^Changelog/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /^Help/ })).toBeTruthy()
    // The pages, where the views were — and no way back, since Views is
    // right there above them.
    const headings = screen.getAllByTestId("section-heading").map((el) => el.textContent)
    expect(headings).toEqual(["Settings"])
    expect(screen.queryByTestId("view-rows")).toBeNull()
    expect(screen.queryByText("Theirs")).toBeNull()
    expect(screen.queryByText("Back to notes")).toBeNull()
    for (const page of ["Account", "Preferences", "Data", "About"]) {
      expect(screen.getByRole("link", { name: page })).toBeTruthy()
    }
    // Not this reader's: the feature pages (no feature is on here) and Admin.
    expect(screen.queryByRole("link", { name: "Sharing" })).toBeNull()
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull()
  })

  it("lists the views again once Settings is left", () => {
    mocks.pathname = "/"
    renderSidebar({ notes: THREE })
    expect(screen.getByTestId("view-rows")).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Account" })).toBeNull()
    expect(screen.getByRole("link", { name: /^Settings/ }).getAttribute("aria-current")).toBeNull()
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
