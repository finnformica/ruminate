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
  it("draws one straight divider element per month boundary, the grid's full height", () => {
    heatmap("2026-10-29")
    const dividers = [...document.querySelectorAll<HTMLElement>("[data-month-divider]")]
    expect(dividers.map((divider) => divider.dataset.monthDivider)).toEqual([
      "2026-09",
      "2026-10",
      "2026-11",
    ])
    // Each in the gap before its month's first column (the day axis is
    // grid column 1), from the names down past Sunday.
    expect(dividers.map((divider) => divider.style.gridColumn)).toEqual([
      "6 / span 1",
      "11 / span 1",
      "16 / span 1",
    ])
    for (const divider of dividers) expect(divider.style.gridRow).toBe("1 / 9")
    // No cell draws a piece of a line.
    expect(document.querySelectorAll("[data-divider]")).toHaveLength(0)
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
      expect(placeholder.className).toContain("border-dashed")
      expect(placeholder.className).toContain("bg-bg-secondary")
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

  it("names every month over its first column, when the names fit", () => {
    heatmap("2026-10-29")
    expect(labels()).toEqual(["Aug", "Sept", "Oct", "Nov"])
    const columns = [...document.querySelectorAll('[role="columnheader"]')]
    const named = columns.flatMap((column, c) =>
      column.getAttribute("data-month-label") ? [c] : [],
    )
    expect(named).toEqual([0, 4, 9, 14])
  })

  it("thins the names when two would overlap, and always names this month", () => {
    // From Monday 31 August: August has one column, and September starts
    // in the next, too close for both names.
    heatmap("2026-11-19")
    expect(labels()).toEqual(["Sept", "Nov"])
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
    // in (after the day axis, the 14th of 15).
    const marks = screen.getAllByTestId("heatmap-today-mark")
    expect(marks).toHaveLength(1)
    const dots = [...marks[0].parentElement!.parentElement!.children]
    expect(dots.findIndex((dot) => dot.contains(marks[0]))).toBe(14)
  })
})
