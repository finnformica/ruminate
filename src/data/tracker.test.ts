import { describe, expect, it } from "vitest"
import {
  TRACKER_TYPE,
  buildGraphSnapshot,
  childIdsOf,
  parseProps,
  type GraphSnapshot,
} from "./graph"
import { applyOps, type Op } from "./ops"
import {
  addDays,
  addMonths,
  addSeriesOps,
  cellLevel,
  daysBetween,
  entryOf,
  formatAmount,
  isDone,
  isTracker,
  localDay,
  monthGrid,
  monthLabel,
  newTrackerOps,
  periodDays,
  removeSeriesOps,
  rollup,
  seriesOf,
  setEntryOps,
  stepValue,
  streak,
  targetProgress,
  trackerSeries,
  trackerEntryKeys,
  trackerSeriesKeys,
  updateSeriesOps,
  weekStart,
  weekdayFromMonday,
  type Series,
  type SeriesState,
} from "./tracker"

const NOW = 1000
const EMPTY = buildGraphSnapshot([], [])
const apply = (snapshot: GraphSnapshot, ops: Op[]) => applyOps(snapshot, ops, NOW)

const SERIES: Series = {
  id: "s1",
  name: "Run",
  kind: "number",
  colour: "blue",
  unit: "km",
  min: null,
  max: null,
  step: 1,
  target: null,
  period: "day",
  rollup: "sum",
}

/** A series with its entries, from `day → value`. */
function stateOf(series: Partial<Series>, logged: Record<string, boolean | number>): SeriesState {
  const entries = new Map(
    Object.entries(logged).map(([date, value], i) => [date, { id: `e${i}`, date, value }]),
  )
  return { series: { ...SERIES, ...series }, entries }
}

describe("days", () => {
  it("names the viewer's local day", () => {
    expect(localDay(new Date(2026, 9, 27, 23, 30))).toBe("2026-10-27")
    expect(localDay(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01")
  })

  it("steps days across month and year ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01")
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31")
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29")
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30)
    expect(daysBetween("2026-10-31", "2026-10-01")).toBe(-30)
  })

  it("steps months", () => {
    expect(addMonths("2026-10", 1)).toBe("2026-11")
    expect(addMonths("2026-12", 1)).toBe("2027-01")
    expect(addMonths("2026-01", -1)).toBe("2025-12")
    expect(addMonths("2026-01", -13)).toBe("2024-12")
  })

  it("starts the week on Monday", () => {
    // 2026-10-27 is a Tuesday.
    expect(weekdayFromMonday("2026-10-27")).toBe(1)
    expect(weekdayFromMonday("2026-10-26")).toBe(0)
    expect(weekdayFromMonday("2026-11-01")).toBe(6)
    expect(weekStart("2026-10-27")).toBe("2026-10-26")
    expect(weekStart("2026-11-01")).toBe("2026-10-26")
    expect(weekStart("2026-10-26")).toBe("2026-10-26")
  })

  it("labels a month in English", () => {
    expect(monthLabel("2026-10", "en-GB")).toBe("October 2026")
  })
})

describe("monthGrid", () => {
  it("lays October 2026 out Monday first, padded to whole weeks", () => {
    const grid = monthGrid("2026-10")
    // October 2026 begins on a Thursday and ends on a Saturday.
    expect(grid[0]).toEqual([
      null,
      null,
      null,
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ])
    expect(grid[grid.length - 1]).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      null,
    ])
    expect(grid).toHaveLength(5)
    expect(grid.flat().filter(Boolean)).toHaveLength(31)
  })

  it("puts a month that begins on Sunday in a sixth row", () => {
    // 2026-11-01 is a Sunday: six leading blanks, then 30 days.
    const grid = monthGrid("2026-11")
    expect(grid[0]).toEqual([null, null, null, null, null, null, "2026-11-01"])
    expect(grid).toHaveLength(6)
    expect(grid.every((row) => row.length === 7)).toBe(true)
  })

  it("fits February of a non-leap year that begins on Monday in four rows", () => {
    // 2027-02-01 is a Monday.
    const grid = monthGrid("2027-02")
    expect(grid).toHaveLength(4)
    expect(grid[0][0]).toBe("2027-02-01")
    expect(grid[3][6]).toBe("2027-02-28")
  })
})

