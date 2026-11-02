import type { MonthString } from "../../data/tracker"

/** The steps the labels may thin by, fewest skipped first. */
const STEPS = [2, 3] as const

/**
 * The months that get a label, out of `months` in order: the current month,
 * then every `step`th month either side of it. A range without the current
 * month labels the same months of the year.
 */
export function labelledMonths(
  months: readonly MonthString[],
  current: MonthString,
  step: number,
): Set<MonthString> {
  if (months.length === 0) return new Set()
  let anchor = months.indexOf(current)
  if (anchor < 0) anchor = months.findIndex((month) => month.slice(5) === current.slice(5))
  if (anchor < 0) anchor = months.length - 1
  return new Set(months.filter((_, i) => (((i - anchor) % step) + step) % step === 0))
}

/**
 * The months that get a label on an axis that runs across the page, as the
 * heatmap's weeks do (Finn, 2026-11-02): each month's name starts at
 * `start` px and is `width` px wide. Every month, when the names fit; else
 * the current month and every second, else every third, from it
 * (`labelledMonths`): the first step whose names are each at least `width`
 * apart. Only the current month is named when none fits.
 */
export function fitMonthLabels(
  months: readonly { month: MonthString; start: number }[],
  current: MonthString,
  width: number,
): Set<MonthString> {
  const all = months.map((entry) => entry.month)
  for (const step of [1, ...STEPS]) {
    const labelled = labelledMonths(all, current, step)
    const starts = months.filter((entry) => labelled.has(entry.month)).map((entry) => entry.start)
    if (starts.every((start, i) => i === 0 || start - starts[i - 1] >= width)) return labelled
  }
  return new Set(all.includes(current) ? [current] : [])
}
