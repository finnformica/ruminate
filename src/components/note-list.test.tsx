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
    pinnedRootsAtom: atom([]),
  }
})

import { ownSortedNotesAtom, pinnedRootsAtom, sharedNotesAtom } from "../global-state"
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
  pinned = [],
  query = "",
}: {
  own?: Note[]
  shared?: Note[]
  /** The Views band's roots — notes and blocks alike (`pinnedRootsAtom`). */
  pinned?: { id: string; noteId: string }[]
  query?: string
}) {
  const store = createStore()
  store.set(ownSortedNotesAtom as never, own as never)
  store.set(sharedNotesAtom as never, shared.map((note) => ({ note, share: {} })) as never)
  store.set(pinnedRootsAtom as never, pinned as never)
  render(
    <Provider store={store}>
      <NoteList query={query} onQueryChange={() => {}} />
    </Provider>,
  )
}

const headings = () => screen.queryAllByRole("heading").map((h) => h.textContent)
const bands = () => screen.getAllByTestId("results").map((el) => el.textContent)

describe("the notes page listing", () => {
  it("splits browsing into the sidebar's sections, in the sidebar's order", () => {
    renderList({
      own: [noteOf("p", "Pinned"), noteOf("a", "Alpha"), noteOf("b", "Bravo")],
      shared: [noteOf("s", "Shared one")],
      pinned: [{ id: "p", noteId: "p" }],
    })
    expect(headings()).toEqual(["Views", "Notes", "Shared"])
    // The pinned note leads under Views AND keeps its place in Notes.
    expect(bands()).toEqual(["p", "p,a,b", "s"])
  })

  it("draws the pinned blocks under Views, not just the pinned notes", () => {
    // The sidebar's Pinned list holds both kinds; the page's must match, or
    // a pinned block is reachable from one surface and not the other.
    renderList({
      own: [noteOf("a", "Alpha")],
      pinned: [
        { id: "a", noteId: "a" },
        { id: "blk_x", noteId: "a" },
      ],
    })
    expect(headings()).toEqual(["Views", "Notes"])
    expect(bands()).toEqual(["a,blk_x", "a"])
  })

  it("leads with Recent — notes and focused blocks — above Views, a place in both under each", () => {
    mocks.recent = [
      { id: "blk_fashion", noteId: "p" },
      { id: "a", noteId: "a" },
    ]
    renderList({
      own: [noteOf("p", "Personal"), noteOf("a", "Alpha")],
      pinned: [{ id: "a", noteId: "a" }],
    })
    expect(headings()).toEqual(["Recent", "Views", "Notes"])
    expect(bands()).toEqual(["blk_fashion,a", "a", "p,a"])
  })

  it("names the Notes band when Recent is the only other", () => {
    mocks.recent = [{ id: "a", noteId: "a" }]
    renderList({ own: [noteOf("a", "Alpha")] })
    expect(headings()).toEqual(["Recent", "Notes"])
  })

  it("draws no heading over a list that is the whole corpus", () => {
    renderList({ own: [noteOf("a", "Alpha"), noteOf("b", "Bravo")] })
    expect(headings()).toEqual([])
    expect(bands()).toEqual(["a,b"])
  })

  it("leaves out a band with nothing in it", () => {
    renderList({ own: [noteOf("a", "Alpha")], pinned: [{ id: "a", noteId: "a" }] })
    expect(headings()).toEqual(["Views", "Notes"])
  })

  it("draws no Pinned band when nothing is pinned", () => {
    renderList({ own: [noteOf("a", "Alpha"), noteOf("b", "Bravo")] })
    expect(headings()).toEqual([])
    expect(bands()).toEqual(["a,b"])
  })

  it("keeps a shared note out of your own band", () => {
    renderList({ own: [noteOf("a", "Alpha")], shared: [noteOf("s", "Shared one")] })
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
      own: [noteOf("p", "Pinned"), noteOf("a", "Alpha")],
      pinned: [{ id: "p", noteId: "p" }],
      query: "alpha",
    })
    expect(headings()).toEqual([])
    expect(screen.getAllByTestId("results")).toHaveLength(1)
  })
})
