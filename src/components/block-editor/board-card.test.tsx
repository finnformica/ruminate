// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../../blocks/parse"
import { serialize } from "../../blocks/serialize"
import type { BlockDoc } from "../../blocks/types"
import { BOARD_TYPE, buildGraphSnapshot, docToGraph, type GraphSnapshot } from "../../data/graph"
import { applyOps } from "../../data/ops"
import { sampleGraphAtom } from "../../global-state"
import { BlockEditor } from "./block-editor"
import { boardCardLine } from "./board-card"

Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup)

const NOW = 1000
const feature = (spec: Record<string, unknown>) => JSON.stringify({ feature: spec })

/** A board `b` with two pictures and the features its line names. */
function boardOf(features: string[], pictures = 2): GraphSnapshot {
  const lines = features.map(
    (label, i) => `- ${label}\n  id:: blk_feature${String(i).padStart(3, "0")}`,
  )
  for (let i = 0; i < pictures; i += 1) {
    lines.push(
      `![](/api/images/img_${String(i).padStart(12, "0")})\n  id:: blk_pic${String(i).padStart(7, "0")}`,
    )
  }
  const g = docToGraph("b", serialize(parse(lines.join("\n") + "\n")), 1)
  const snapshot = buildGraphSnapshot(
    g.nodes.map((n) => (n.id === "b" ? { ...n, text: "Kitchen", type: BOARD_TYPE } : n)),
    g.links,
  )
  return applyOps(
    snapshot,
    features.map((_label, i) => ({
      op: "setProps" as const,
      id: `blk_feature${String(i).padStart(3, "0")}`,
      props: feature({ type: "text", multi: true }),
    })),
    NOW,
  )
}

describe("boardCardLine", () => {
  it("counts the pictures and names the features", () => {
    expect(boardCardLine(boardOf(["Location", "Object", "Material"]), "b")).toBe(
      "2 pictures · Location, Object, Material",
    )
    expect(boardCardLine(boardOf(["Location"], 1), "b")).toBe("1 picture · Location")
    expect(boardCardLine(boardOf([], 0), "b")).toBe("No pictures yet")
    expect(boardCardLine(boardOf(["Location"], 0), "b")).toBe("No pictures yet · Location")
  })

  it("names four features and counts the rest", () => {
    const six = boardOf(["One", "Two", "Three", "Four", "Five", "Six"], 0)
    expect(boardCardLine(six, "b")).toBe("No pictures yet · One, Two, Three, Four and 2 more")
  })

  it("says nothing of a board the graph lacks", () => {
    expect(boardCardLine(boardOf([]), "nope")).toBe("No pictures yet")
  })
})

describe("BoardCard", () => {
  const doc: BlockDoc = {
    props: null,
    rootBlockIds: ["b"],
    blocks: { b: { id: "b", type: "board", text: "Kitchen", children: ["blk_feature000"] } },
  }

  it("draws the board's icon, name and what it holds, live off the graph, with Open board", () => {
    const store = createStore()
    store.set(sampleGraphAtom, boardOf(["Location", "Object"]))
    const onOpenBoard = vi.fn()
    const { getByTestId, getByLabelText, container } = render(
      <Provider store={store}>
        <BlockEditor doc={doc} onChange={() => {}} noteId="n" onOpenBoard={onOpenBoard} />
      </Provider>,
    )
    const card = getByTestId("board-card")
    expect(card.querySelector('[data-testid="block-body"]')?.textContent).toBe("Kitchen")
    expect(getByTestId("board-card-line").textContent).toBe("2 pictures · Location, Object")
    // The card is the row's figure: a frame with the layout controls.
    expect(getByTestId("board-figure")).not.toBeNull()
    expect(getByTestId("board-toolbar")).not.toBeNull()
    fireEvent.click(getByLabelText("Open board"))
    expect(onOpenBoard).toHaveBeenCalledWith("b")
    // The board's icon is the row's key, in the key slot before the card,
    // as every row's key is — not a second one inside the card.
    expect(container.querySelector('[data-testid="note-favicon-slot"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="note-favicon-slot"] [data-testid="favicon-board"]'),
    ).not.toBeNull()
    expect(card.querySelector('[data-testid="favicon-board"]')).toBeNull()
  })

  it("is a note row with the board's favicon when listed", () => {
    const { container, queryByTestId } = render(
      <BlockEditor doc={doc} onChange={() => {}} readOnly fixedRoots />,
    )
    expect(queryByTestId("board-card")).toBeNull()
    expect(container.querySelector('[data-testid="note-favicon-slot"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="favicon-board"]')).not.toBeNull()
  })
})
