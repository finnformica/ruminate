// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Series, SeriesState } from "../../data/tracker"
import { MonthGrid } from "./month-grid"
import { TodayStrip } from "./today-strip"

afterEach(cleanup)

const TODAY = "2026-10-27"

const BASE: Series = {
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
}

function stateOf(series: Partial<Series>, logged: Record<string, boolean | number>): SeriesState {
  const entries = new Map(
    Object.entries(logged).map(([date, value], i) => [date, { id: `e${i}`, date, value }]),
  )
  return { series: { ...BASE, ...series }, entries }
}

const READ = stateOf({}, { "2026-10-25": true, "2026-10-26": true })
const RUN = stateOf(
  { id: "s2", name: "Run", kind: "number", unit: "km", step: 0.5, target: 10, period: "week" },
  { "2026-10-27": 4 },
)

describe("MonthGrid", () => {
  it("draws one card per series, seven columns from Monday, with every day of the month", () => {
    render(<MonthGrid series={[READ, RUN]} start="2026-10-01" today={TODAY} onOpenDay={() => {}} />)
    const cards = screen.getAllByTestId("series-card")
    expect(cards).toHaveLength(2)
    const read = within(cards[0])
    expect(read.getByRole("grid", { name: "Read, by day" })).toBeTruthy()
    const headers = read.getAllByRole("columnheader")
    expect(headers.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ])
    const cells = read.getAllByTestId("day-cell")
    expect(cells).toHaveLength(31)
    expect(cells[0].getAttribute("data-day")).toBe("2026-10-01")
    // October 2026 begins on a Thursday: three blanks lead the first row.
    const firstRow = read.getAllByRole("row")[1]
    expect(firstRow.children).toHaveLength(7)
    expect(within(firstRow).getAllByTestId("day-cell")).toHaveLength(4)
  })

  it("fills a logged day, marks today, and disables the days after it", () => {
    render(<MonthGrid series={[READ]} start="2026-10-01" today={TODAY} onOpenDay={() => {}} />)
    const done = screen.getByRole("button", { name: "Mon 26 Oct: done" })
    expect(done.getAttribute("data-level")).toBe("4")
    const today = screen.getByRole("button", { name: "Tue 27 Oct: nothing" })
    expect(today.getAttribute("aria-current")).toBe("date")
    expect(today.getAttribute("data-level")).toBe("0")
    const tomorrow = screen.getByRole("button", { name: "Wed 28 Oct: nothing" })
    expect((tomorrow as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows the streak, the month's rollup and the target's progress", () => {
    render(<MonthGrid series={[READ, RUN]} start="2026-10-01" today={TODAY} onOpenDay={() => {}} />)
    const [read, run] = screen.getAllByTestId("series-card")
    // Two days in a row up to yesterday, two ticks this month.
    expect(within(read).getByText("2d")).toBeTruthy()
    expect(within(read).getByText("2×")).toBeTruthy()
    expect(within(read).queryByTestId("target-progress")).toBeNull()
    // The row is still there, empty, so the cards line up.
    expect(within(read).getByTestId("target-slot")).toBeTruthy()
    expect(within(run).queryByTestId("target-slot")).toBeNull()
    expect(within(run).getByText("4 km")).toBeTruthy()
    const bar = within(run).getByRole("progressbar", { name: "Target this week" })
    expect(bar.getAttribute("aria-valuenow")).toBe("4")
    expect(bar.getAttribute("aria-valuemax")).toBe("10")
    expect(within(run).getByText("4/10 km this week")).toBeTruthy()
  })

  it("opens the day editor on any day up to today, on any series", () => {
    const onOpenDay = vi.fn()
    render(
      <MonthGrid series={[READ, RUN]} start="2026-10-01" today={TODAY} onOpenDay={onOpenDay} />,
    )
    const [read, run] = screen.getAllByTestId("series-card")
    fireEvent.click(within(read).getByRole("button", { name: "Mon 26 Oct: done" }))
    expect(onOpenDay).toHaveBeenLastCalledWith("2026-10-26")
    fireEvent.click(within(run).getByRole("button", { name: "Sat 24 Oct: nothing" }))
    expect(onOpenDay).toHaveBeenLastCalledWith("2026-10-24")
    expect(onOpenDay).toHaveBeenCalledTimes(2)
  })

  it("names a series to avoid, counts its clean streak and marks a slip", () => {
    const smoke = stateOf(
      { id: "s3", name: "Smoke", goal: "avoid", colour: "red" },
      { "2026-10-24": true },
    )
    render(
      <MonthGrid series={[READ, smoke]} start="2026-10-01" today={TODAY} onOpenDay={() => {}} />,
    )
    const card = screen.getAllByTestId("series-card")[1]
    expect(within(card).getByText("Avoid")).toBeTruthy()
    // Clean on the 25th, the 26th and today, the 27th.
    expect(within(card).getByText("3d").parentElement?.title).toBe("Clean days in a row")
    const slip = within(card).getByRole("button", { name: "Sat 24 Oct: done" })
    expect(slip.querySelector("[data-slip]")).toBeTruthy()
    expect(card.querySelectorAll("[data-slip]")).toHaveLength(1)
  })
})

describe("TodayStrip", () => {
  it("ticks and clears a check series on the day", () => {
    const onSetEntry = vi.fn()
    render(<TodayStrip series={[READ]} today={TODAY} onSetEntry={onSetEntry} />)
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy()
    const pill = screen.getByTestId("check-control")
    expect(pill.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(pill)
    expect(onSetEntry).toHaveBeenCalledWith("s1", TODAY, true)
  })

  it("steps a number series by its step, within its bounds, and takes a typed value", () => {
    const onSetEntry = vi.fn()
    render(<TodayStrip series={[RUN]} today={TODAY} onSetEntry={onSetEntry} />)
    fireEvent.click(screen.getByRole("button", { name: "More Run" }))
    expect(onSetEntry).toHaveBeenLastCalledWith("s2", TODAY, 4.5)
    fireEvent.click(screen.getByRole("button", { name: "Less Run" }))
    expect(onSetEntry).toHaveBeenLastCalledWith("s2", TODAY, 3.5)
    const field = screen.getByRole("spinbutton", { name: "Run" }) as HTMLInputElement
    expect(field.value).toBe("4")
    fireEvent.change(field, { target: { value: "7.5" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onSetEntry).toHaveBeenLastCalledWith("s2", TODAY, 7.5)
    fireEvent.change(field, { target: { value: "" } })
    fireEvent.blur(field)
    expect(onSetEntry).toHaveBeenLastCalledWith("s2", TODAY, null)
  })

  it("logs today only: no day arrows and no Yesterday", () => {
    render(<TodayStrip series={[READ]} today={TODAY} onSetEntry={() => {}} />)
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Yesterday" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Previous day" })).toBeNull()
  })
})
