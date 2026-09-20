// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useDragReorder } from "./drag-reorder"

/** A drag event over a row whose box is 100px tall at y=0, dropped in its top
 * or bottom half. */
function dragEventOver(half: "top" | "bottom") {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientY: half === "top" ? 20 : 80,
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) },
    dataTransfer: { dropEffect: "", effectAllowed: "", setData: vi.fn() },
  } as unknown as React.DragEvent
}

const startEvent = () =>
  ({
    dataTransfer: { effectAllowed: "", setData: vi.fn() },
  }) as unknown as React.DragEvent

function setup(ids = ["a", "b", "c"]) {
  const onMove = vi.fn()
  const view = renderHook(() => useDragReorder({ ids, onMove }))
  return { view, onMove }
}

/** Drag `from` onto the given half of `onto`, and drop. */
function drag(
  view: ReturnType<typeof setup>["view"],
  from: string,
  onto: string,
  half: "top" | "bottom",
) {
  act(() => view.result.current.rowProps(from).onDragStart(startEvent()))
  act(() => view.result.current.rowProps(onto).onDragOver(dragEventOver(half)))
  act(() => view.result.current.rowProps(onto).onDrop(dragEventOver(half)))
}

describe("drag to reorder", () => {
  it("drops a row above the one its top half is over", () => {
    const { view, onMove } = setup()
    drag(view, "c", "a", "top")
    expect(onMove).toHaveBeenCalledWith("c", ["c", "a", "b"])
  })

  it("drops a row below the one its bottom half is over", () => {
    const { view, onMove } = setup()
    drag(view, "a", "b", "bottom")
    expect(onMove).toHaveBeenCalledWith("a", ["b", "a", "c"])
  })

  it("drops past the last row", () => {
    const { view, onMove } = setup()
    drag(view, "a", "c", "bottom")
    expect(onMove).toHaveBeenCalledWith("a", ["b", "c", "a"])
  })

  it("asks for nothing when the row lands where it already was", () => {
    const { view, onMove } = setup()
    drag(view, "b", "b", "top")
    expect(onMove).not.toHaveBeenCalled()
  })

  it("leaves the list alone when a drag is abandoned", () => {
    const { view, onMove } = setup()
    act(() => view.result.current.rowProps("c").onDragStart(startEvent()))
    act(() => view.result.current.rowProps("a").onDragOver(dragEventOver("top")))
    act(() => view.result.current.rowProps("c").onDragEnd())
    expect(onMove).not.toHaveBeenCalled()
    expect(view.result.current.dragging).toBeNull()
  })

  it("marks the dragged row, and clears it on drop", () => {
    const { view } = setup()
    act(() => view.result.current.rowProps("b").onDragStart(startEvent()))
    expect(view.result.current.rowProps("b")["data-dragging"]).toBe("")
    expect(view.result.current.rowProps("a")["data-dragging"]).toBeUndefined()
    drag(view, "b", "a", "top")
    expect(view.result.current.dragging).toBeNull()
  })

  it("starts no drag at all when disabled", () => {
    const onMove = vi.fn()
    const view = renderHook(() => useDragReorder({ ids: ["a", "b"], onMove, enabled: false }))
    expect(view.result.current.rowProps("a").draggable).toBe(false)
    act(() => view.result.current.rowProps("a").onDragStart(startEvent()))
    expect(view.result.current.dragging).toBeNull()
  })
})
