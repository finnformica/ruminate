// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { Series, SeriesState } from "../../data/tracker"
import { ActivityCard } from "./activity"

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
  entries: new Map([["2026-10-28", { id: "e1", date: "2026-10-28", value: true }]]),
}

const heatmap = (today: string) => render(<ActivityCard series={[READ]} today={today} />)

const labels = () =>
  [...document.querySelectorAll("[data-month-label]")].map((label) => label.textContent)

const cell = (day: string) => document.querySelector<HTMLElement>(`[data-day="${day}"]`)!

describe("ActivityHeatmap", () => {
  it("names every month over the week it starts in, when the names fit", () => {
    // Twelve weeks from Monday 10 August: September starts in the fourth
    // column, October in the eighth, and November (Sunday the 1st, still to
    // come) in the last.
    heatmap("2026-10-29")
    expect(labels()).toEqual(["Aug", "Sept", "Oct", "Nov"])
    const columns = [...document.querySelectorAll('[role="columnheader"]')]
    expect(columns.map((column) => column.getAttribute("data-month-label"))).toEqual([
      "2026-08",
      null,
      null,
      "2026-09",
      null,
      null,
      null,
      "2026-10",
      null,
      null,
      null,
      "2026-11",
    ])
  })

  it("thins the names when two would overlap, and always names this month", () => {
    // From Monday 24 August: September starts one column after August, too
    // close for both names. This month and every second from it are named.
    heatmap("2026-11-12")
    expect(labels()).toEqual(["Sept", "Nov"])
  })

  it("divides the months with a stepped line in the gaps", () => {
    heatmap("2026-10-29")
    // 1 October, a Thursday: September is to its left and above it.
    expect(cell("2026-10-01").dataset.divider).toBe("both")
    // The rest of that week is October beside September.
    expect(cell("2026-10-02").dataset.divider).toBe("left")
    // The Monday after: the line runs down the gap to its left.
    expect(cell("2026-10-05").dataset.divider).toBe("left")
    // Inside a month there is no line.
    expect(cell("2026-09-28").dataset.divider).toBeUndefined()
    expect(cell("2026-10-14").dataset.divider).toBeUndefined()
  })

  it("names Mon, Wed and Fri on the day axis, and marks today", () => {
    heatmap("2026-10-29")
    const axis = screen.getAllByRole("rowheader").map((header) => header.textContent)
    // Today is a Thursday: its weekday is named too, in bold.
    expect(axis).toEqual(["Mon", "", "Wed", "Thu", "Fri", "", ""])
    expect(screen.getAllByRole("rowheader")[3].className).toContain("font-bold")
    const current = document.querySelectorAll('[aria-current="date"]')
    expect([...current].map((day) => day.getAttribute("data-day"))).toEqual(["2026-10-29"])
    expect(cell("2026-10-29").className).toContain("ring-2")
    // One dot, under the last week: the week today is in.
    const marks = screen.getAllByTestId("heatmap-today-mark")
    expect(marks).toHaveLength(1)
    const dots = marks[0].parentElement!.parentElement!.children
    expect(dots[dots.length - 1].contains(marks[0])).toBe(true)
  })
})
