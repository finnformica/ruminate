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
        onSetEntry={vi.fn()}
      />,
    )

  it("draws a row per day and a column per series, and logs a tap", () => {
    const onSetEntry = vi.fn()
    render(
      <JournalGrid
        series={[READ, RUN]}
        range="month"
        start={TODAY}
        today={TODAY}
        selectedDay={TODAY}
        onSetEntry={onSetEntry}
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
    // A past day's check cell ticks the day, and a ticked one clears it.
    fireEvent.click(within(rows[23]).getAllByTestId("day-cell")[0])
    expect(onSetEntry).toHaveBeenLastCalledWith("s1", "2026-10-24", true)
    fireEvent.click(within(rows[24]).getAllByTestId("day-cell")[0])
    expect(onSetEntry).toHaveBeenLastCalledWith("s1", "2026-10-25", null)
    // A day after today is not loggable.
    expect(within(rows[27]).getAllByTestId("day-cell")[0].hasAttribute("disabled")).toBe(true)
  })

  it("edits a past day's number in place, with the Today strip's field", async () => {
    const onSetEntry = vi.fn()
    render(
      <JournalGrid
        series={[READ, RUN]}
        range="month"
        start={TODAY}
        today={TODAY}
        selectedDay={TODAY}
        onSetEntry={onSetEntry}
      />,
    )
    const rows = screen.getAllByTestId("journal-row")
    fireEvent.click(within(rows[19]).getAllByTestId("day-cell")[1])
    const editor = await screen.findByTestId("grid-cell-editor")
    expect(within(editor).getByRole("heading").textContent).toBe("Tue 20 Oct")
    const field = within(editor).getByRole("spinbutton")
    fireEvent.change(field, { target: { value: "5" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onSetEntry).toHaveBeenCalledWith("s2", "2026-10-20", 5)
    // The + steps from the day's own value: today's 4 km, by 0.5.
    cleanup()
    render(
      <JournalGrid
        series={[READ, RUN]}
        range="month"
        start={TODAY}
        today={TODAY}
        selectedDay={TODAY}
        onSetEntry={onSetEntry}
      />,
    )
    fireEvent.click(within(screen.getAllByTestId("journal-row")[26]).getAllByTestId("day-cell")[1])
    const more = await screen.findByRole("button", { name: "More Run" })
    fireEvent.click(more)
    expect(onSetEntry).toHaveBeenLastCalledWith("s2", "2026-10-27", 4.5)
  })

  it("names a month under its divider, and not a month that starts before the range", () => {
    // A week that runs from October into November: 1 October is not in it,
    // so October has no divider in view and no name.
    grid("week")
    const labels = document.querySelectorAll("[data-month-label]")
    expect([...labels].map((label) => label.textContent)).toEqual(["November 2026"])
    // The November label sits just before 1 November's row.
    const november = labels[0]
    expect(
      november.nextElementSibling?.querySelector("[data-day-row]")?.getAttribute("data-day-row"),
    ).toBe("2026-11-01")
    // The name is the first thing in its own month, under the divider.
    const groups = [...document.querySelectorAll("[data-month]")]
    expect(groups.map((group) => group.getAttribute("data-month"))).toEqual(["2026-10", "2026-11"])
    expect(groups[1].firstElementChild).toBe(november)
    expect(groups[1].className).toContain("border-t")
    expect(groups[0].className).not.toContain("border-t")
    expect(groups[0].querySelector("[data-month-label]")).toBeNull()
    cleanup()
    // A month from its 1st is named.
    grid("month")
    expect([...document.querySelectorAll("[data-month-label]")].map((l) => l.textContent)).toEqual([
      "October 2026",
    ])
  })

  it("draws every month's divider in a year, and names this month and every second", () => {
    grid("year")
    const groups = [...document.querySelectorAll("[data-month]")]
    expect(groups).toHaveLength(12)
    expect(groups.slice(1).every((group) => group.className.includes("border-t"))).toBe(true)
    const labels = [...document.querySelectorAll("[data-month-label]")]
    expect(labels.map((label) => label.textContent)).toEqual([
      "February 2026",
      "April 2026",
      "June 2026",
      "August 2026",
      "October 2026",
      "December 2026",
    ])
    // A name is not pinned: it sits in its own month, just above the
    // month's first day, and scrolls out with the divider.
    for (const label of labels) {
      const month = label.getAttribute("data-month-label")
      expect(label.parentElement?.getAttribute("data-month")).toBe(month)
      expect(label.className).not.toContain("sticky")
      expect(
        label.nextElementSibling?.querySelector("[data-day-row]")?.getAttribute("data-day-row"),
      ).toBe(`${month}-01`)
    }
    // A month's days are all there, named or not.
    expect(screen.getAllByTestId("journal-row")).toHaveLength(365)
  })

  it("marks the start of each week with a line above its Monday", () => {
    // October 2026 begins on a Thursday: its Mondays are the 5th, 12th,
    // 19th and 26th.
    grid("month")
    const weeks = [...document.querySelectorAll("[data-week-start]")]
    expect(weeks.map((line) => line.getAttribute("data-week-start"))).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ])
    cleanup()
    // A Monday that is the first of a month has the month's divider instead.
    grid("month", "2026-06-01")
    expect(document.querySelector('[data-week-start="2026-06-01"]')).toBeNull()
    expect(document.querySelector('[data-month-label="2026-06"]')).not.toBeNull()
  })

  it("labels each row with its weekday and number, and marks today", () => {
    grid("month")
    const rows = screen.getAllByTestId("journal-row")
    const header = (i: number) => within(rows[i]).getByRole("rowheader")
    expect(header(1).textContent).toBe("Fri2")
    expect(header(25).textContent).toBe("Mon26")
    const current = screen
      .getAllByRole("rowheader")
      .filter((row) => row.getAttribute("aria-current") === "date")
    expect(current.map((row) => row.getAttribute("data-day-row"))).toEqual([TODAY])
    expect(header(26).querySelector(".bg-text")?.textContent).toBe("27")
  })

  it("moves between cells with the arrow keys, never past today", () => {
    grid("month")
    const cell = (day: string, series: string) =>
      document.querySelector<HTMLElement>(`[data-day="${day}"][data-series="${series}"]`)!
    // One tab stop: today's first cell.
    const stops = screen.getAllByTestId("day-cell").filter((c) => c.tabIndex === 0)
    expect(stops).toEqual([cell(TODAY, "s1")])
    cell(TODAY, "s1").focus()
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" })
    expect(document.activeElement).toBe(cell("2026-10-26", "s1"))
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" })
    expect(document.activeElement).toBe(cell("2026-10-26", "s2"))
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" })
    expect(document.activeElement).toBe(cell("2026-10-26", "s2"))
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
    expect(document.activeElement).toBe(cell(TODAY, "s2"))
    expect(cell(TODAY, "s2").tabIndex).toBe(0)
    expect(cell(TODAY, "s1").tabIndex).toBe(-1)
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
      // around the row: (300 - 20 - 20) / 2. A month's name is not pinned,
      // so it does not cover a row.
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
