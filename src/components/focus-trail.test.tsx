// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import { buildGraphSnapshot, CHILD_KIND } from "../data/graph"
import type { FocusFrame } from "../data/panes"

/**
 * The one focus breadcrumb (docs/split-view.md): the stack's frames as
 * segments, and between them the path through the graph from the earlier
 * root down to the later one.
 *
 *   note N › A › B › C, and C also sits under X (a second parent).
 */
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
  kind: CHILD_KIND,
  sort_key: "a0",
  updated_at: 0,
})
const GRAPH = buildGraphSnapshot(
  [
    node("N", "Note", "note"),
    node("A", "**Alpha**"),
    node("B", "Beta"),
    node("C", "Gamma"),
    node("X", "Other"),
  ],
  [link("N", "A"), link("A", "B"), link("B", "C"), link("N", "X"), link("X", "C")],
)

vi.mock("../global-state", async () => {
  const { atom } = await import("jotai")
  return { graphSnapshotAtom: atom(() => GRAPH) }
})

const { FocusTrail } = await import("./focus-trail")

afterEach(cleanup)

const frame = (root: string | null, selected: string | null = null): FocusFrame => ({
  noteId: "N",
  root,
  // A selection is a path of ids, written here as a key for short.
  selected: selected === null ? null : selected.split("/"),
})

function trail(frames: FocusFrame[]) {
  const onPopTo = vi.fn()
  const onGoVia = vi.fn()
  render(<FocusTrail frames={frames} onPopTo={onPopTo} onGoVia={onGoVia} />)
  const crumbs = Array.from(
    screen.getByTestId("focus-breadcrumb").querySelectorAll<HTMLElement>("[data-crumb]"),
  ).map((el) => `${el.dataset.crumb}:${el.textContent}`)
  return { crumbs, onPopTo, onGoVia }
}

describe("the focus breadcrumb", () => {
  it("shows each frame as a segment, with the path between their roots", () => {
    const { crumbs } = trail([frame(null, "A/B/C"), frame("C")])
    expect(crumbs).toEqual(["frame:Note", "path:Alpha", "path:Beta", "frame:Gamma"])
  })

  it("lets the stack decide the path of a block with two parents", () => {
    // The row recorded beneath names the way down…
    expect(trail([frame(null, "X/C"), frame("C")]).crumbs).toEqual([
      "frame:Note",
      "path:Other",
      "frame:Gamma",
    ])
    cleanup()
    // …and so does a frame on the second parent.
    expect(trail([frame(null), frame("X", "X/C"), frame("C")]).crumbs).toEqual([
      "frame:Note",
      "frame:Other",
      "frame:Gamma",
    ])
    cleanup()
    // With no row to go by (focused from elsewhere), the shortest path.
    expect(trail([frame(null, "A"), frame("C")]).crumbs).toEqual([
      "frame:Note",
      "path:Other",
      "frame:Gamma",
    ])
  })

  it("leads with the note and the path down when the stack starts on a block", () => {
    const { crumbs } = trail([frame("B")])
    expect(crumbs).toEqual(["path:Note", "path:Alpha", "frame:Beta"])
  })

  it("pops on a frame, and goes by way of the frame beneath on a path crumb", () => {
    const { onPopTo, onGoVia } = trail([frame(null, "A/B/C"), frame("C")])
    fireEvent.click(screen.getByText("Note"))
    expect(onPopTo).toHaveBeenCalledWith(0)
    fireEvent.click(screen.getByText("Beta"))
    expect(onGoVia).toHaveBeenCalledWith(0, { noteId: "N", root: "B" })
    // The view on screen is not a button.
    expect(screen.getByText("Gamma").getAttribute("aria-current")).toBe("page")
  })
})
