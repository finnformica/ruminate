// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Note } from "../schema"

const mocks = vi.hoisted(() => ({
  results: { mode: "notes", hits: [], notes: [], titleMatches: [], rows: [] } as {
    mode: "blocks" | "notes"
    hits: unknown[]
    notes: unknown[]
    titleMatches: unknown[]
    rows: unknown[]
  },
  recent: [] as { id: string; noteId: string }[],
}))

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("../hooks/search-results", () => ({ useSearchResults: () => mocks.results }))
vi.mock("../data/store", () => ({ useApplyOps: () => () => {} }))
vi.mock("../hooks/recent-roots", () => ({ useRecentRoots: () => mocks.recent }))
// The rows are the block editor over the graph; this file is about which
// bands the page draws and what they are called, so the rows are stubbed.
vi.mock("./results-list", () => ({
  ResultsList: ({ browseRoots }: { browseRoots?: { id: string }[] }) => (
    <div data-testid="results">{(browseRoots ?? []).map((root) => root.id).join(",")}</div>
  ),
}))
vi.mock("./query-box", () => ({ QueryBox: () => <div /> }))

vi.mock("../global-state", async (importOriginal) => {
  const original = await importOriginal<typeof import("../global-state")>()
  const { atom } = await import("jotai")
  return {
    ...original,
    ownSortedNotesAtom: atom([]),
    sharedNotesAtom: atom([]),
    viewRootsAtom: atom([]),
  }
})

import { ownSortedNotesAtom, sharedNotesAtom, viewRootsAtom } from "../global-state"
import { NoteList } from "./note-list"

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
  mocks.results = { mode: "notes", hits: [], notes: [], titleMatches: [], rows: [] }
  mocks.recent = []
})

function renderList({
  own = [],
  shared = [],
  views = [],
  query = "",
}: {
  own?: Note[]
  shared?: Note[]
  /** The Views band's roots — notes and blocks alike (`viewRootsAtom`). */
  views?: { id: string; noteId: string }[]
  query?: string
}) {
  const store = createStore()
  store.set(ownSortedNotesAtom as never, own as never)
  store.set(sharedNotesAtom as never, shared.map((note) => ({ note, share: {} })) as never)
  store.set(viewRootsAtom as never, views as never)
  render(
    <Provider store={store}>
      <NoteList query={query} onQueryChange={() => {}} />
    </Provider>,
  )
}

const headings = () => screen.queryAllByRole("heading").map((h) => h.textContent)
const bands = () => screen.getAllByTestId("results").map((el) => el.textContent)

describe("the Views page listing", () => {
  it("browses Recent, then Views, then Shared — a place used lately is under both", () => {
    mocks.recent = [
      { id: "blk_fashion", noteId: "p" },
      { id: "a", noteId: "a" },
    ]
    renderList({
      own: [noteOf("p", "Personal"), noteOf("a", "Alpha"), noteOf("b", "Bravo")],
      shared: [noteOf("s", "Shared one")],
      views: [
        { id: "p", noteId: "p" },
        { id: "a", noteId: "a" },
        { id: "b", noteId: "b" },
      ],
    })
    // No Notes band: the Views band is the sidebar's whole list.
    expect(headings()).toEqual(["Recent", "Views", "Shared"])
    expect(bands()).toEqual(["blk_fashion,a", "p,a,b", "s"])
  })

  it("draws the block views under Views, among the notes", () => {
    // The sidebar's list holds both kinds; the page's must match, or a
    // block view is reachable from one surface and not the other.
    renderList({
      own: [noteOf("a", "Alpha")],
      views: [
        { id: "a", noteId: "a" },
        { id: "blk_x", noteId: "a" },
      ],
    })
    expect(headings()).toEqual(["Views"])
    expect(bands()).toEqual(["a,blk_x"])
  })

  it("leaves out a band with nothing in it", () => {
    mocks.recent = [{ id: "a", noteId: "a" }]
    renderList({ own: [noteOf("a", "Alpha")] })
    expect(headings()).toEqual(["Recent"])
  })

  it("keeps shared notes out of Views — they have a band of their own", () => {
    renderList({
      own: [noteOf("a", "Alpha")],
      shared: [noteOf("s", "Shared one")],
      views: [{ id: "a", noteId: "a" }],
    })
    expect(headings()).toEqual(["Views", "Shared"])
    expect(bands()).toEqual(["a", "s"])
  })

  it("does not section a query — ranked results are one list", () => {
    mocks.results = {
      mode: "blocks",
      hits: [{}],
      notes: [{}],
      titleMatches: [],
      rows: [{ id: "blk_x", noteId: "a" }],
    }
    renderList({
      own: [noteOf("p", "Personal"), noteOf("a", "Alpha")],
      views: [{ id: "p", noteId: "p" }],
      query: "alpha",
    })
    expect(headings()).toEqual([])
    expect(screen.getAllByTestId("results")).toHaveLength(1)
  })
})
