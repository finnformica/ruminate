import { describe, expect, it } from "vitest"
import { fitMonthLabels, labelledMonths } from "./month-labels"

const YEAR = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`)

describe("labelledMonths", () => {
  it("always labels the current month, and every second one either side", () => {
    for (const current of YEAR) {
      const labelled = labelledMonths(YEAR, current, 2)
      expect(labelled.has(current)).toBe(true)
      const at = YEAR.indexOf(current)
      for (const [i, month] of YEAR.entries()) {
        expect(labelled.has(month)).toBe((i - at) % 2 === 0)
      }
    }
    expect([...labelledMonths(YEAR, "2026-11", 3)]).toEqual([
      "2026-02",
      "2026-05",
      "2026-08",
      "2026-11",
    ])
  })

  it("labels a past year's months as this year's", () => {
    const past = YEAR.map((month) => month.replace("2026", "2025"))
    expect([...labelledMonths(past, "2026-11", 2)]).toEqual([
      "2025-01",
      "2025-03",
      "2025-05",
      "2025-07",
      "2025-09",
      "2025-11",
    ])
  })
})

describe("fitMonthLabels", () => {
  // The heatmap's narrowest week column: the desktop card (21 px) and a
  // phone at 390 px wide (25 px); a short month's name ("Sept") and the
  // space after it are 34 px wide.
  const WIDTH = 34
  const at = (pitch: number, columns: [string, number][]) =>
    columns.map(([month, column]) => ({ month, start: column * pitch }))

  it("names every month when the names fit", () => {
    for (const pitch of [21, 25]) {
      const months = at(pitch, [
        ["2026-08", 0],
        ["2026-09", 3],
        ["2026-10", 7],
      ])
      expect([...fitMonthLabels(months, "2026-10", WIDTH)]).toEqual([
        "2026-08",
        "2026-09",
        "2026-10",
      ])
    }
  })

  it("names this month and every second when two names are a column apart", () => {
    for (const pitch of [21, 25]) {
      const months = at(pitch, [
        ["2026-08", 0],
        ["2026-09", 1],
        ["2026-10", 5],
        ["2026-11", 9],
      ])
      const named = fitMonthLabels(months, "2026-11", WIDTH)
      expect([...named]).toEqual(["2026-09", "2026-11"])
      // No two names closer than a name's width.
      const starts = months.filter((m) => named.has(m.month)).map((m) => m.start)
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(WIDTH)
      }
    }
  })

  it("names only this month when no step fits", () => {
    const months = at(1, [
      ["2026-09", 0],
      ["2026-10", 1],
      ["2026-11", 2],
      ["2026-12", 3],
    ])
    expect([...fitMonthLabels(months, "2026-11", WIDTH)]).toEqual(["2026-11"])
  })
})
