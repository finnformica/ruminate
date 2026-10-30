import { describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { expandedByDepth } from "../blocks/default-collapsed"
import { CORPUS_ROOT_ID, NOTE_TYPE, buildGraphSnapshot, rootView } from "./graph"
import {
  currentFrame,
  layoutFromSearch,
  layoutToSearch,
  withCurrent,
  type FocusFrame,
  type PaneLayout,
} from "./panes"
import { ROOT_DEPTH, ROOT_LABEL, isRootFrame, rootFrame, tapAction } from "./root-frame"
import { foldRule, withFold, type Folds } from "./view-state"

describe("the Root frame (docs/graph-walk.md, decision 5)", () => {
  it("is rooted at the corpus root and called Notes", () => {
    expect(rootFrame()).toEqual({ noteId: CORPUS_ROOT_ID, root: null, selected: null })
    expect(isRootFrame(rootFrame())).toBe(true)
    expect(isRootFrame({ noteId: "blk_a" })).toBe(false)
    expect(ROOT_LABEL).toBe("Notes")
  })
})

describe("folds in the Root frame, as in a note's (docs/graph-walk.md, section 5)", () => {
  const node = (id: string, text: string, type = "text"): NodeRow => ({
    id,
    type,
    text,
    props: null,
    updated_at: 0,
  })
  const link = (source: string, destination: string): LinkRow => ({
    source_id: source,
    destination_id: destination,
    kind: "child",
    sort_key: "a0",
    updated_at: 0,
  })
  const NOTE = "blk_notea"
  const graph = buildGraphSnapshot(
    [node(NOTE, "Apple", NOTE_TYPE), node("blk_seed", "Seed")],
    [link(NOTE, "blk_seed")],
  )

  const foldsOf = (frame: FocusFrame): Folds => ({
    open: new Set(frame.folds?.open ?? []),
    closed: new Set(frame.folds?.closed ?? []),
  })
  /** What the page draws for a frame: the walk of the corpus root by the
   * frame's folds over its depth (`NotePage`, `useFoldRule`). */
  const collapsedIn = (frame: FocusFrame) =>
    rootView(graph, foldRule(foldsOf(frame), expandedByDepth(frame.depth ?? ROOT_DEPTH))).collapsed
  /** A chevron clicked on `key`, written to the frame and the URL, and the
   * page read back from that URL (`withFold`, `layoutToSearch`). */
  const toggle = (layout: PaneLayout, pane: number, key: string): PaneLayout => {
    const frame = currentFrame(layout.panes[pane])
    const open = collapsedIn(frame).has(key)
    const byDefault = expandedByDepth(frame.depth ?? ROOT_DEPTH)(key, 1)
    const next = withFold(foldsOf(frame), key, open, byDefault)
    const panes = [...layout.panes]
    panes[pane] = withCurrent(panes[pane], {
      folds: { open: [...next.open], closed: [...next.closed] },
      depth: frame.depth ?? ROOT_DEPTH,
    })
    const { noteId, search } = layoutToSearch({ ...layout, panes })
    return layoutFromSearch(noteId, search as Record<string, unknown>)
  }

  it("opens and closes a note row, and keeps the fold through the URL", () => {
    let layout = layoutFromSearch(CORPUS_ROOT_ID, {})
    expect(collapsedIn(currentFrame(layout.panes[0])).has(NOTE)).toBe(true)
    layout = toggle(layout, 0, NOTE)
    const opened = currentFrame(layout.panes[0])
    expect(isRootFrame(opened)).toBe(true)
    expect(opened.folds).toEqual({ open: [NOTE], closed: [] })
    expect(collapsedIn(opened).has(NOTE)).toBe(false)
    const walked = rootView(graph, foldRule(foldsOf(opened), expandedByDepth(ROOT_DEPTH)))
    expect(walked.doc.blocks.blk_seed?.text).toBe("Seed")
    layout = toggle(layout, 0, NOTE)
    expect(collapsedIn(currentFrame(layout.panes[0])).has(NOTE)).toBe(true)
  })

  it("keeps the fold of Root in the second pane too", () => {
    let layout: PaneLayout = {
      panes: [layoutFromSearch(NOTE, {}).panes[0], { frames: [rootFrame()] }],
      active: 1,
    }
    layout = toggle(layout, 1, NOTE)
    expect(collapsedIn(currentFrame(layout.panes[1])).has(NOTE)).toBe(false)
    layout = toggle(layout, 1, NOTE)
    expect(collapsedIn(currentFrame(layout.panes[1])).has(NOTE)).toBe(true)
  })
})

describe("what a tap does: the frame decides (Settings → Editor)", () => {
  it("opens on the Root frame on a phone only, everywhere, or never", () => {
    expect(tapAction(true, true, "phone")).toBe("open")
    expect(tapAction(true, false, "phone")).toBe("edit")
    expect(tapAction(true, true, "always")).toBe("open")
    expect(tapAction(true, false, "always")).toBe("open")
    expect(tapAction(true, true, "never")).toBe("edit")
    expect(tapAction(true, false, "never")).toBe("edit")
  })

  it("edits in any other frame, whatever the setting", () => {
    for (const setting of ["phone", "always", "never"] as const) {
      expect(tapAction(false, true, setting)).toBe("edit")
      expect(tapAction(false, false, setting)).toBe("edit")
    }
  })
})
