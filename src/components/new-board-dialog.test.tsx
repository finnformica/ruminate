// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { boardFeatures, DEFAULT_FEATURES } from "../data/boards"
import { buildGraphSnapshot, childIdsOf, docToGraph } from "../data/graph"
import { viewsAtom } from "../data/views"
import { graphSnapshotAtom, sampleGraphAtom } from "../global-state"
import { NewBoardDialog, newBoardDialogAtom } from "./new-board-dialog"

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }))

Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup()
  mocks.navigate.mockReset()
})

const noteOf = () => {
  const g = docToGraph("n", serialize(parse("- one\n  id:: blk_one0000000\n")), 1)
  return buildGraphSnapshot(g.nodes, g.links)
}

describe("NewBoardDialog", () => {
  it("from the header, makes a listed board and opens it", () => {
    const store = createStore()
    store.set(sampleGraphAtom, noteOf())
    store.set(newBoardDialogAtom, {})
    render(
      <Provider store={store}>
        <NewBoardDialog />
      </Provider>,
    )
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kitchen" } })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    const snapshot = store.get(graphSnapshotAtom)
    const board = [...snapshot.nodes.values()].find((node) => node.type === "board")
    expect(board?.text).toBe("Kitchen")
    expect(store.get(viewsAtom).get(board!.id)?.pinned).toBe(true)
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/boards/$", params: { _splat: board!.id } })
  })

  it("from a note, makes the board where the row is in one batch, unlisted, and places its row", () => {
    const store = createStore()
    store.set(sampleGraphAtom, noteOf())
    const place = vi.fn()
    store.set(newBoardDialogAtom, {
      into: { parentId: "n", placement: { replace: "blk_one0000000" }, place },
    })
    render(
      <Provider store={store}>
        <NewBoardDialog />
      </Provider>,
    )
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Kitchen" } })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    const snapshot = store.get(graphSnapshotAtom)
    const board = [...snapshot.nodes.values()].find((node) => node.type === "board")!
    // The board sits where the blank row was, with its default features,
    // and has no view row: it is not listed (docs/metadata.md, "Views").
    expect(childIdsOf(snapshot, "n")).toEqual([board.id])
    expect(snapshot.nodes.has("blk_one0000000")).toBe(false)
    expect(boardFeatures(snapshot, board.id).map((s) => s.feature.label)).toEqual(
      DEFAULT_FEATURES.map((entry) => entry.label),
    )
    expect(store.get(viewsAtom).get(board.id)).toBeUndefined()
    expect(place).toHaveBeenCalledWith(
      expect.objectContaining({
        id: board.id,
        type: "board",
        text: "Kitchen",
        children: childIdsOf(snapshot, board.id),
      }),
    )
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(store.get(newBoardDialogAtom)).toBeNull()
  })
})
