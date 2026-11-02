// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { heatmapWeeks, type Series, type SeriesState } from "../../data/tracker"
import { ActivityCard, TrackerStats, axisWeekdays, heatmapColumns } from "./activity"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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
  } satisfies Series,
  entries: new Map([
    ["2026-09-30", { id: "e1", date: "2026-09-30", value: true }],
    ["2026-10-28", { id: "e2", date: "2026-10-28", value: true }],
  ]),
}

const heatmap = (today: string) => render(<ActivityCard series={[READ]} today={today} />)

const labels = () =>
  [...document.querySelectorAll("[data-month-label]")].map((label) => label.textContent)

const cell = (day: string) => document.querySelector<HTMLElement>(`[data-day="${day}"]`)!

describe("heatmapColumns", () => {
  it("splits a week that runs into a new month, with placeholders for the other month", () => {
    // Twelve weeks from Monday 10 August; three of them hold two months.
    const columns = heatmapColumns(heatmapWeeks("2026-10-29"))
    expect(columns).toHaveLength(15)
    expect(columns.map((column) => column.month)).toEqual([
      ...Array(4).fill("2026-08"),
      ...Array(5).fill("2026-09"),
      ...Array(5).fill("2026-10"),
      "2026-11",
    ])
    // The week of Monday 28 September: Monday to Wednesday, then Thursday 1
    // October to Sunday.
    expect(columns[8].days).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      null,
      null,
      null,
      null,
    ])
    expect(columns[9].days).toEqual([
      null,
      null,
      null,
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ])
    // A week inside one month is one column.
    expect(columns[10].days.every((day) => day !== null)).toBe(true)
  })
})

describe("axisWeekdays", () => {
  it("names every weekday when a row is tall enough, else Mon, Wed and Fri, and today", () => {
    expect([...axisWeekdays(null, 3)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect([...axisWeekdays(12, 5)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    // The desktop card's cells (about 11.7 px) have room for all seven.
    expect([...axisWeekdays(11.7, 5)].sort()).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect([...axisWeekdays(6, 3)].sort()).toEqual([0, 2, 3, 4])
    expect([...axisWeekdays(6, 4)].sort()).toEqual([0, 2, 4])
  })
})

describe("ActivityHeatmap", () => {
  it("draws one straight divider per month boundary, in its own track, Monday to Sunday", () => {
    heatmap("2026-10-29")
    const dividers = [...document.querySelectorAll<HTMLElement>("[data-month-divider]")]
    expect(dividers.map((divider) => divider.dataset.monthDivider)).toEqual([
      "2026-09",
      "2026-10",
      "2026-11",
    ])
    // The tracks: the day axis, fifteen columns, and a narrow track before
    // each month's first column, which the divider stands in, with a gap
    // each side of it.
    const template = screen.getByTestId("activity-heatmap").style.gridTemplateColumns
    expect(template.split(" minmax(0, 1fr)").length - 1).toBe(15)
    expect(template.match(/6px/g)).toHaveLength(3)
    expect(dividers.map((divider) => divider.style.gridColumn)).toEqual(["6", "12", "18"])
    // From the Monday row (2) down past Sunday (8), not up into the names.
    for (const divider of dividers) expect(divider.style.gridRow).toBe("2 / 9")
    // No cell draws a piece of a line, and no cell sits in a divider's track.
    expect(document.querySelectorAll("[data-divider]")).toHaveLength(0)
    const cells = document.querySelectorAll<HTMLElement>('[role="gridcell"]')
    for (const cell of cells) expect(["6", "12", "18"]).not.toContain(cell.style.gridColumn)
  })

  it("draws days as rounded squares, not circles", () => {
    heatmap("2026-10-29")
    // A weekday's name takes no height, so a row is exactly a cell high.
    for (const header of screen.getAllByRole("rowheader")) {
      expect(header.className).toContain("h-0")
    }
    for (const cell of document.querySelectorAll('[role="gridcell"]')) {
      expect(cell.className).toContain("rounded-sm")
      expect(cell.className).not.toMatch(/rounded(-full|-lg)?( |$)/)
    }
  })

  it("draws the other month's days in a split week as placeholders with no data", () => {
    heatmap("2026-10-29")
    const placeholders = [...document.querySelectorAll<HTMLElement>("[data-placeholder]")]
    // Three split weeks, seven placeholders each.
    expect(placeholders).toHaveLength(21)
    for (const placeholder of placeholders) {
      expect(placeholder.getAttribute("aria-hidden")).toBe("true")
      expect(placeholder.hasAttribute("data-day")).toBe(false)
      expect(placeholder.hasAttribute("aria-label")).toBe(false)
      expect(placeholder.tabIndex).toBe(-1)
      // A hollow square: a 0.5 px solid outline and 0.5 px stripes in one
      // solid colour (not an alpha border colour), and no fill.
      expect(placeholder.className).toContain("border-[0.5px]")
      expect(placeholder.className).not.toContain("border-dashed")
      expect(placeholder.className).not.toContain("bg-")
      expect(placeholder.className).not.toContain("opacity")
      expect(placeholder.style.backgroundImage).toContain("repeating-linear-gradient")
      expect(placeholder.style.backgroundImage).toContain("var(--neutral-6) 0 0.5px")
      expect(placeholder.style.backgroundImage).not.toContain("--color-border")
      expect(placeholder.getAttribute("style")).toContain("border-color: var(--neutral-6)")
    }
    // Every day is drawn once; only the two logged days count as entries.
    expect(document.querySelectorAll("[data-day]")).toHaveLength(84)
    const logged = [...document.querySelectorAll<HTMLElement>("[data-day]")].filter(
      (day) => day.dataset.series !== "0",
    )
    expect(logged.map((day) => day.dataset.day)).toEqual(["2026-09-30", "2026-10-28"])
    // Nothing in the heatmap can be tapped.
    expect(
      screen.getByTestId("activity-heatmap").querySelectorAll("button, [tabindex]"),
    ).toHaveLength(0)
  })

  // The tracks the names stand in: a divider's for a month that starts in
  // the heatmap, the first column's for the month it opens on.
  const namedTracks = () =>
    [...document.querySelectorAll<HTMLElement>("[data-month-label]")].map(
      (label) => label.style.gridColumn,
    )

  it("names a month only beside its divider, never the month it opens in mid-month", () => {
    // From Monday 10 August: 1 August is before the heatmap, so August has
    // no divider and no name.
    heatmap("2026-10-29")
    expect(labels()).toEqual(["Sept", "Oct", "Nov"])
    // Each name sits on top of its divider: the same track, the row above.
    const dividers = [...document.querySelectorAll<HTMLElement>("[data-month-divider]")]
    expect(namedTracks()).toEqual(dividers.map((divider) => divider.style.gridColumn))
    for (const label of document.querySelectorAll<HTMLElement>("[data-month-label]")) {
      expect(label.style.gridRow).toBe("1")
      // From the track's left edge, so the first letter is over the line.
      expect(label.className).not.toContain("justify-center")
      // A little smaller than the text around it.
      expect(label.className).toContain("text-[11px]")
    }
    cleanup()
    // From Monday 31 August: August's one day has no name either.
    heatmap("2026-11-19")
    expect(labels()).toEqual(["Sept", "Oct", "Nov"])
    // September's divider stands before the second column.
    expect(namedTracks()[0]).toBe("3")
  })

  it("names the month it opens in when it opens on the 1st", () => {
    // From Monday 1 June: June starts in the first column.
    heatmap("2026-08-20")
    expect(labels()).toEqual(["Jun", "Jul", "Aug"])
    // June over the first column; July and August on their dividers.
    expect(namedTracks()).toEqual(["2", "7", "13"])
  })

  it("does not pin a name", () => {
    heatmap("2026-10-29")
    for (const label of document.querySelectorAll("[data-month-label]")) {
      expect(label.className).not.toContain("sticky")
    }
  })

  it("names every weekday on the day axis, and marks today", () => {
    heatmap("2026-10-29")
    const axis = screen.getAllByRole("rowheader")
    expect(axis.map((header) => header.textContent)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ])
    // Today is a Thursday: its name is in bold, and only its.
    expect(axis.map((header) => header.className.includes("font-bold"))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ])
    const current = document.querySelectorAll('[aria-current="date"]')
    expect([...current].map((day) => day.getAttribute("data-day"))).toEqual(["2026-10-29"])
    expect(cell("2026-10-29").className).toContain("ring-2")
    // One dot, under October's half of the last week: the column today is
    // in (the 14th of 15), past the day axis and three divider tracks.
    const marks = screen.getAllByTestId("heatmap-today-mark")
    expect(marks).toHaveLength(1)
    expect(marks[0].dataset.column).toBe("13")
    expect(marks[0].style.gridColumn).toBe("17")
    expect(marks[0].style.gridRow).toBe("9")
  })
})

describe("the heatmap's rows", () => {
  it("makes each weekday's row as tall as a cell is wide, with one gap both ways", () => {
    // jsdom draws nothing: give every cell a 20 px side, and run the
    // observer's callback as soon as it observes.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 20,
      height: 20,
    } as DOMRect)
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe() {
          this.callback()
        }
        disconnect() {}
      },
    )
    heatmap("2026-10-29")
    const grid = screen.getByTestId("activity-heatmap")
    expect(grid.style.gridTemplateRows).toBe("auto repeat(7, 20px) auto")
    expect(grid.style.gap).toBe("4px")
  })
})

