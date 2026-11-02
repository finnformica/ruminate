// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { heatmapWeeks, type Series, type SeriesState } from "../../data/tracker"
import { ActivityCard, axisWeekdays, heatmapColumns } from "./activity"

afterEach(cleanup)

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
    expect([...axisWeekdays(8, 3)].sort()).toEqual([0, 2, 3, 4])
    expect([...axisWeekdays(8, 4)].sort()).toEqual([0, 2, 4])
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
      // Striped, with no outline and no fill.
      expect(placeholder.style.backgroundImage).toContain("repeating-linear-gradient")
      expect(placeholder.className).not.toContain("border")
      expect(placeholder.className).not.toContain("bg-")
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
      expect(label.className).toContain("justify-center")
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
