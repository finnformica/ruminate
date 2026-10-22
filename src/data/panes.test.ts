import { describe, expect, it } from "vitest"
import {
  activate,
  closePane,
  currentFrame,
  formatFrame,
  goTo,
  goVia,
  layoutFromSearch,
  layoutToSearch,
  nextPaneIndex,
  withCurrent,
  openBeside,
  paneOf,
  linkPivotsOf,
  parseFrame,
  pivotRoot,
  popFrame,
  popTo,
  withPivot,
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

/** A selection path, written as a key for short (`blk_a/blk_b`). */
const P = (key: string) => key.split("/")

/** Push `root` from the pane's current view, with `selected` selected there. */
const push = (pane: Pane, root: string | null, selected: string | null, noteId = A) =>
  goTo(pane, { noteId, root }, selected === null ? null : P(selected))!.pane

describe("the focus stack", () => {
  it("pushes a frame on a focus, recording the row selected beneath it", () => {
    const pane = push(paneOf(A), "blk_b1", "blk_x/blk_b1")
    expect(pane.frames).toEqual([
      { noteId: A, root: null, selected: P("blk_x/blk_b1") },
      { noteId: A, root: "blk_b1", selected: null },
    ])
    expect(currentFrame(pane).root).toBe("blk_b1")
  })

  it("pops back to the frame beneath, landing on the row that was selected there", () => {
    const deep = push(push(paneOf(A), "blk_b1", "blk_x/blk_b1"), "blk_b2", "blk_b1/blk_b2")
    const once = popFrame(deep)!
    expect(currentFrame(once.pane).root).toBe("blk_b1")
    expect(once.landing).toEqual(P("blk_b1/blk_b2"))
    // A frame restored keeps its folds: nothing is revealed on the way back.
    expect(once.restored).toBe(true)
    const twice = popFrame(once.pane)!
    expect(twice.pane).toEqual(paneOf(A))
    expect(twice.landing).toEqual(P("blk_x/blk_b1"))
  })

  it("restores a selection that is not the block focused on", () => {
    // The focus dot clicked on one row while another is highlighted.
    const pane = push(paneOf(A), "blk_b1", "blk_other")
    expect(popFrame(pane)!.landing).toEqual(P("blk_other"))
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
    const out = goTo(deep, { noteId: A, root: null }, P("k3"))!
    expect(out.pane).toEqual(paneOf(A))
    expect(out.landing).toEqual(P("k1"))
    expect(out.restored).toBe(true)
    // The view on screen is no move at all.
    expect(goTo(deep, { noteId: A, root: "blk_b2" }, P("k3"))).toBeNull()
  })

  it("pops to any frame by index (a crumb), and refuses the frame on screen", () => {
    const deep = push(push(paneOf(A), "blk_b1", "k1"), "blk_b2", "k2")
    const move = popTo(deep, 1)!
    expect(currentFrame(move.pane).root).toBe("blk_b1")
    expect(move.landing).toEqual(P("k2"))
    expect(popTo(deep, 2)).toBeNull()
    expect(popTo(deep, -1)).toBeNull()
  })

  it("goes by way of a frame: pops to it, then pushes the view from it", () => {
    const deep = push(push(paneOf(A), "blk_b2", "k1"), "blk_b3", "k2")
    // A crumb on the path between the note and b2: the note keeps k1.
    const move = goVia(deep, 0, { noteId: A, root: "blk_b1" })!
    expect(move.pane.frames).toEqual([
      { noteId: A, root: null, selected: P("k1") },
      { noteId: A, root: "blk_b1", selected: null },
    ])
    expect(move.restored).toBe(false)
    // On the frame on screen it is a plain push.
    expect(goVia(deep, 2, { noteId: A, root: "blk_x" })!.pane.frames).toHaveLength(4)
    expect(goVia(deep, 5, { noteId: A, root: "blk_x" })).toBeNull()
  })

  it("spans notes: a frame keeps the note it was in", () => {
    const pane = push(paneOf(A, "blk_b1"), "blk_c1", "k1", B)
    expect(currentFrame(pane)).toEqual({ noteId: B, root: "blk_c1", selected: null })
    const back = popFrame(pane)!
    expect(currentFrame(back.pane)).toEqual({ noteId: A, root: "blk_b1", selected: null })
    expect(back.landing).toEqual(P("k1"))
  })
})

describe("a frame's state (Finn's decisions, docs/split-view.md)", () => {
  const narrowed = withCurrent(paneOf(A), {
    filter: "type:todo",
    sort: "text",
  })

  it("starts a pushed frame from the defaults: no filter, sort or folds", () => {
    const pane = withCurrent(push(narrowed, "blk_b1", "blk_b1"), {})
    expect(currentFrame(pane)).toEqual({ noteId: A, root: "blk_b1", selected: null })
  })

  it("restores a popped frame's filter, sort and folds", () => {
    const folded = withCurrent(push(narrowed, "blk_b1", "blk_b1"), {
      folds: { open: [], closed: ["blk_b1/blk_c1"] },
    })
    const deeper = push(folded, "blk_c2", "blk_b1/blk_c2")
    const back = popFrame(deeper)!
    expect(currentFrame(back.pane).folds).toEqual({ open: [], closed: ["blk_b1/blk_c1"] })
    const bottom = popFrame(back.pane)!
    expect(currentFrame(bottom.pane)).toMatchObject({ filter: "type:todo", sort: "text" })
  })

  it("names a selection by the path of ids from the frame's root", () => {
    // Written from the root and without `blk_`, read back as the whole path:
    // the same ids the editor's occurrence key joins with `/`.
    const pane = push(push(paneOf(A), "blk_b1", "blk_x/blk_b1"), "blk_b2", "blk_b1/blk_y/blk_b2")
    const { noteId, search } = layoutToSearch({ panes: [pane], active: 0 })
    expect(search.stack).toBe(`${A}::x/b1,${A}:blk_b1:y/b2`)
    const back = layoutFromSearch(noteId, search as Record<string, unknown>)
    expect(back.panes[0].frames.map((f) => f.selected)).toEqual([
      ["blk_x", "blk_b1"],
      ["blk_b1", "blk_y", "blk_b2"],
      null,
    ])
  })

  it("writes a frame's narrowing and folds into the URL, and reads them back", () => {
    const first = withCurrent(push(narrowed, "blk_b1", "blk_b1"), {
      filter: "has:link, text:a;b",
      folds: { open: ["blk_b1/blk_c1"], closed: ["blk_b1/^blk_up", "blk_b1"] },
    })
    const second = withCurrent(push(paneOf(B), "2024-01-02", null, B), {
      folds: { open: [], closed: ["2024-01-02/blk_d"] },
    })
    const layout: PaneLayout = { panes: [first, second], active: 0 }
    const { noteId, search } = layoutToSearch(layout)
    expect(search.folds).toBe("+c1.-^up.-@")
    expect(search.filter).toBe("has:link, text:a;b")
    expect(search.stack).toBe(`${A}::b1;f=type%3Atodo;s=text`)
    expect(search.pane1).toBe(`${B},${B}:2024-01-02;z=-d`)
    expect(layoutFromSearch(noteId, search as Record<string, unknown>)).toEqual(layout)
  })

  it("is plain data, so a View can store a whole stack", () => {
    const pane = withCurrent(push(push(narrowed, "blk_b1", "blk_b1"), "blk_b2", "blk_b1/blk_b2"), {
      folds: { open: ["blk_b2/blk_c"], closed: [] },
    })
    expect(JSON.parse(JSON.stringify(pane))).toEqual(pane)
  })

  it("keeps the bottom frame's folds off the URL: they are the note's own", () => {
    const layout = layoutFromSearch(A, { folds: "-x" })
    expect(currentFrame(layout.panes[0]).folds).toBeUndefined()
  })
})

describe("a frame's pivots (docs/graph-walk.md, 3.4)", () => {
  const pivoted = withCurrent(paneOf(A), { pivots: { blk_x: "up", "2024-01-02": "down" } })

  it("round-trips the pivots of every frame, without `blk_`", () => {
    const pane = withCurrent(push(pivoted, "blk_b1", "blk_b1"), { pivots: { blk_b1: "up" } })
    const layout: PaneLayout = { panes: [pane, pivoted], active: 0 }
    const { noteId, search } = layoutToSearch(layout)
    expect(search.pivots).toBe("^b1")
    expect(search.stack).toBe(`${A}::b1;p=^x.v~2024-01-02`)
    expect(search.pane1).toBe(`${A};p=^x.v~2024-01-02`)
    expect(layoutFromSearch(noteId, search as Record<string, unknown>)).toEqual(layout)
  })

  it("drops a malformed pivot and keeps the rest", () => {
    const layout = layoutFromSearch(A, { pivots: "^x.?y.v.^" })
    expect(currentFrame(layout.panes[0]).pivots).toEqual({ blk_x: "up" })
    expect(currentFrame(layoutFromSearch(A, { pivots: "?" }).panes[0]).pivots).toBeUndefined()
  })

  it("starts a pushed frame with none, and a pop restores them", () => {
    const pushed = push(pivoted, "blk_b1", "blk_b1")
    expect(currentFrame(pushed).pivots).toBeUndefined()
    expect(currentFrame(popFrame(pushed)!.pane).pivots).toEqual(currentFrame(pivoted).pivots)
  })

  it("keeps each pane's pivots apart", () => {
    const two = openBeside({ panes: [pivoted], active: 0 }, 0, { noteId: A, root: null }).layout
    expect(currentFrame(two.panes[1]).pivots).toBeUndefined()
    expect(currentFrame(two.panes[0]).pivots).toEqual({ blk_x: "up", "2024-01-02": "down" })
  })

  it("sets and clears one pivot, and is absent once none is left", () => {
    expect(withPivot(undefined, "blk_x", "up")).toEqual({ blk_x: "up" })
    expect(withPivot({ blk_x: "up" }, "blk_x", "down")).toEqual({ blk_x: "down" })
    expect(withPivot({ blk_x: "up" }, "blk_x", null)).toBeUndefined()
    expect(linkPivotsOf({ blk_x: "up" })).toEqual(new Map([["blk_x", "up"]]))
    expect(linkPivotsOf(undefined).size).toBe(0)
  })

  it("pushes a frame for an up pivot on the note root, and Back returns to the note", () => {
    const move = pivotRoot(paneOf(A), "up", P("blk_b1"))!
    expect(move.pane.frames).toEqual([
      { noteId: A, root: null, selected: ["blk_b1"] },
      { noteId: A, root: null, selected: null, pivots: { [A]: "up" } },
    ])
    const back = popFrame(move.pane)!
    expect(back.pane).toEqual(paneOf(A))
    expect(back.landing).toEqual(["blk_b1"])
    // Clearing the pivot is the same pop.
    expect(pivotRoot(move.pane, null, null)).toEqual(back)
    // Nothing to change: no move.
    expect(pivotRoot(move.pane, "up", null)).toBeNull()
    expect(pivotRoot(paneOf(A), null, null)).toBeNull()
  })

  it("reads a focused frame's root pivot by the focused block", () => {
    const move = pivotRoot(paneOf(A, "blk_b1"), "up", null)!
    expect(currentFrame(move.pane).pivots).toEqual({ blk_b1: "up" })
    // From a link, with no frame beneath: clearing drops the pivot in place.
    const linked = { frames: [currentFrame(move.pane)] }
    expect(pivotRoot(linked, null, null)!.pane).toEqual(paneOf(A, "blk_b1"))
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
      // Paths from the frame's root, without `blk_`.
      stack: `${A}::x/b1,${A}:blk_b1:^p`,
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
      { noteId: A, root: null, selected: P("blk_b1/blk_b2") },
      { noteId: "2024-01-02", root: "blk_b1", selected: P("blk_b1") },
    ]) {
      expect(parseFrame(formatFrame(frame))).toEqual(frame)
    }
  })
})
