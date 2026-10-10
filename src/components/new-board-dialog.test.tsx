// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import { buildGraphSnapshot, docToGraph } from "../data/graph"
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

describe("NewBoardDialog", () => {
  it("makes a listed board and opens it", () => {
    const store = createStore()
    const g = docToGraph("n", serialize(parse("- one\n")), 1)
    store.set(sampleGraphAtom, buildGraphSnapshot(g.nodes, g.links))
    store.set(newBoardDialogAtom, true)
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
    expect(store.get(newBoardDialogAtom)).toBe(false)
  })
})