const SWIM: SeriesState = {
  series: { ...READ.series, id: "s2", name: "Swim", kind: "number", colour: "blue", unit: "min" },
  entries: new Map([
    ["2026-10-28", { id: "e3", date: "2026-10-28", value: 30, detail: "30 min" }],
    ["2026-10-27", { id: "e4", date: "2026-10-27", value: 20 }],
  ]),
}

describe("the Recent list", () => {
  it("groups the series logged on one day under one date, between one pair of dividers", () => {
    render(<ActivityCard series={[READ, SWIM]} today="2026-10-29" />)
    const days = [...document.querySelectorAll<HTMLElement>("[data-recent-day]")]
    expect(days.map((day) => day.dataset.recentDay)).toEqual([
      "2026-10-28",
      "2026-10-27",
      "2026-09-30",
    ])
    // The 28th: one date label, then Read and Swim, in the series's order.
    expect(within(days[0]).getAllByText("28 Oct")).toHaveLength(1)
    const lines = within(days[0]).getAllByRole("listitem")
    expect(lines.map((line) => line.textContent)).toEqual(["Read", "Swim · 30 min"])
    // The divider is the group's top border: none inside a day.
    for (const line of lines) expect(line.className).not.toContain("border-t")
  })
})

describe("TrackerStats", () => {
  it("shows the streak, the last 7 and 28 days, and all time", () => {
    render(<TrackerStats series={[READ, SWIM]} today="2026-10-29" />)
    const stats = screen.getByTestId("tracker-stats")
    const pairs = [...stats.querySelectorAll("dt")].map(
      (dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`,
    )
    expect(pairs).toEqual([
      "Streak: 2 days",
      "Last 7 days: 2/7",
      "Last 28 days: 2/28",
      "All time: 3 days",
    ])
  })
})