describe("streak", () => {
  it("counts the days in a row up to today", () => {
    const state = stateOf(
      { kind: "check" },
      {
        "2026-10-25": true,
        "2026-10-26": true,
        "2026-10-27": true,
      },
    )
    expect(streak(state, "2026-10-27")).toBe(3)
  })

  it("keeps counting from yesterday while today is still open", () => {
    const state = stateOf({ kind: "check" }, { "2026-10-25": true, "2026-10-26": true })
    expect(streak(state, "2026-10-27")).toBe(2)
  })

  it("ends at a missed day", () => {
    const state = stateOf(
      { kind: "check" },
      {
        "2026-10-23": true,
        "2026-10-25": true,
        "2026-10-26": true,
      },
    )
    expect(streak(state, "2026-10-26")).toBe(2)
    expect(streak(state, "2026-10-28")).toBe(0)
  })

  it("for a number series needs a value, and the daily target when there is one", () => {
    const logged = { "2026-10-25": 5, "2026-10-26": 0, "2026-10-27": 3 }
    expect(streak(stateOf({}, logged), "2026-10-27")).toBe(1)
    const withTarget = stateOf({ target: 3, period: "day" }, { "2026-10-26": 3, "2026-10-27": 2 })
    expect(isDone(withTarget, "2026-10-26")).toBe(true)
    expect(isDone(withTarget, "2026-10-27")).toBe(false)
    expect(streak(withTarget, "2026-10-27")).toBe(1)
  })
})

describe("rollup", () => {
  const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]

  it("sums a number series", () => {
    const state = stateOf({ rollup: "sum" }, { "2026-10-01": 5, "2026-10-03": 2.5 })
    expect(rollup(state, days)).toBe(7.5)
  })

  it("averages over the days that have a value", () => {
    const state = stateOf({ rollup: "avg" }, { "2026-10-01": 5, "2026-10-03": 3 })
    expect(rollup(state, days)).toBe(4)
  })

  it("counts a check series's ticks", () => {
    const state = stateOf({ kind: "check" }, { "2026-10-01": true, "2026-10-04": true })
    expect(rollup(state, days)).toBe(2)
  })

  it("is null when nothing in the run was logged", () => {
    expect(rollup(stateOf({}, { "2026-09-30": 4 }), days)).toBeNull()
  })
})

describe("targetProgress", () => {
  it("is null without a target", () => {
    expect(targetProgress(stateOf({}, { "2026-10-27": 4 }), "2026-10-27")).toBeNull()
  })

  it("measures the day against a daily target", () => {
    const state = stateOf({ target: 10 }, { "2026-10-27": 4 })
    expect(targetProgress(state, "2026-10-27")).toEqual({
      value: 4,
      target: 10,
      period: "day",
      ratio: 0.4,
      met: false,
    })
  })

  it("measures the week from Monday against a weekly target", () => {
    const state = stateOf(
      { kind: "check", target: 3, period: "week" },
      {
        "2026-10-25": true, // Sunday before: not this week
        "2026-10-26": true,
        "2026-10-27": true,
      },
    )
    expect(periodDays("week", "2026-10-27")[0]).toBe("2026-10-26")
    expect(targetProgress(state, "2026-10-27")).toMatchObject({ value: 2, target: 3, met: false })
  })

  it("measures the month against a monthly target, and caps the ratio", () => {
    const state = stateOf({ target: 20, period: "month" }, { "2026-10-02": 15, "2026-10-20": 10 })
    expect(periodDays("month", "2026-10-27")).toHaveLength(31)
    expect(targetProgress(state, "2026-10-27")).toEqual({
      value: 25,
      target: 20,
      period: "month",
      ratio: 1,
      met: true,
    })
  })
})

describe("cells and amounts", () => {
  const days = ["2026-10-01", "2026-10-02", "2026-10-03"]

  it("draws a check on or off", () => {
    const state = stateOf({ kind: "check" }, { "2026-10-01": true })
    expect(cellLevel(state, "2026-10-01", days)).toBe(4)
    expect(cellLevel(state, "2026-10-02", days)).toBe(0)
  })

  it("scales a number against the series's max, else the month's best day", () => {
    const scaled = stateOf({ max: 8 }, { "2026-10-01": 2, "2026-10-02": 8 })
    expect(cellLevel(scaled, "2026-10-01", days)).toBe(1)
    expect(cellLevel(scaled, "2026-10-02", days)).toBe(4)
    const relative = stateOf({}, { "2026-10-01": 1, "2026-10-02": 4, "2026-10-03": 0 })
    expect(cellLevel(relative, "2026-10-01", days)).toBe(1)
    expect(cellLevel(relative, "2026-10-02", days)).toBe(4)
    expect(cellLevel(relative, "2026-10-03", days)).toBe(0)
  })

  it("formats an amount with its unit", () => {
    expect(formatAmount({ unit: "km" }, 5)).toBe("5 km")
    expect(formatAmount({ unit: "" }, 2.25)).toBe("2.3")
  })

  it("steps a value within min and max", () => {
    const series = { ...SERIES, step: 0.5, min: 0, max: 2 }
    expect(stepValue(series, 1, 1)).toBe(1.5)
    expect(stepValue(series, 2, 1)).toBe(2)
    expect(stepValue(series, 0, -1)).toBe(0)
    expect(stepValue({ ...SERIES, step: 0.1 }, 0.2, 1)).toBe(0.3)
  })
})

