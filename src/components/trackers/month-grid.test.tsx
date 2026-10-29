// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Series, SeriesState } from "../../data/tracker"
import { JournalGrid } from "./journal-grid"
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

describe("MonthGrid ranges", () => {
  it("draws a week as one row of seven days from Monday", () => {
    render(
      <MonthGrid
        series={[READ]}
        range="week"
        start={TODAY}
        today={TODAY}
        selectedDay={TODAY}
        onToggle={() => {}}
        onPickDay={() => {}}
      />,
    )
    const cells = screen.getAllByTestId("day-cell")
    expect(cells.map((c) => c.getAttribute("data-day"))).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ])
    expect(cells[0].getAttribute("data-level")).toBe("4")
  })

  it("draws a year as every day of it, a row a weekday", () => {
    render(
      <MonthGrid
        series={[READ]}
        range="year"
        start={TODAY}
        today={TODAY}
        selectedDay={TODAY}
        onToggle={() => {}}
        onPickDay={() => {}}
      />,
    )
    const cells = screen.getAllByTestId("day-cell")
    expect(cells).toHaveLength(365)
    // The first row is the Mondays: 5 January 2026 is the first.
    expect(cells[0].getAttribute("data-day")).toBe("2026-01-05")
  })
})

describe("JournalGrid", () => {
  const grid = (range: "week" | "month" | "year", start = TODAY) =>
    render(
      <JournalGrid
        series={[READ, RUN]}
        range={range}
        start={start}
        today={TODAY}
        selectedDay={TODAY}
        onToggle={vi.fn()}
        onPickDay={vi.fn()}
      />,
    )

  it("draws a row per day and a column per series, and logs a tap", () => {
    const onToggle = vi.fn()
    const onPickDay = vi.fn()
    render(
      <JournalGrid
        series={[READ, RUN]}
        range="month"
        start={TODAY}
        today={TODAY}
        selectedDay={TODAY}
        onToggle={onToggle}
        onPickDay={onPickDay}
      />,
    )
    const rows = screen.getAllByTestId("journal-row")
    expect(rows).toHaveLength(31)
    expect(within(rows[0]).getByRole("rowheader").getAttribute("data-day-row")).toBe("2026-10-01")
    expect(within(rows[30]).getByRole("rowheader").getAttribute("data-day-row")).toBe("2026-10-31")
    // Each row holds a cell per series, in the series's order.
    const today = within(rows[26]).getAllByTestId("day-cell")
    expect(today.map((cell) => cell.getAttribute("aria-label"))).toEqual([
      "Tue 27 Oct: nothing",
      "Tue 27 Oct: 4 km",
    ])
    fireEvent.click(within(rows[23]).getAllByTestId("day-cell")[0])
    expect(onToggle).toHaveBeenCalledWith("s1", "2026-10-24", true)
    fireEvent.click(today[1])
    expect(onPickDay).toHaveBeenCalledWith("2026-10-27")
  })

  it("heads each column with its series's colour and no name, named for a screen reader", () => {
    grid("month")
    const columns = screen.getAllByTestId("journal-column")
    expect(columns.map((column) => column.getAttribute("aria-label"))).toEqual(["Read", "Run"])
    for (const column of columns) expect(column.textContent).toBe("")
    // The corner over the days, then one header per series.
    expect(screen.getAllByRole("columnheader")).toHaveLength(3)
    expect(screen.queryByText("Read")).toBeNull()
  })

  it("draws a week as seven rows from Monday and a year as a row a day", () => {
    grid("week")
    const week = screen.getAllByTestId("journal-row")
    expect(week).toHaveLength(7)
    expect(within(week[0]).getByRole("rowheader").getAttribute("data-day-row")).toBe("2026-10-26")
    expect(within(week[1]).getByRole("rowheader").getAttribute("aria-label")).toBe("Tue 27 Oct")
    cleanup()
    grid("year")
    const year = screen.getAllByTestId("journal-row")
    expect(year).toHaveLength(365)
    expect(within(year[0]).getAllByTestId("day-cell")).toHaveLength(2)
  })

  it("opens scrolled to today's row, under the row of colours", () => {
    const top = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.dayRow === TODAY ? 900 : 0
    })
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20)
    const view = vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(300)
    const scrolled = vi.spyOn(Element.prototype, "scrollTop", "set")
    try {
      grid("month")
      // 900 down, less the 20 px of colours, less half of what is left
      // around the row: (300 - 20 - 20) / 2.
      expect(scrolled).toHaveBeenLastCalledWith(750)
    } finally {
      top.mockRestore()
      height.mockRestore()
      view.mockRestore()
      scrolled.mockRestore()
    }
  })
})

