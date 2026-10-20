import { describe, expect, it } from "vitest"
import {
  activate,
  closePane,
  currentFrame,
  formatFrame,
  goTo,
  layoutFromSearch,
  layoutToSearch,
  nextPaneIndex,
  openBeside,
  paneOf,
  parseFrame,
  popFrame,
  popTo,
  type Pane,
  type PaneLayout,
} from "./panes"

/**
 * The panes and their focus stacks (docs/split-view.md): a push records the
 * row selected where the reader was, a pop hands it back, and the whole
 * layout survives a trip through the URL.
 */

const A = "blk_notea"
const B = "blk_noteb"

/** Push `root` from the pane's current view, with `selected` selected there. */
const push = (pane: Pane, root: string | null, selected: string | null, noteId = A) =>
  goTo(pane, { noteId, root }, selected)!.pane

describe("the focus stack", () => {
  it("pushes a frame on a focus, recording the row selected beneath it", () => {
    const pane = push(paneOf(A), "blk_b1", "blk_x/blk_b1")
    expect(pane.frames).toEqual([
      { noteId: A, root: null, selected: "blk_x/blk_b1" },
      { noteId: A, root: "blk_b1", selected: null },
    ])
    expect(currentFrame(pane).root).toBe("blk_b1")
  })

  it("pops back to the frame beneath, landing on the row that was selected there", () => {
    const deep = push(push(paneOf(A), "blk_b1", "blk_x/blk_b1"), "blk_b2", "blk_b1/blk_b2")
    const once = popFrame(deep)!
    expect(currentFrame(once.pane).root).toBe("blk_b1")
    expect(once.landing).toBe("blk_b1/blk_b2")
    // A frame restored keeps its folds: nothing is revealed on the way back.
    expect(once.restored).toBe(true)
    const twice = popFrame(once.pane)!
    expect(twice.pane).toEqual(paneOf(A))
    expect(twice.landing).toBe("blk_x/blk_b1")
  })

  it("restores a selection that is not the block focused on", () => {
    // The focus dot clicked on one row while another is highlighted.
    const pane = push(paneOf(A), "blk_b1", "blk_other")
    expect(popFrame(pane)!.landing).toBe("blk_other")
  })

  it("leaves a lone focus for the whole note, revealing the block left", () => {
    const move = popFrame(paneOf(A, "blk_b1"))!
    expect(move.pane).toEqual(paneOf(A))
    expect(move.landing).toBeNull()
    expect(move.restored).toBe(false)
    expect(popFrame(paneOf(A))).toBeNull()
  })

  it("pops back to a view already on the stack rather than pushing it twice", () => {
    const deep = push(push(paneOf(A), "blk_b1", "k1"), "blk_b2", "k2")
    // ⌘⇧. (the whole note) and the note's crumb are the bottom frame.
    const out = goTo(deep, { noteId: A, root: null }, "k3")!
    expect(out.pane).toEqual(paneOf(A))
    expect(out.landing).toBe("k1")
    expect(out.restored).toBe(true)
    // The view on screen is no move at all.
    expect(goTo(deep, { noteId: A, root: "blk_b2" }, "k3")).toBeNull()
  })

  it("pops to any frame by index (a crumb), and refuses the frame on screen", () => {
    const deep = push(push(paneOf(A), "blk_b1", "k1"), "blk_b2", "k2")
    const move = popTo(deep, 1)!
    expect(currentFrame(move.pane).root).toBe("blk_b1")
    expect(move.landing).toBe("k2")
    expect(popTo(deep, 2)).toBeNull()
    expect(popTo(deep, -1)).toBeNull()
  })

  it("spans notes: a frame keeps the note it was in", () => {
    const pane = push(paneOf(A, "blk_b1"), "blk_c1", "k1", B)
    expect(currentFrame(pane)).toEqual({ noteId: B, root: "blk_c1", selected: null })
    const back = popFrame(pane)!
    expect(currentFrame(back.pane)).toEqual({ noteId: A, root: "blk_b1", selected: null })
    expect(back.landing).toBe("k1")
  })
})

