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
  layoutFromSearch,
  layoutToSearch,
  paneOf,
  pathOfKey,
  popTo,
  type FocusFrame,
  type FocusMove,
  type Pane,
  type PaneLayout,
} from "../data/panes"
import { isRootFrame, rootFrame } from "../data/root-frame"
import { viewMapOf, viewsAtom, type ViewRow } from "../data/views"
import { sampleGraphAtom } from "../global-state"
import { useBoardFocus, useOpenNote, useOpenView } from "./open-note"

/**
 * A focus on a board block opens the board (docs/boards.md), at every way
 * in: the editor's keys, the trail's crumbs, the palette and a link. Any
 * other block is focused as before.
 */

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), matches: [] as unknown[] }))
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
  // The page the router is on: none, or a note page (`splitPage`).
  useRouter: () => ({ state: { matches: mocks.matches } }),
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
  mocks.matches = []
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
function setup(views: ViewRow[] = []) {
  const doc: BlockDoc = parse(OUTLINE)
  doc.blocks[BOARD] = { ...doc.blocks[BOARD], type: BOARD_TYPE }
  const g = docToGraph("n", serialize(parse(OUTLINE)), 1)
  const nodes = g.nodes.map((node) => (node.id === BOARD ? { ...node, type: BOARD_TYPE } : node))
  const store = createStore()
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, g.links))
  store.set(viewsAtom, viewMapOf(views))
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

/** A View row rooted at `rootId`, with the stack it saves. */
const viewRow = (rootId: string, stack?: string): ViewRow => ({
  id: rootId,
  root_id: rootId,
  filter: null,
  sort: null,
  pinned: true,
  sort_key: null,
  updated_at: 1,
  ...(stack ? { stack } : {}),
})

const frame = (root: string | null): FocusFrame => ({ noteId: "n", root, selected: null })

/** The router on a note page with `layout` in its URL. */
function onPage(layout: PaneLayout) {
  const { noteId, search } = layoutToSearch(layout)
  mocks.matches = [{ routeId: "/_appRoot/views_/$", params: { _splat: noteId }, search }]
}

/** The layout the last navigation leads to, read back as the page reads it. */
function navigatedLayout(): PaneLayout {
  const { params, search } = mocks.navigate.mock.lastCall![0]
  return layoutFromSearch(params._splat, search)
}

/** Each frame of a pane, as "Root" or its root ("n" for the whole note). */
const stackOf = (pane: Pane) =>
  pane.frames.map((f) => (isRootFrame(f) ? "Root" : (f.root ?? f.noteId)))

/** Two panes, the keyboard in the second: Root › n › Plain beside Root › Under. */
const SPLIT: PaneLayout = {
  panes: [
    { frames: [rootFrame(), frame(UNDER)] },
    { frames: [rootFrame(), frame(null), frame(PLAIN)] },
  ],
  active: 1,
}

describe("a palette pick restarts the stack", () => {
  it("a note, in one pane: Root › the note, the old frames gone", () => {
    const { wrapper } = setup()
    onPage({ panes: [{ frames: [rootFrame(), frame(null), frame(PLAIN)] }], active: 0 })
    const { result } = renderHook(() => useOpenNote(), { wrapper })
    void result.current("n")
    expect(stackOf(navigatedLayout().panes[0])).toEqual(["Root", "n"])
  })

  it("a block, in one pane: Root › the block", () => {
    const { wrapper } = setup()
    onPage({ panes: [{ frames: [rootFrame(), frame(null), frame(PLAIN)] }], active: 0 })
    const { result } = renderHook(() => useOpenNote(), { wrapper })
    void result.current("n", UNDER)
    expect(stackOf(navigatedLayout().panes[0])).toEqual(["Root", UNDER])
  })

  it("a note, in a split: the active pane restarts, the other pane is left as it is", () => {
    const { wrapper } = setup()
    onPage(SPLIT)
    const { result } = renderHook(() => useOpenNote(), { wrapper })
    void result.current("n")
    const layout = navigatedLayout()
    expect(layout.panes.map(stackOf)).toEqual([
      ["Root", UNDER],
      ["Root", "n"],
    ])
    expect(layout.active).toBe(1)
  })

  it("a block, in a split: the active pane restarts on the block", () => {
    const { wrapper } = setup()
    onPage(SPLIT)
    const { result } = renderHook(() => useOpenNote(), { wrapper })
    void result.current("n", UNDER)
    expect(navigatedLayout().panes.map(stackOf)).toEqual([
      ["Root", UNDER],
      ["Root", UNDER],
    ])
  })

  it("the view on screen, in a split: the stack beneath it goes too", () => {
    const { wrapper } = setup()
    onPage(SPLIT)
    const { result } = renderHook(() => useOpenNote(), { wrapper })
    void result.current("n", PLAIN)
    expect(stackOf(navigatedLayout().panes[1])).toEqual(["Root", PLAIN])
  })

  it("a View, in one pane: its saved stack, in place of the old frames", () => {
    // The View "Under plain" saves the whole note beneath it.
    const { wrapper } = setup([viewRow(UNDER, "n")])
    onPage({ panes: [{ frames: [rootFrame(), frame(PLAIN)] }], active: 0 })
    const { result } = renderHook(() => useOpenView(), { wrapper })
    void result.current("n", UNDER)
    expect(stackOf(navigatedLayout().panes[0])).toEqual(["Root", "n", UNDER])
  })

  it("a View, in a split: its saved stack in the active pane, the other pane as it is", () => {
    const { wrapper } = setup([viewRow(UNDER, "n")])
    onPage(SPLIT)
    const { result } = renderHook(() => useOpenView(), { wrapper })
    void result.current("n", UNDER)
    expect(navigatedLayout().panes.map(stackOf)).toEqual([
      ["Root", UNDER],
      ["Root", "n", UNDER],
    ])
  })

  it("a View with no saved stack opens as a note does: Root › its root", () => {
    const { wrapper } = setup([viewRow(PLAIN)])
    onPage({ panes: [{ frames: [rootFrame(), frame(null), frame(UNDER)] }], active: 0 })
    const { result } = renderHook(() => useOpenView(), { wrapper })
    void result.current("n", PLAIN)
    expect(stackOf(navigatedLayout().panes[0])).toEqual(["Root", PLAIN])
  })
})