describe("MonthGrid", () => {
  it("draws one card per series, seven columns from Monday, with every day of the month", () => {
    render(
      <MonthGrid
        series={[READ, RUN]}
        start="2026-10-01"
        today={TODAY}
        selectedDay={TODAY}
        onToggle={() => {}}
        onPickDay={() => {}}
      />,
    )
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
    render(
      <MonthGrid
        series={[READ]}
        start="2026-10-01"
        today={TODAY}
        selectedDay={TODAY}
        onToggle={() => {}}
        onPickDay={() => {}}
      />,
    )
    const done = screen.getByRole("button", { name: "Mon 26 Oct: done" })
    expect(done.getAttribute("data-level")).toBe("4")
    expect(done.getAttribute("aria-pressed")).toBe("true")
    const today = screen.getByRole("button", { name: "Tue 27 Oct: nothing" })
    expect(today.getAttribute("aria-current")).toBe("date")
    expect(today.getAttribute("data-level")).toBe("0")
    const tomorrow = screen.getByRole("button", { name: "Wed 28 Oct: nothing" })
    expect((tomorrow as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows the streak, the month's rollup and the target's progress", () => {
    render(
      <MonthGrid
        series={[READ, RUN]}
        start="2026-10-01"
        today={TODAY}
        selectedDay={TODAY}
        onToggle={() => {}}
        onPickDay={() => {}}
      />,
    )
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

  it("toggles a check series's day and picks a number series's day", () => {
    const onToggle = vi.fn()
    const onPickDay = vi.fn()
    render(
      <MonthGrid
        series={[READ, RUN]}
        start="2026-10-01"
        today={TODAY}
        selectedDay={TODAY}
        onToggle={onToggle}
        onPickDay={onPickDay}
      />,
    )
    const [read, run] = screen.getAllByTestId("series-card")
    fireEvent.click(within(read).getByRole("button", { name: "Mon 26 Oct: done" }))
    expect(onToggle).toHaveBeenCalledWith("s1", "2026-10-26", false)
    fireEvent.click(within(read).getByRole("button", { name: "Sat 24 Oct: nothing" }))
    expect(onToggle).toHaveBeenCalledWith("s1", "2026-10-24", true)
    fireEvent.click(within(run).getByRole("button", { name: "Mon 26 Oct: nothing" }))
    expect(onPickDay).toHaveBeenCalledWith("2026-10-26")
    expect(onToggle).toHaveBeenCalledTimes(2)
  })
})

describe("TodayStrip", () => {
  it("ticks and clears a check series on the day", () => {
    const onSetEntry = vi.fn()
    render(
      <TodayStrip
        series={[READ]}
        day={TODAY}
        today={TODAY}
        onSetEntry={onSetEntry}
        onBackToToday={() => {}}
      />,
    )
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy()
    const pill = screen.getByTestId("check-control")
    expect(pill.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(pill)
    expect(onSetEntry).toHaveBeenCalledWith("s1", TODAY, true)
  })

  it("steps a number series by its step, within its bounds, and takes a typed value", () => {
    const onSetEntry = vi.fn()
    render(
      <TodayStrip
        series={[RUN]}
        day={TODAY}
        today={TODAY}
        onSetEntry={onSetEntry}
        onBackToToday={() => {}}
      />,
    )
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

  it("names a picked day and offers the way back to today", () => {
    const onBackToToday = vi.fn()
    render(
      <TodayStrip
        series={[READ]}
        day="2026-10-20"
        today={TODAY}
        onSetEntry={() => {}}
        onBackToToday={onBackToToday}
      />,
    )
    expect(screen.getByRole("heading", { name: "Tue 20 Oct" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Today" }))
    expect(onBackToToday).toHaveBeenCalled()
  })
})
