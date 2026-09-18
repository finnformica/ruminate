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
}))

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("../hooks/search-results", () => ({ useSearchResults: () => mocks.results }))
vi.mock("../data/store", () => ({ useApplyOps: () => () => {} }))
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
  return { ...original, ownSortedNotesAtom: atom([]), sharedNotesAtom: atom([]) }
})

import { ownSortedNotesAtom, sharedNotesAtom } from "../global-state"
import { NoteList } from "./note-list"

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
beforeEach(() => {
  mocks.results = { mode: "notes", hits: [], notes: [], titleMatches: [], rows: [] }
})

function renderList({
  own = [],
  shared = [],
  query = "",
}: {
  own?: Note[]
  shared?: Note[]
  query?: string
}) {
  const store = createStore()
  store.set(ownSortedNotesAtom as never, own as never)
  store.set(sharedNotesAtom as never, shared.map((note) => ({ note, share: {} })) as never)
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
      own: [noteOf("p", "Pinned", true), noteOf("a", "Alpha"), noteOf("b", "Bravo")],
      shared: [noteOf("s", "Shared one")],
    })
    expect(headings()).toEqual(["Pinned", "Notes", "Shared"])
    expect(bands()).toEqual(["p", "a,b", "s"])
  })

  it("draws no heading over a list that is the whole corpus", () => {
    renderList({ own: [noteOf("a", "Alpha"), noteOf("b", "Bravo")] })
    expect(headings()).toEqual([])
    expect(bands()).toEqual(["a,b"])
  })

  it("leaves out a band with nothing in it", () => {
    renderList({ own: [noteOf("p", "Pinned", true), noteOf("a", "Alpha")] })
    expect(headings()).toEqual(["Pinned", "Notes"])
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
    renderList({ own: [noteOf("p", "Pinned", true), noteOf("a", "Alpha")], query: "alpha" })
    expect(headings()).toEqual([])
    expect(screen.getAllByTestId("results")).toHaveLength(1)
  })
})