describe("reading blocks", () => {
  it("reads a series leniently, falling back on each malformed key", () => {
    expect(seriesOf({ id: "b", text: "Read", props: JSON.stringify({ kind: "check" }) })).toEqual({
      id: "b",
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
    })
    const odd = seriesOf({
      id: "b",
      text: "Run",
      props: JSON.stringify({
        kind: "number",
        colour: "mauve",
        unit: 3,
        step: -1,
        target: "5",
        period: "year",
        rollup: "avg",
        max: 10,
      }),
    })
    expect(odd).toMatchObject({ colour: "green", unit: "", step: 1, target: null, period: "day" })
    expect(odd).toMatchObject({ rollup: "avg", max: 10 })
    expect(seriesOf({ id: "b", text: "Plain", props: null })).toBeNull()
    expect(seriesOf({ id: "b", text: "x", props: JSON.stringify({ kind: "other" }) })).toBeNull()
  })

  it("reads an entry only with a day and a boolean or a finite number", () => {
    expect(
      entryOf({ id: "e", props: JSON.stringify({ date: "2026-10-27", value: true }) }),
    ).toEqual({ id: "e", date: "2026-10-27", value: true })
    expect(entryOf({ id: "e", props: JSON.stringify({ date: "2026-10-27", value: 2 }) })).toEqual({
      id: "e",
      date: "2026-10-27",
      value: 2,
    })
    expect(entryOf({ id: "e", props: JSON.stringify({ date: "27/10/2026", value: 2 }) })).toBeNull()
    expect(
      entryOf({ id: "e", props: JSON.stringify({ date: "2026-10-27", value: "2" }) }),
    ).toBeNull()
    expect(entryOf({ id: "e", props: null })).toBeNull()
  })
})

