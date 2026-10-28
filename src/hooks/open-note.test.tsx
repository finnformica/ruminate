// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { Provider, createStore } from "jotai"
import React, { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse } from "../blocks/parse"
import { serialize } from "../blocks/serialize"
import type { BlockDoc } from "../blocks/types"
import { BlockEditor } from "../components/block-editor/block-editor"
import { FocusTrail } from "../components/focus-trail"
import { BOARD_TYPE, TRACKER_TYPE, buildGraphSnapshot, docToGraph } from "../data/graph"
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
import { useFocusBlock, useNotePageFocus, useOpenNote, useOpenView } from "./open-note"

/**
 * A focus on a board or a tracker block opens its own page (docs/boards.md,
 * docs/trackers.md), at every way in: the editor's keys, the phone's edit
 * bar, the trail's crumbs, the palette and a link. Every one calls the one
 * focus (`useFocusBlock`). Any other block is focused as before.
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

/** The pointer: fine (a mouse) unless a test makes it coarse (a phone). */
let coarse = false
beforeEach(() => {
  coarse = false
  window.matchMedia = ((query: string) =>
    ({
      matches: query === "(pointer: coarse)" && coarse,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia
})

afterEach(() => {
  cleanup()
  mocks.navigate.mockReset()
  mocks.matches = []
  delete (window as { matchMedia?: unknown }).matchMedia
})

const PLAIN = "blk_plain00000"
const BOARD = "blk_board00000"
const TRACKER = "blk_track00000"
const UNDER = "blk_under00000"
const VALUE = "blk_value00000"
const SERIES = "blk_serie00000"
const OUTLINE = [
  "- Plain",
  `  id:: ${PLAIN}`,
  "  - Under plain",
  `    id:: ${UNDER}`,
  "- Hall",
  `  id:: ${BOARD}`,
  "  - Colour",
  `    id:: ${VALUE}`,
  "- Runs",
  `  id:: ${TRACKER}`,
  "  - Distance",
  `    id:: ${SERIES}`,
].join("\n")

const KINDS: Record<string, typeof BOARD_TYPE | typeof TRACKER_TYPE> = {
  [BOARD]: BOARD_TYPE,
  [TRACKER]: TRACKER_TYPE,
}

/** Note `n` with a plain block, a board block (Hall, its own `board` node)
 * and a tracker block (Runs, its own `tracker` node), each with a block
 * under it. The editor's doc and the graph agree. */
function setup(views: ViewRow[] = []) {
  const doc: BlockDoc = parse(OUTLINE)
  for (const [id, type] of Object.entries(KINDS)) doc.blocks[id] = { ...doc.blocks[id], type }
  const g = docToGraph("n", serialize(parse(OUTLINE)), 1)
  const nodes = g.nodes.map((node) => (KINDS[node.id] ? { ...node, type: KINDS[node.id] } : node))
  const store = createStore()
  store.set(sampleGraphAtom, buildGraphSnapshot(nodes, g.links))
  store.set(viewsAtom, viewMapOf(views))
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  )
  return { doc, wrapper }
}

/** The two kinds with a page of their own: the block, its row's text, the
 * block under it, and the page. */
const KIND_PAGES = [
  { kind: "board", id: BOARD, text: "Hall", under: VALUE, to: "/boards/$" },
  { kind: "tracker", id: TRACKER, text: "Runs", under: SERIES, to: "/trackers/$" },
] as const

const toPage = (to: string, id: string, replace?: boolean) => ({
  to,
  params: { _splat: id },
  ...(replace ? { replace } : {}),
})

/** One pane, wired as the note page wires its editor and its trail: every
 * focus through the one focus (`useNotePageFocus`), the pane's own move
 * its outline step. */
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
  const focusBlock = useNotePageFocus(root, false)
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
      onFocusNavigate={(id, selected) =>
        focusBlock(id, () =>
          apply(goTo(pane, { noteId: "n", root: id }, selected ? pathOfKey(selected) : null)),
        )
      }
      focusTrail={
        <FocusTrail
          frames={pane.frames}
          onPopTo={(at) => apply(popTo(pane, at))}
          onGoVia={(at, target) => focusBlock(target.root, () => apply(goVia(pane, at, target)))}
          onGoAbove={(target) => focusBlock(target.root, () => apply(goAbove(pane, target)))}
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

describe("useFocusBlock", () => {
  for (const { kind, id, to } of KIND_PAGES) {
    it(`opens a ${kind} block on its own page, as a new history entry`, () => {
      const { wrapper } = setup()
      const outline = vi.fn()
      const { result } = renderHook(() => useFocusBlock(), { wrapper })
      result.current(id, outline)
      expect(mocks.navigate).toHaveBeenCalledWith(toPage(to, id))
      expect(outline).not.toHaveBeenCalled()
    })
  }

  it("leaves a plain block, and no block, to the outline", () => {
    const { wrapper } = setup()
    const outline = vi.fn()
    const { result } = renderHook(() => useFocusBlock(), { wrapper })
    result.current(PLAIN, outline)
    result.current(null, outline)
    expect(outline).toHaveBeenCalledTimes(2)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})

describe("a link to a block (Copy link, ?block=)", () => {
  for (const { kind, id, to } of KIND_PAGES) {
    it(`to a ${kind} block opens its page in the link's place`, () => {
      const { wrapper } = setup()
      renderHook(() => useNotePageFocus(id, false), { wrapper })
      expect(mocks.navigate).toHaveBeenCalledWith(toPage(to, id, true))
    })

    it(`to a ${kind} block in a split pane stays in the pane: its page has no panes`, () => {
      const { wrapper } = setup()
      renderHook(() => useNotePageFocus(id, true), { wrapper })
      expect(mocks.navigate).not.toHaveBeenCalled()
    })
  }

  it("to a plain block stays on the focused block", () => {
    const { wrapper } = setup()
    renderHook(() => useNotePageFocus(PLAIN, false), { wrapper })
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})

describe("a focus from the editor's keys (desktop)", () => {
  for (const [name, key, mods] of [
    ["f", "f", {}],
    ["⌘.", ".", { metaKey: true }],
  ] as const) {
    for (const { kind, id, text, to } of KIND_PAGES) {
      it(`${name} on a ${kind} block opens its page, and pushes no frame`, () => {
        const { select, press, stacks } = renderPane()
        select(text)
        press(key, mods)
        expect(mocks.navigate).toHaveBeenCalledWith(toPage(to, id))
        expect(stacks).toEqual([])
      })
    }

    it(`${name} on a plain block pushes a frame, as before`, () => {
      const { select, press, stacks } = renderPane()
      select("Plain")
      press(key, mods)
      expect(mocks.navigate).not.toHaveBeenCalled()
      expect(stacks.at(-1)!.frames.map((frame) => frame.root)).toEqual([null, PLAIN])
    })
  }
})

describe("a focus from the phone's edit bar", () => {
  /** Edit the row `text` on a touch screen, then tap Focus on block. */
  const focusFromBar = (text: string) => {
    coarse = true
    const pane = renderPane()
    fireEvent.click(pane.getByText(text))
    fireEvent.click(screen.getByLabelText("Focus on block"))
    return pane
  }

  for (const { kind, id, text, to } of KIND_PAGES) {
    it(`Focus on block on a ${kind} block opens its page, and pushes no frame`, () => {
      const { stacks } = focusFromBar(text)
      expect(mocks.navigate).toHaveBeenCalledWith(toPage(to, id))
      expect(stacks).toEqual([])
    })
  }

  it("Focus on block on a plain block pushes a frame, as before", () => {
    const { stacks } = focusFromBar("Plain")
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(stacks.at(-1)!.frames.map((frame) => frame.root)).toEqual([null, PLAIN])
  })
})

describe("a crumb on the trail", () => {
  /** The trail's crumb named `label`. */
  const crumb = (container: HTMLElement, label: string) =>
    Array.from(container.querySelectorAll<HTMLElement>("nav[aria-label='Focus path'] button")).find(
      (button) => button.textContent === label,
    )!

  for (const { kind, id, text, under, to } of KIND_PAGES) {
    it(`to a ${kind} block on the path opens its page`, () => {
      // In on the block under it: the trail reads Note › Hall › Colour.
      const { container, stacks } = renderPane(paneOf("n", under))
      fireEvent.click(crumb(container, text))
      expect(mocks.navigate).toHaveBeenCalledWith(toPage(to, id))
      expect(stacks).toEqual([])
    })
  }

  it("to a plain block on the path goes to it, as before", () => {
    // In on the plain block's own block: Note › Plain › Under plain.
    const { container, stacks } = renderPane(paneOf("n", UNDER))
    fireEvent.click(crumb(container, "Plain"))
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(stacks.at(-1)!.frames.map((frame) => frame.root)).toEqual([PLAIN])
  })
})

describe("the palette (useOpenNote: ↵, and f on a result)", () => {
  for (const { kind, id, to } of KIND_PAGES) {
    it(`opens a ${kind} block on its own page`, () => {
      const { wrapper } = setup()
      const { result } = renderHook(() => useOpenNote(), { wrapper })
      act(() => result.current("n", id))
      expect(mocks.navigate).toHaveBeenCalledWith(toPage(to, id))
    })

    it(`opens a ${kind} note on its own page`, () => {
      const { wrapper } = setup()
      const { result } = renderHook(() => useOpenNote(), { wrapper })
      act(() => result.current(id))
      expect(mocks.navigate).toHaveBeenCalledWith(toPage(to, id))
    })

    it(`opens a ${kind} View row on its own page, not its saved stack`, () => {
      const { wrapper } = setup([viewRow(id, "n")])
      const { result } = renderHook(() => useOpenView(), { wrapper })
      act(() => result.current("n", id))
      expect(mocks.navigate).toHaveBeenCalledWith(toPage(to, id))
    })
  }

  it("opens a plain block focused in its note, as before", () => {
    const { wrapper } = setup()
    const { result } = renderHook(() => useOpenNote(), { wrapper })
    act(() => result.current("n", PLAIN))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/views/$",
      params: { _splat: "n" },
      search: { query: undefined, block: PLAIN },
    })
  })
})

/** Every non-test source file under src/, by its path from src/, with its
 * text. */
const SOURCES = import.meta.glob(["/src/**/*.{ts,tsx}", "!/src/**/*.{test,stories}.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>
const files = Object.entries(SOURCES).map(([path, text]) => ({
  path: path.slice("/src/".length),
  text,
}))

describe("every focus entry point calls the one focus", () => {
  const file = (path: string) => files.find((f) => f.path === path)!.text
  const page = file("routes/_appRoot.views_.$.tsx")

  it("a kind is read in one place: kindPageOf", () => {
    const hook = file("hooks/open-note.ts")
    expect(hook.match(/isBoard\(/g)).toHaveLength(1)
    expect(hook.match(/isTracker\(/g)).toHaveLength(1)
    expect(hook.match(/kindPageOf\(/g)!.length).toBeGreaterThan(1)
    // The palette's ways in (↵, f on a result, a View row) open through it.
    expect(hook).toMatch(/export function useOpenNote[\s\S]*?focusBlock\(block \?\? noteId/)
    expect(hook).toMatch(/export function useOpenView[\s\S]*?kindPageOf\(graph, rootId\)/)
  })

  it("the note page's focus, crumbs and link go through it", () => {
    expect(page).toContain("useNotePageFocus(")
    expect(page).toMatch(/const focusTo = [^\n]*\n[^\n]*\n\s*focusBlock\(id, /)
    expect(page).toMatch(/onGoVia=\{\(at, target\) => focusBlock\(target\.root, /)
    expect(page).toMatch(/onGoAbove=\{\(target\) => focusBlock\(target\.root, /)
    expect(page).not.toMatch(/isBoard\(|isTracker\(/)
  })

  it("no other file hosts a focus: each host is one of the known ways in", () => {
    // A focus reaches a host through the editor's `onFocusNavigate` (F, ⌘.,
    // the block menu, the phone's edit bar) or the trail's crumbs. A new
    // host must call the one focus, then join this list.
    const hosts = files
      .filter((f) => /onFocusNavigate=\{|<FocusTrail\b/.test(f.text))
      .map((f) => f.path)
      .sort()
    expect(hosts).toEqual([
      // Passes the note page's `onFocusNavigate` through to the editor.
      "components/block-editor/block-note-editor.tsx",
      // A palette result: a focus is an open, through `useOpenNote`.
      "components/results-editor.tsx",
      "routes/_appRoot.views_.$.tsx",
    ])
    expect(file("components/command-menu.tsx")).toMatch(/useOpenNote\(\)/)
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
