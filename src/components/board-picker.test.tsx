// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { boardFeatures, DEFAULT_FEATURES, linkBoardOps } from "../data/boards"
import { BOARD_TYPE, buildGraphSnapshot, childIdsOf, docToGraph } from "../data/graph"
import { applyOps } from "../data/ops"
import { viewsAtom } from "../data/views"
import { graphSnapshotAtom, sampleGraphAtom } from "../global-state"
import { BoardPicker, boardPickerAtom, RECENT_BOARDS } from "./board-picker"

const pointer = vi.hoisted(() => ({ coarse: false }))
vi.mock("../hooks/coarse-pointer", () => ({ useCoarsePointer: () => pointer.coarse }))

Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  pointer.coarse = false
})

/** A note `n` with one row, and boards named and stamped as given: Hall is
 * already under the note. */
function graphOf(boards: { id: string; title: string; updated?: string }[]) {
  const nodes: NodeRow[] = []
  const links: LinkRow[] = []
  const add = (id: string, markdown: string, board?: { title: string; updated?: string }) => {
    const g = docToGraph(id, serialize(parse(markdown)), 1)
    nodes.push(
      ...g.nodes.map((n) =>
        n.id === id && board
          ? {
              ...n,
              text: board.title,
              type: BOARD_TYPE,
              props: board.updated ? JSON.stringify({ updated_at: board.updated }) : null,
            }
          : n,
      ),
    )
    links.push(...g.links)
  }
  add("n", "- one\n  id:: blk_one0000000\n")
  for (const board of boards) add(board.id, "", board)
  const snapshot = buildGraphSnapshot(nodes, links)
  return applyOps(snapshot, linkBoardOps(snapshot, "n", "blk_hall000000"), 1)
}

const BOARDS = [
  { id: "blk_kitchen000", title: "Kitchen", updated: "2026-10-01T00:00:00Z" },
  { id: "blk_garden0000", title: "Garden", updated: "2026-10-03T00:00:00Z" },
  { id: "blk_attic00000", title: "Attic" },
  { id: "blk_hall000000", title: "Hall", updated: "2026-10-02T00:00:00Z" },
]

function open(boards = BOARDS, noteId = "n") {
  const store = createStore()
  store.set(sampleGraphAtom, graphOf(boards))
  const place = vi.fn()
  store.set(boardPickerAtom, {
    noteId,
    anchor: null,
    parentId: "n",
    placement: { after: "blk_one0000000" },
    place,
  })
  render(
    <Provider store={store}>
      <BoardPicker />
    </Provider>,
  )
  return { store, place }
}

const rows = () => screen.getAllByRole("option").map((row) => row.textContent)
const field = () => screen.getByLabelText("Find or name a board")

describe("BoardPicker", () => {
  it("lists the reader's boards most recently updated first, then Create new board", () => {
    open()
    // Garden (3 Oct), Kitchen (1 Oct), Attic (never); Hall is under the note already.
    expect(rows()).toEqual(["Garden", "Kitchen", "Attic", "Create new board"])
  })

  it("filters by name as typed, and offers to create what was typed", () => {
    open()
    fireEvent.change(field(), { target: { value: "kit" } })
    expect(rows()).toEqual(["Kitchen", "Create “kit”"])
    fireEvent.change(field(), { target: { value: "Pantry" } })
    expect(rows()).toEqual(["Create “Pantry”"])
  })

  it("caps the untyped list at the most recent few; a search reaches them all", () => {
    const many = Array.from({ length: RECENT_BOARDS + 3 }, (_, i) => ({
      id: `blk_board${String(i).padStart(6, "0")}`,
      title: `Board ${String.fromCharCode(65 + i)}`,
      updated: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }))
    open(many)
    expect(screen.getAllByRole("option")).toHaveLength(RECENT_BOARDS + 1)
    fireEvent.change(field(), { target: { value: "board" } })
    expect(screen.getAllByRole("option")).toHaveLength(many.length + 1)
  })

  it("never offers the board being edited", () => {
    open(BOARDS, "blk_kitchen000")
    expect(rows()).toEqual(["Garden", "Attic", "Create new board"])
  })

  it("Enter picks the highlighted board: one link, then the row is placed", () => {
    const { store, place } = open()
    fireEvent.keyDown(field(), { key: "ArrowDown" })
    fireEvent.keyDown(field(), { key: "Enter" })
    expect(childIdsOf(store.get(graphSnapshotAtom), "n")).toEqual([
      "blk_one0000000",
      "blk_kitchen000",
      "blk_hall000000",
    ])
    expect(place).toHaveBeenCalledWith({
      id: "blk_kitchen000",
      type: "board",
      text: "Kitchen",
      props: { updated_at: "2026-10-01T00:00:00Z" },
      children: [],
    })
    expect(store.get(boardPickerAtom)).toBeNull()
  })

  it("the arrows wrap through the create row, and a click picks too", () => {
    const { store, place } = open()
    fireEvent.keyDown(field(), { key: "ArrowUp" })
    expect(screen.getByTestId("board-picker-create").getAttribute("aria-selected")).toBe("true")
    fireEvent.click(screen.getByRole("option", { name: "Garden" }))
    expect(childIdsOf(store.get(graphSnapshotAtom), "n")).toContain("blk_garden0000")
    expect(place).toHaveBeenCalledTimes(1)
  })

  it("Create “name” makes the board where the row is, unlisted, in one batch", () => {
    const { store, place } = open()
    fireEvent.change(field(), { target: { value: "Pantry" } })
    fireEvent.keyDown(field(), { key: "Enter" })
    const snapshot = store.get(graphSnapshotAtom)
    const board = [...snapshot.nodes.values()].find((node) => node.text === "Pantry")!
    expect(board.type).toBe("board")
    expect(childIdsOf(snapshot, "n")).toEqual(["blk_one0000000", board.id, "blk_hall000000"])
    expect(boardFeatures(snapshot, board.id).map((s) => s.feature.label)).toEqual(
      DEFAULT_FEATURES.map((entry) => entry.label),
    )
    expect(store.get(viewsAtom).get(board.id)).toBeUndefined()
    expect(place).toHaveBeenCalledWith(
      expect.objectContaining({ id: board.id, type: "board", text: "Pantry" }),
    )
  })

  it("Create new board with nothing typed makes an untitled board", () => {
    const { store, place } = open()
    fireEvent.click(screen.getByTestId("board-picker-create"))
    const snapshot = store.get(graphSnapshotAtom)
    const made = childIdsOf(snapshot, "n")[1]
    expect(snapshot.nodes.get(made)?.type).toBe("board")
    expect(snapshot.nodes.get(made)?.text).toBe(made)
    expect(place).toHaveBeenCalledTimes(1)
  })

  it("Escape closes with nothing done", () => {
    const { store, place } = open()
    fireEvent.keyDown(field(), { key: "Escape" })
    expect(store.get(boardPickerAtom)).toBeNull()
    expect(place).not.toHaveBeenCalled()
    expect(childIdsOf(store.get(graphSnapshotAtom), "n")).toEqual([
      "blk_one0000000",
      "blk_hall000000",
    ])
  })

  it("is a sheet on a phone, with the same rows", () => {
    pointer.coarse = true
    open()
    expect(screen.getByText("Board")).toBeTruthy()
    expect(rows()).toEqual(["Garden", "Kitchen", "Attic", "Create new board"])
  })
})
