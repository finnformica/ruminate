// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { linkBoardOps } from "../data/boards"
import { BOARD_TYPE, buildGraphSnapshot, childIdsOf, docToGraph } from "../data/graph"
import { applyOps } from "../data/ops"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { graphSnapshotAtom, sampleGraphAtom } from "../global-state"
import { LinkBoardDialog, linkBoardDialogAtom } from "./link-board-dialog"

Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup)

/** A note `n` with one row, and three boards: Kitchen, Garden and Hall,
 * with Hall already under the note. */
function graphOf() {
  const nodes: NodeRow[] = []
  const links: LinkRow[] = []
  const add = (id: string, markdown: string, title?: string) => {
    const g = docToGraph(id, serialize(parse(markdown)), 1)
    nodes.push(
      ...g.nodes.map((n) => (n.id === id && title ? { ...n, text: title, type: BOARD_TYPE } : n)),
    )
    links.push(...g.links)
  }
  add("n", "- one\n  id:: blk_one0000000\n")
  add("blk_kitchen000", "", "Kitchen")
  add("blk_garden0000", "", "Garden")
  add("blk_hall000000", "", "Hall")
  const snapshot = buildGraphSnapshot(nodes, links)
  return applyOps(snapshot, linkBoardOps(snapshot, "n", "blk_hall000000"), 1)
}

function open(place = vi.fn(), noteId = "n") {
  const store = createStore()
  store.set(sampleGraphAtom, graphOf())
  store.set(linkBoardDialogAtom, {
    noteId,
    into: { parentId: "n", placement: { after: "blk_one0000000" }, place },
  })
  render(
    <Provider store={store}>
      <LinkBoardDialog />
    </Provider>,
  )
  return { store, place }
}

describe("LinkBoardDialog", () => {
  it("lists the reader's own boards by name, less the note itself and the ones already there", () => {
    open()
    const rows = screen.getAllByRole("option").map((row) => row.textContent)
    expect(rows).toEqual(["Garden", "Kitchen"])
    fireEvent.change(screen.getByLabelText("Find a board"), { target: { value: "kit" } })
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(["Kitchen"])
    fireEvent.change(screen.getByLabelText("Find a board"), { target: { value: "zzz" } })
    expect(screen.queryByRole("option")).toBeNull()
    expect(screen.getByText("No boards match")).toBeTruthy()
  })

  it("never offers the board being edited", () => {
    open(vi.fn(), "blk_kitchen000")
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(["Garden"])
  })

  it("Enter picks the highlighted board: one link, then the row is placed", () => {
    const { store, place } = open()
    const field = screen.getByLabelText("Find a board")
    fireEvent.keyDown(field, { key: "ArrowDown" })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(childIdsOf(store.get(graphSnapshotAtom), "n")).toEqual([
      "blk_one0000000",
      "blk_kitchen000",
      "blk_hall000000",
    ])
    expect(place).toHaveBeenCalledWith({
      id: "blk_kitchen000",
      type: "board",
      text: "Kitchen",
      children: [],
    })
    expect(store.get(linkBoardDialogAtom)).toBeNull()
  })

  it("a click picks too", () => {
    const { store, place } = open()
    fireEvent.click(screen.getByRole("option", { name: "Garden" }))
    expect(childIdsOf(store.get(graphSnapshotAtom), "n")).toContain("blk_garden0000")
    expect(place).toHaveBeenCalledTimes(1)
  })
})
