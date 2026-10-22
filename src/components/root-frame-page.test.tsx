// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Note } from "../schema"

// The Root frame (src/data/root-frame.ts): the base of every pane, the list
// of every note. The router and the page's chrome are stubbed; the notes and
// the graph are plain atoms a test sets.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params: _params,
    ...props
  }: {
    children: React.ReactNode
    to?: string
    params?: unknown
  }) => (
    <a href={to ?? "#"} {...props}>
      {children}
    </a>
  ),
}))
vi.mock("./page-layout", () => ({
  PageLayout: ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}))
vi.mock("./note-favicon", () => ({ NoteFavicon: () => null }))
const applied = vi.hoisted(() => ({ ops: [] as unknown[] }))
vi.mock("../data/store", () => ({
  useApplyOps: () => (ops: unknown[]) => applied.ops.push(...ops),
}))
vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  const { buildGraphSnapshot } = await import("../data/graph")
  return {
    ownSortedNotesAtom: atom<Note[]>([]),
    graphSnapshotAtom: atom(buildGraphSnapshot([], [])),
  }
})

import { buildGraphSnapshot, CHILD_KIND, CORPUS_ROOT_ID } from "../data/graph"
import { graphSnapshotAtom, ownSortedNotesAtom } from "../global-state"
import { RootFramePage } from "./root-frame-page"

afterEach(cleanup)

const noteOf = (id: string, name: string, type = "note") =>
  ({ id, type, displayName: name, title: name, props: {} }) as Note

const NOTES = [noteOf("c", "Cherry"), noteOf("a", "Apple"), noteOf("b", "Banana")]

function renderRoot({ landing = null }: { landing?: string | null } = {}) {
  const store = createStore()
  store.set(ownSortedNotesAtom as never, NOTES as never)
  // The corpus root holds Cherry: it was dragged to the top.
  store.set(
    graphSnapshotAtom as never,
    buildGraphSnapshot(
      [
        { id: CORPUS_ROOT_ID, type: "corpus_root", text: "", props: null, updated_at: 0 },
        ...NOTES.map((note) => ({
          id: note.id,
          type: "note",
          text: note.displayName,
          props: null,
          updated_at: 0,
        })),
      ],
      [
        {
          source_id: CORPUS_ROOT_ID,
          destination_id: "c",
          kind: CHILD_KIND,
          sort_key: "a0",
          updated_at: 0,
        },
      ],
    ) as never,
  )
  const onOpen = vi.fn()
  render(
    <Provider store={store}>
      <RootFramePage landing={landing} leading onOpen={onOpen} onActivate={() => {}} />
    </Provider>,
  )
  return { onOpen }
}

const rows = () =>
  within(screen.getByRole("list", { name: "Root" }))
    .getAllByRole("link")
    .map((row) => row.textContent)

describe("the Root frame page", () => {
  it("is called Root, and lists the notes the root links first, then the rest by title", () => {
    renderRoot()
    expect(screen.getByRole("heading").textContent).toBe("Root")
    expect(rows()).toEqual(["Cherry", "Apple", "Banana"])
  })

  it("opens a note in the pane on a plain click, and leaves a modified click to the link", () => {
    const { onOpen } = renderRoot()
    fireEvent.click(screen.getByText("Apple"))
    expect(onOpen).toHaveBeenCalledWith(NOTES[1])
    onOpen.mockClear()
    fireEvent.click(screen.getByText("Apple"), { metaKey: true })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("lands on the note the reader came back down from", () => {
    renderRoot({ landing: "b" })
    expect(document.activeElement?.textContent).toBe("Banana")
  })

  it("moves between the rows with the arrow keys", () => {
    renderRoot({ landing: "c" })
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
    expect(document.activeElement?.textContent).toBe("Apple")
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" })
    expect(document.activeElement?.textContent).toBe("Cherry")
  })

  it("writes the root's link for a note dragged to a new place", () => {
    applied.ops.length = 0
    renderRoot()
    const row = (name: string) => screen.getByText(name).closest("li")!
    const data = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "" }
    // Banana, above Apple.
    fireEvent.dragStart(row("Banana"), { dataTransfer: data })
    fireEvent.dragOver(row("Apple"), { dataTransfer: data, clientY: 0 })
    fireEvent.drop(row("Apple"), { dataTransfer: data, clientY: 0 })
    // The first drag keys every row, in the order now on screen.
    const links = applied.ops.filter((op) => (op as { op: string }).op === "link") as {
      destination: string
      sortKey: string
    }[]
    const order = [...links].sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))
    expect(order.map((link) => link.destination)).toEqual(["c", "b", "a"])
  })
})
