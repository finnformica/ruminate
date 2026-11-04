// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Series, SeriesState } from "../../data/tracker"
import { DayDialog } from "./day-dialog"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.removeAttribute("style")
})

const TODAY = "2026-10-29"

const READ: SeriesState = {
  series: {
    id: "s1",
    name: "Read",
    kind: "check",
    colour: "green",
    unit: "",
    min: null,
    max: null,
    step: 1,
    target: null,
    period: "day",
    rollup: "sum",
    goal: "do",
  } satisfies Series,
  entries: new Map([["2026-10-27", { id: "e1", date: "2026-10-27", value: true }]]),
}

const RUN: SeriesState = {
  series: { ...READ.series, id: "s2", name: "Run", kind: "number", unit: "km" },
  entries: new Map(),
}

/** A fine or a coarse pointer: the dialog, or the phone's sheet. */
function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: coarse && query === "(pointer: coarse)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
}

function renderDay(day: string | null) {
  const props = { onSetEntry: vi.fn(), onDayChange: vi.fn(), onClose: vi.fn() }
  render(<DayDialog series={[READ, RUN]} day={day} today={TODAY} {...props} />)
  return props
}

/** Lets vaul's and Base UI's frame-delayed work run. */
const frames = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

describe("DayDialog", () => {
  for (const coarse of [false, true]) {
    it(`edits every series on a past day (${coarse ? "sheet" : "dialog"})`, async () => {
      pointer(coarse)
      const props = renderDay("2026-10-27")
      await frames()
      expect(screen.getByTestId("day-editor").dataset.day).toBe("2026-10-27")
      expect(screen.getByText("Tue 27 Oct")).toBeTruthy()
      if (!coarse) expect(document.activeElement).toBe(screen.getByTestId("day-editor"))
      // The day is ticked on Read: a tap clears it.
      const pill = screen.getByTestId("check-control")
      expect(pill.getAttribute("aria-pressed")).toBe("true")
      fireEvent.click(pill)
      expect(props.onSetEntry).toHaveBeenLastCalledWith("s1", "2026-10-27", null)
      fireEvent.click(screen.getByRole("button", { name: "More Run" }))
      expect(props.onSetEntry).toHaveBeenLastCalledWith("s2", "2026-10-27", 1)
      fireEvent.click(screen.getByRole("button", { name: "Previous day" }))
      expect(props.onDayChange).toHaveBeenLastCalledWith("2026-10-26")
      fireEvent.click(screen.getByRole("button", { name: "Next day" }))
      expect(props.onDayChange).toHaveBeenLastCalledWith("2026-10-28")
    })
  }

  it("names yesterday, and does not step past today", async () => {
    pointer(false)
    renderDay(TODAY)
    await frames()
    expect(screen.getByText("Thu 29 Oct (Today)")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Next day" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    cleanup()
    renderDay("2026-10-28")
    await frames()
    expect(screen.getByText("Wed 28 Oct (Yesterday)")).toBeTruthy()
    // One date in the dialog: the header's.
    expect(screen.getAllByText(/28 Oct/)).toHaveLength(1)
  })

  it("opens nothing for no day or a day to come", () => {
    pointer(false)
    renderDay(null)
    expect(screen.queryByTestId("day-editor")).toBeNull()
    cleanup()
    renderDay("2026-10-30")
    expect(screen.queryByTestId("day-editor")).toBeNull()
  })
})
