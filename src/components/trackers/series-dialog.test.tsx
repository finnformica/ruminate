// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SeriesState } from "../../data/tracker"
import type { TrackerWrites } from "../../hooks/tracker"
import { SeriesDialog } from "./series-dialog"

/**
 * The series list on a phone (a `Sheet`): the colour menu opens above the
 * sheet and takes a tap, and Remove's confirmation takes a tap on Cancel
 * and on Remove. A modal sheet locked the page's pointer events and kept
 * focus in itself, so neither the menu nor the confirmation, which sit
 * outside it in the page, could be tapped.
 */

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  // jsdom has no pointer capture, which vaul takes on a press in the sheet.
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.removeAttribute("style")
})

/** The `pointer-events` a browser hit-tests the element with: the nearest
 * one set on it or an ancestor (Radix and vaul set theirs inline). */
function pointerEvents(element: Element): string {
  for (let node: HTMLElement | null = element as HTMLElement; node; node = node.parentElement) {
    if (node.style.pointerEvents) return node.style.pointerEvents
  }
  return "auto"
}

/** A finger's tap, which reaches the element only if the page lets it. */
function tap(element: Element) {
  expect(pointerEvents(element), "the tap reaches the element").not.toBe("none")
  const init = { pointerType: "touch", pointerId: 1, isPrimary: true, button: 0, bubbles: true }
  fireEvent.pointerDown(element, init)
  fireEvent.mouseDown(element)
  fireEvent.pointerUp(element, init)
  fireEvent.mouseUp(element)
  fireEvent.click(element)
}

const SERIES: SeriesState = {
  series: {
    id: "s1",
    name: "Run",
    kind: "check",
    colour: "green",
    unit: "",
    min: null,
    max: null,
    step: 1,
    target: null,
    period: "day",
    rollup: "sum",
  },
  entries: new Map(),
}

function renderDialog() {
  const writes: TrackerWrites = {
    addSeries: vi.fn(() => null),
    updateSeries: vi.fn(),
    removeSeries: vi.fn(),
    setEntry: vi.fn(),
  }
  render(<SeriesDialog open series={[SERIES]} writes={writes} onClose={vi.fn()} />)
  return writes
}

/** Lets vaul's and Base UI's frame-delayed work run. */
const frames = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

describe("SeriesDialog on a phone", () => {
  it("opens the colour menu above the sheet and picks a colour with a tap", async () => {
    const writes = renderDialog()
    await frames()
    tap(screen.getByRole("button", { name: "Colour: Green" }))
    const item = await screen.findByRole("menuitem", { name: "Blue" })
    // The menu floats in the sheet's layer, not the popup layer beneath it.
    expect(item.closest(".z-modal")).not.toBeNull()
    tap(item)
    expect(writes.updateSeries).toHaveBeenCalledWith("s1", { colour: "blue" })
  })

  it("takes a tap on Cancel and on Remove in the confirmation", async () => {
    const writes = renderDialog()
    await frames()
    tap(screen.getByRole("button", { name: "Remove Run" }))
    const dialog = await screen.findByRole("alertdialog")
    await frames()
    // Focus is the confirmation's (Cancel, for a danger), not pulled back
    // into the sheet.
    const cancel = screen.getByRole("button", { name: "Cancel" })
    expect(document.activeElement).toBe(cancel)
    tap(cancel)
    await waitFor(() => expect(dialog.isConnected).toBe(false))
    expect(writes.removeSeries).not.toHaveBeenCalled()

    tap(screen.getByRole("button", { name: "Remove Run" }))
    await screen.findByRole("alertdialog")
    tap(screen.getByRole("button", { name: "Remove" }))
    expect(writes.removeSeries).toHaveBeenCalledWith("s1")
  })
})