describe("writing the graph", () => {
  const tracker = () => apply(EMPTY, newTrackerOps(EMPTY, "t1", "Habits"))

  it("makes a tracker root with nothing under it", () => {
    const snapshot = tracker()
    expect(isTracker(snapshot, "t1")).toBe(true)
    expect(snapshot.nodes.get("t1")).toMatchObject({ type: TRACKER_TYPE, text: "Habits" })
    expect(trackerSeries(snapshot, "t1")).toEqual([])
    expect(newTrackerOps(snapshot, "t1", "Again")).toEqual([])
    const untitled = apply(EMPTY, newTrackerOps(EMPTY, "t2", "  "))
    expect(untitled.nodes.get("t2")?.text).toBe("t2")
  })

  it("adds a series as a child block with its keys, and reads it back", () => {
    let snapshot = tracker()
    snapshot = apply(snapshot, addSeriesOps(snapshot, "t1", "s1"))
    snapshot = apply(
      snapshot,
      addSeriesOps(snapshot, "t1", "s2", {
        name: "Run",
        kind: "number",
        colour: "blue",
        unit: "km",
        target: 5,
        period: "week",
        rollup: "sum",
        step: 0.5,
      }),
    )
    expect(childIdsOf(snapshot, "t1")).toEqual(["s1", "s2"])
    expect(snapshot.nodes.get("s2")?.notes_id).toBe("t1")
    expect(parseProps(snapshot.nodes.get("s2")?.props ?? null)).toEqual({
      kind: "number",
      colour: "blue",
      unit: "km",
      target: 5,
      period: "week",
      rollup: "sum",
      step: 0.5,
    })
    const states = trackerSeries(snapshot, "t1")
    expect(states.map((s) => s.series.name)).toEqual(["New series", "Run"])
    expect(states[0].series).toMatchObject({ kind: "check", colour: "green" })
    expect(states[1].series).toMatchObject({ kind: "number", unit: "km", target: 5, step: 0.5 })
    // Not a tracker, or an id in use: nothing.
    expect(addSeriesOps(EMPTY, "t1", "s9")).toEqual([])
    expect(addSeriesOps(snapshot, "t1", "s1")).toEqual([])
  })

  it("updates a series's name as text and its keys as props, clearing a null", () => {
    let snapshot = tracker()
    snapshot = apply(snapshot, addSeriesOps(snapshot, "t1", "s1", { target: 3, unit: "pages" }))
    const ops = updateSeriesOps(snapshot, "s1", { name: "Read", target: null, colour: "amber" })
    expect(ops.map((op) => op.op)).toEqual(["setText", "setProps"])
    snapshot = apply(snapshot, ops)
    expect(snapshot.nodes.get("s1")?.text).toBe("Read")
    expect(parseProps(snapshot.nodes.get("s1")?.props ?? null)).toEqual({
      kind: "check",
      colour: "amber",
      unit: "pages",
    })
    // The same again writes nothing.
    expect(updateSeriesOps(snapshot, "s1", { name: "Read", colour: "amber" })).toEqual([])
    // Not a series: nothing.
    expect(updateSeriesOps(snapshot, "t1", { name: "x" })).toEqual([])
  })

  it("logs a day as one entry per series, updates it in place, and clears it", () => {
    let snapshot = tracker()
    snapshot = apply(snapshot, addSeriesOps(snapshot, "t1", "s1"))
    snapshot = apply(snapshot, addSeriesOps(snapshot, "t1", "s2", { kind: "number" }))
    snapshot = apply(snapshot, setEntryOps(snapshot, "s1", "2026-10-27", true))
    snapshot = apply(snapshot, setEntryOps(snapshot, "s2", "2026-10-27", 4))
    let [check, number] = trackerSeries(snapshot, "t1")
    expect(check.entries.get("2026-10-27")?.value).toBe(true)
    expect(number.entries.get("2026-10-27")?.value).toBe(4)
    const entryId = check.entries.get("2026-10-27")!.id
    expect(snapshot.nodes.get(entryId)).toMatchObject({ type: "text", text: "", notes_id: "t1" })

    // A second value on the same day changes the entry, it does not add one.
    snapshot = apply(snapshot, setEntryOps(snapshot, "s2", "2026-10-27", 6))
    expect(childIdsOf(snapshot, "s2")).toHaveLength(1)
    // A check takes true only: a number on it is stored as a tick.
    snapshot = apply(snapshot, setEntryOps(snapshot, "s1", "2026-10-28", 7))
    ;[check, number] = trackerSeries(snapshot, "t1")
    expect(number.entries.get("2026-10-27")?.value).toBe(6)
    expect(check.entries.get("2026-10-28")?.value).toBe(true)

    // Clearing deletes the day's entry; false clears a check too.
    snapshot = apply(snapshot, setEntryOps(snapshot, "s2", "2026-10-27", null))
    snapshot = apply(snapshot, setEntryOps(snapshot, "s1", "2026-10-28", false))
    ;[check, number] = trackerSeries(snapshot, "t1")
    expect(number.entries.size).toBe(0)
    expect(check.entries.size).toBe(1)
    expect(snapshot.nodes.has(entryId)).toBe(true)
    // Clearing a day with nothing on it, a bad day, or a block that is not a
    // series: nothing.
    expect(setEntryOps(snapshot, "s2", "2026-10-27", null)).toEqual([])
    expect(setEntryOps(snapshot, "s2", "27 Oct", 1)).toEqual([])
    expect(setEntryOps(snapshot, "t1", "2026-10-27", 1)).toEqual([])
  })

  it("removes a series with every entry under it", () => {
    let snapshot = tracker()
    snapshot = apply(snapshot, addSeriesOps(snapshot, "t1", "s1"))
    snapshot = apply(snapshot, setEntryOps(snapshot, "s1", "2026-10-27", true))
    const entryId = childIdsOf(snapshot, "s1")[0]
    snapshot = apply(snapshot, removeSeriesOps(snapshot, "s1"))
    expect(snapshot.nodes.has("s1")).toBe(false)
    expect(snapshot.nodes.has(entryId)).toBe(false)
    expect(childIdsOf(snapshot, "t1")).toEqual([])
    expect(removeSeriesOps(snapshot, "t1")).toEqual([])
  })
})

describe("the key schemas", () => {
  it("accept the keys the app writes", () => {
    expect(
      trackerSeriesKeys.safeParse({
        kind: "number",
        colour: "blue",
        unit: "km",
        min: 0,
        max: 10,
        step: 0.5,
        target: 5,
        period: "week",
        rollup: "avg",
      }).success,
    ).toBe(true)
    expect(trackerEntryKeys.safeParse({ date: "2026-10-27", value: true }).success).toBe(true)
    expect(trackerEntryKeys.safeParse({ date: "2026-10-27", value: 2.5 }).success).toBe(true)
  })

  it("reject a bad kind, colour, period, rollup, step, date or value", () => {
    expect(trackerSeriesKeys.safeParse({ kind: "habit" }).success).toBe(false)
    expect(trackerSeriesKeys.safeParse({ colour: "mauve" }).success).toBe(false)
    expect(trackerSeriesKeys.safeParse({ period: "year" }).success).toBe(false)
    expect(trackerSeriesKeys.safeParse({ rollup: "max" }).success).toBe(false)
    expect(trackerSeriesKeys.safeParse({ step: 0 }).success).toBe(false)
    expect(trackerSeriesKeys.safeParse({ target: "5" }).success).toBe(false)
    expect(trackerEntryKeys.safeParse({ date: "27/10/2026" }).success).toBe(false)
    expect(trackerEntryKeys.safeParse({ value: "yes" }).success).toBe(false)
  })
})
