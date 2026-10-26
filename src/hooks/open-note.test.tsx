// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import React, { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import type { BlockDoc } from "../blocks/types"
import { BlockEditor } from "../components/block-editor/block-editor"
import { FocusTrail } from "../components/focus-trail"
import { BOARD_TYPE, buildGraphSnapshot, docToGraph } from "../data/graph"
import {
  currentFrame,
  goAbove,
  goTo,
  goVia,
  paneOf,
  pathOfKey,
  popTo,
  type FocusMove,
  type Pane,
} from "../data/panes"
import { sampleGraphAtom } from "../global-state"
import { useBoardFocus, useOpenNote } from "./open-note"

/**
 * A focus on a board block opens the board (docs/boards.md), at every way
 * in: the editor's keys, the trail's crumbs, the palette and a link. Any
 * other block is focused as before.
 */

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ state: { matches: [] } }),
}))

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

const PLAIN = "blk_plain00000"
const BOARD = "blk_board00000"
const UNDER = "blk_under00000"
const VALUE = "blk_value00000"
const OUTLINE = [
  "- Plain",
  `  id:: ${PLAIN}`,
  "  - Under plain",
  `    id:: ${UNDER}`,
  "- Hall",
  `  id:: ${BOARD}`,
  "  - Colour",
  `    id:: ${VALUE}`,
].join("\n")

/** Note `n` with a plain block and a board block (Hall, its own `board`
 * node, with a block under it). The editor's doc and the graph agree. */
function setup() {
  const doc: BlockDoc = parse(OUTLINE)
  doc.blocks[BOARD] = { ...doc.blocks[BOARD], type: BOARD_TYPE }
  const g = docToGraph("n", serialize(parse(OUTLINE)), 1)
  const nodes = g.nodes.map((node) => (node.id === BOARD ? { ...node, type: BOARD_TYPE } : node))
  const store = createStore()
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, g.links))
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  return { doc, wrapper }
}

const toBoard = (id: string, replace?: boolean) => ({
  to: "/boards/$",
  params: { _splat: id },
  ...(replace ? { replace } : {}),
})

/** One pane, wired as the note page wires its editor and its trail: a
 * board first (`useBoardFocus`), else the pane's own move. */
function PaneHost({
  doc,
  start,
  onStack,
}: {
  doc: BlockDoc
  start: Pane
  onStack: (pane: Pane) => void
}) {
  const [pane, setPane] = useState(start)
  const root = currentFrame(pane).root
  const opensBoard = useBoardFocus(root, false)
  const apply = (move: FocusMove | null) => {
    if (!move) return
    setPane(move.pane)
    onStack(move.pane)
  }
  return (
    <BlockEditor
      doc={doc}
      onChange={() => {}}
      noteId="n"
      focusRootId={root}
      onFocusNavigate={(id, selected) => {
        if (opensBoard(id)) return
        apply(goTo(pane, { noteId: "n", root: id }, selected ? pathOfKey(selected) : null))
      }}
      focusTrail={
        <FocusTrail
          frames={pane.frames}
          onPopTo={(at) => apply(popTo(pane, at))}
          onGoVia={(at, target) => {
            if (!opensBoard(target.root)) apply(goVia(pane, at, target))
          }}
          onGoAbove={(target) => {
            if (!opensBoard(target.root)) apply(goAbove(pane, target))
          }}
        />
      }
    />
  )
}

function renderPane(start: Pane = paneOf("n")) {
  const { doc, wrapper } = setup()
  const stacks: Pane[] = []
  const view = render(<PaneHost doc={doc} start={start} onStack={(p) => stacks.push(p)} />, {
    wrapper,
  })
  const editor = view.container.querySelector<HTMLElement>("[data-block-editor]")!
  const select = (text: string) => fireEvent.click(view.getByText(text))
  const press = (key: string, mods: { metaKey?: boolean } = {}) =>
    fireEvent.keyDown(editor, { key, ...mods })
  return { ...view, stacks, select, press }
}

describe("useBoardFocus", () => {
  it("opens a board block on its board page, as a new history entry", () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useBoardFocus(null, false), { wrapper })
    expect(result.current(BOARD)).toBe(true)
    expect(mocks.navigate).toHaveBeenCalledWith(toBoard(BOARD))
  })

  it("leaves a plain block, and no block, to the pane", () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useBoardFocus(null, false), { wrapper })
    expect(result.current(PLAIN)).toBe(false)
    expect(result.current(null)).toBe(false)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})

describe("a link to a block (Copy link, ?block=)", () => {
  it("to a board block opens the board in the link's place", () => {
    const { wrapper } = setup()
    renderHook(() => useBoardFocus(BOARD, false), { wrapper })
    expect(mocks.navigate).toHaveBeenCalledWith(toBoard(BOARD, true))
  })

  it("to a plain block stays on the focused block", () => {
    const { wrapper } = setup()
    renderHook(() => useBoardFocus(PLAIN, false), { wrapper })
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it("in a split pane stays in the pane: the board page has no panes", () => {
    const { wrapper } = setup()
    renderHook(() => useBoardFocus(BOARD, true), { wrapper })
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})

describe("a focus from the editor's keys", () => {
  for (const [name, key, mods] of [
    ["f", "f", {}],
    ["⌘.", ".", { metaKey: true }],
  ] as const) {
    it(`${name} on a board block opens the board, and pushes no frame`, () => {
      const { select, press, stacks } = renderPane()
      select("Hall")
      press(key, mods)
      expect(mocks.navigate).toHaveBeenCalledWith(toBoard(BOARD))
      expect(stacks).toEqual([])
    })

    it(`${name} on a plain block pushes a frame, as before`, () => {
      const { select, press, stacks } = renderPane()
      select("Plain")
      press(key, mods)
      expect(mocks.navigate).not.toHaveBeenCalled()
      expect(stacks.at(-1)!.frames.map((frame) => frame.root)).toEqual([null, PLAIN])
    })
  }
})

describe("a crumb on the trail", () => {
  /** The trail's crumb named `label`. */
  const crumb = (container: HTMLElement, label: string) =>
    Array.from(container.querySelectorAll<HTMLElement>("nav[aria-label='Focus path'] button")).find(
      (button) => button.textContent === label,
    )!

  it("to a board block on the path opens the board", () => {
    // In on the board's own block: the trail reads Note › Hall › Colour.
    const { container, stacks } = renderPane(paneOf("n", VALUE))
    fireEvent.click(crumb(container, "Hall"))
    expect(mocks.navigate).toHaveBeenCalledWith(toBoard(BOARD))
    expect(stacks).toEqual([])
  })

  it("to a plain block on the path goes to it, as before", () => {
    // In on the plain block's own block: Note › Plain › Under plain.
    const { container, stacks } = renderPane(paneOf("n", UNDER))
    fireEvent.click(crumb(container, "Plain"))
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(stacks.at(-1)!.frames.map((frame) => frame.root)).toEqual([PLAIN])
  })
})

describe("the palette (useOpenNote)", () => {
  it("opens a board block on its board page", () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useOpenNote(), { wrapper })
    void result.current("n", BOARD)
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/boards/$", params: { _splat: BOARD } })
  })

  it("opens a plain block focused in its note, as before", () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useOpenNote(), { wrapper })
    void result.current("n", PLAIN)
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/views/$",
      params: { _splat: "n" },
      search: { query: undefined, block: PLAIN },
    })
  })
})