describe("the layout", () => {
  const one: PaneLayout = { panes: [paneOf(A)], active: 0 }

  it("opens a block beside: a second pane, which takes the keyboard", () => {
    const { layout } = openBeside(one, 0, { noteId: A, root: "blk_b1" })
    expect(layout.panes).toEqual([paneOf(A), paneOf(A, "blk_b1")])
    expect(layout.active).toBe(1)
  })

  it("with both panes open, pushes onto the other pane's stack", () => {
    const two = openBeside(one, 0, { noteId: B, root: null }).layout
    const { layout } = openBeside(two, 0, { noteId: A, root: "blk_b1" })
    expect(layout.panes[0]).toEqual(paneOf(A))
    expect(layout.panes[1].frames.map((f) => f.root)).toEqual([null, "blk_b1"])
    expect(layout.active).toBe(1)
    // From the second pane, beside is the first.
    expect(openBeside(layout, 1, { noteId: B, root: "blk_z" }).layout.active).toBe(0)
  })

  it("keeps each pane's state apart", () => {
    const two = openBeside(one, 0, { noteId: A, root: null }).layout
    const moved = push(two.panes[1], "blk_b1", "k1")
    const layout = { ...two, panes: [two.panes[0], moved] }
    expect(layout.panes[0]).toEqual(paneOf(A))
    expect(currentFrame(layout.panes[1]).root).toBe("blk_b1")
  })

  it("moves the keyboard between panes", () => {
    const two = openBeside(one, 0, { noteId: B, root: null }).layout
    expect(nextPaneIndex(two)).toBe(0)
    expect(activate(two, 0).active).toBe(0)
    expect(activate(two, 5)).toBe(two)
  })

  it("closes a pane, and never the last one", () => {
    const two = openBeside(one, 0, { noteId: B, root: null }).layout
    expect(closePane(two, 1)).toEqual({ panes: [paneOf(A)], active: 0 })
    expect(closePane(two, 0)).toEqual({ panes: [paneOf(B)], active: 0 })
    expect(closePane(activate(two, 0), 1).active).toBe(0)
    expect(closePane(one, 0)).toBe(one)
  })
})

describe("the URL", () => {
  it("reads an old ?block= link as one pane focused on the block", () => {
    expect(layoutFromSearch(A, { block: "blk_b1" })).toEqual({
      panes: [paneOf(A, "blk_b1")],
      active: 0,
    })
    expect(layoutFromSearch(A, {})).toEqual({ panes: [paneOf(A)], active: 0 })
  })

  it("writes one unfocused pane as the bare address", () => {
    expect(layoutToSearch({ panes: [paneOf(A)], active: 0 })).toEqual({
      noteId: A,
      search: { block: undefined, stack: undefined, pane1: undefined, active: undefined },
    })
  })

  it("round-trips two panes, their stacks and the active pane", () => {
    const first = push(push(paneOf(A), "blk_b1", "blk_x/blk_b1"), "blk_b2", "blk_b1/^blk_p")
    const second = push(paneOf(B), "blk_c1", null, B)
    const layout: PaneLayout = { panes: [first, second], active: 1 }
    const { noteId, search } = layoutToSearch(layout)
    expect(noteId).toBe(A)
    expect(search).toEqual({
      block: "blk_b2",
      stack: `${A}::blk_x/blk_b1,${A}:blk_b1:blk_b1/^blk_p`,
      pane1: `${B},${B}:blk_c1`,
      active: 1,
    })
    expect(layoutFromSearch(noteId, search as Record<string, unknown>)).toEqual(layout)
  })

  it("drops malformed frames and a stray active index", () => {
    const layout = layoutFromSearch(A, {
      stack: `:x,${A}:blk_b1,a:b:c:d`,
      pane1: "",
      active: 3,
    })
    expect(layout).toEqual({
      panes: [{ frames: [{ noteId: A, root: "blk_b1", selected: null }, ...paneOf(A).frames] }],
      active: 0,
    })
  })

  it("formats and parses a frame", () => {
    for (const frame of [
      { noteId: A, root: null, selected: null },
      { noteId: A, root: "blk_b1", selected: null },
      { noteId: A, root: null, selected: "blk_b1/blk_b2" },
      { noteId: "2024-01-02", root: "blk_b1", selected: "blk_b1" },
    ]) {
      expect(parseFrame(formatFrame(frame))).toEqual(frame)
    }
  })
})
