import { describe, expect, it } from "vitest"
import { MONTH_LABEL_HEIGHT, labelledMonths, yearLabelStep } from "./month-labels"

const YEAR = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`)
const DAYS_IN = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate()

/** The journal grid's row: a 32 px cell and 2 px between rows, the same at
 * 390 px wide as on a desktop. */
const PITCH = 34
/** The divider's space above a month: `mt-2` and a 1 px border. */
const DIVIDER = 9

describe("yearLabelStep", () => {
  it("labels every second month at the grid's row height", () => {
    expect(yearLabelStep(PITCH)).toBe(2)
  })

  it("skips more months when rows are too short to keep two names apart", () => {
    expect(yearLabelStep(0.5)).toBe(3)
  })
})

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

  it("keeps two names at least a name's height apart at any scroll", () => {
    // Where each month starts and ends down the grid, as drawn: a label row
    // when it has a name, then a row a day.
    const step = yearLabelStep(PITCH)
    for (const current of YEAR) {
      const labelled = labelledMonths(YEAR, current, step)
      let y = 0
      const spans: { top: number; end: number }[] = []
      for (const [i, month] of YEAR.entries()) {
        const top = y + (i > 0 ? DIVIDER : 0)
        const end = top + (labelled.has(month) ? MONTH_LABEL_HEIGHT : 0) + DAYS_IN(month) * PITCH
        // A name sticks only inside its own month: from its place down to
        // the month's end, never into the next one.
        if (labelled.has(month)) spans.push({ top, end })
        y = end
      }
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i].top - spans[i - 1].end).toBeGreaterThanOrEqual(MONTH_LABEL_HEIGHT)
      }
    }
  })
})
