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
  entryText,
  formatAmount,
  isDone,
  isTracker,
  localDay,
  monthGrid,
  monthLabel,
  newTrackerOps,
  periodDays,
  rangeDays,
  rangeLabel,
  rangeStart,
  removeSeriesOps,
  rollup,
  seriesOf,
  setEntryOps,
  shiftRange,
  stepValue,
  streak,
  targetProgress,
  trackerSeries,
  trackerSeriesKeys,
  updateSeriesOps,
  weekStart,
  weekdayFromMonday,
  yearDays,
  yearWeeks,
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

describe("ranges", () => {
  it("shows a week of seven days from Monday", () => {
    // 2026-10-28 is a Wednesday; its week runs Monday 26 Oct to Sunday 1 Nov.
    expect(rangeStart("week", "2026-10-28")).toBe("2026-10-26")
    expect(rangeDays("week", "2026-10-28")).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ])
    // A Sunday belongs to the week before it, and a Monday starts its own.
    expect(rangeStart("week", "2026-11-01")).toBe("2026-10-26")
    expect(rangeStart("week", "2026-11-02")).toBe("2026-11-02")
    // A week that crosses the new year.
    expect(rangeDays("week", "2027-01-01")[0]).toBe("2026-12-28")
    expect(rangeDays("week", "2027-01-01")[6]).toBe("2027-01-03")
    expect(rangeLabel("week", "2026-10-28")).toBe("26 Oct – 1 Nov 2026")
  })

  it("shows a month as every day of it", () => {
    expect(rangeStart("month", "2026-10-28")).toBe("2026-10-01")
    const october = rangeDays("month", "2026-10-28")
    expect(october).toHaveLength(31)
    expect(october[30]).toBe("2026-10-31")
    expect(rangeDays("month", "2026-11-15")).toHaveLength(30)
    expect(rangeLabel("month", "2026-10-28")).toBe("October 2026")
  })

  it("shows a year as 365 days, or 366 in a leap year", () => {
    expect(rangeStart("year", "2026-10-28")).toBe("2026-01-01")
    const year = rangeDays("year", "2026-10-28")
    expect(year).toHaveLength(365)
    expect(year[0]).toBe("2026-01-01")
    expect(year[364]).toBe("2026-12-31")
    expect(rangeLabel("year", "2026-10-28")).toBe("2026")
    // 2028 is a leap year: 29 February is in it. 2100 is not (a century).
    expect(yearDays(2028)).toHaveLength(366)
    expect(yearDays(2028)).toContain("2028-02-29")
    expect(yearDays(2100)).toHaveLength(365)
    expect(yearDays(2000)).toHaveLength(366)
  })

  it("moves by the range shown", () => {
    expect(shiftRange("week", "2026-10-28", 1)).toBe("2026-11-02")
    expect(shiftRange("week", "2026-10-28", -1)).toBe("2026-10-19")
    expect(shiftRange("month", "2026-10-28", 1)).toBe("2026-11-01")
    expect(shiftRange("month", "2026-01-31", -1)).toBe("2025-12-01")
    expect(shiftRange("year", "2028-02-29", 1)).toBe("2029-01-01")
    expect(shiftRange("year", "2026-10-28", -1)).toBe("2025-01-01")
  })

  it("lays a year out in weeks from Monday for the compact card", () => {
    // 2026 begins on a Thursday: three blanks lead the first week.
    const weeks = yearWeeks(2026)
    expect(weeks[0]).toEqual([
      null,
      null,
      null,
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ])
    expect(weeks).toHaveLength(53)
    expect(weeks.every((week) => week.length === 7)).toBe(true)
    expect(weeks.flat().filter(Boolean)).toHaveLength(365)
    // 2028 is a leap year that begins on a Saturday.
    expect(yearWeeks(2028).flat().filter(Boolean)).toHaveLength(366)
    expect(yearWeeks(2028)[0][5]).toBe("2028-01-01")
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

  it("reads a check entry from a to-do whose text is the day", () => {
    expect(entryOf({ id: "e", type: "done", text: "2026-10-27", props: null }, "check")).toEqual({
      id: "e",
      date: "2026-10-27",
      value: true,
    })
    expect(entryOf({ id: "e", type: "todo", text: " 2026-10-27 ", props: null }, "check")).toEqual({
      id: "e",
      date: "2026-10-27",
      value: false,
    })
    // A plain row with a day, a to-do with other text, or a bad day: not an
    // entry.
    expect(entryOf({ id: "e", type: "text", text: "2026-10-27", props: null }, "check")).toBeNull()
    expect(entryOf({ id: "e", type: "done", text: "Read a book", props: null }, "check")).toBeNull()
    expect(entryOf({ id: "e", type: "done", text: "27/10/2026", props: null }, "check")).toBeNull()
    expect(entryOf({ id: "e", type: "done", text: "2026-10-27x", props: null }, "check")).toBeNull()
  })

  it("reads a number entry from a row that begins with the day and carries a number", () => {
    const read = (text: string, type = "text") =>
      entryOf({ id: "e", type, text, props: null }, "number")
    expect(read("2026-10-27 · 5 km")).toEqual({ id: "e", date: "2026-10-27", value: 5 })
    expect(read("2026-10-27 · 2.5 km")).toEqual({ id: "e", date: "2026-10-27", value: 2.5 })
    expect(read("2026-10-27: 3,5")).toEqual({ id: "e", date: "2026-10-27", value: 3.5 })
    expect(read("2026-10-27 ran 8km", "ul")).toEqual({ id: "e", date: "2026-10-27", value: 8 })
    expect(read("2026-10-27")).toBeNull()
    expect(read("2026-10-27 · km")).toBeNull()
    expect(read("ran 5 km on 2026-10-27")).toBeNull()
    expect(entryText({ unit: "km" }, "2026-10-27", 5)).toBe("2026-10-27 · 5 km")
    expect(entryText({ unit: "" }, "2026-10-27", 2.25)).toBe("2026-10-27 · 2.3")
  })

  it("still reads an entry written before the text shape from its props", () => {
    const props = (date: string, value: unknown) => JSON.stringify({ date, value })
    expect(
      entryOf({ id: "e", type: "text", text: "", props: props("2026-10-27", true) }, "check"),
    ).toEqual({ id: "e", date: "2026-10-27", value: true })
    expect(
      entryOf({ id: "e", type: "text", text: "", props: props("2026-10-27", 2) }, "number"),
    ).toEqual({ id: "e", date: "2026-10-27", value: 2 })
    expect(
      entryOf({ id: "e", type: "text", text: "", props: props("2026-10-27", 2) }, "check"),
    ).toBeNull()
    expect(
      entryOf({ id: "e", type: "text", text: "", props: props("27/10/2026", 2) }, "number"),
    ).toBeNull()
    expect(entryOf({ id: "e", type: "text", text: "", props: null }, "number")).toBeNull()
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
    // A series is a bullet block, so its name shows as a normal bullet.
    expect(snapshot.nodes.get("s1")?.type).toBe("ul")
    expect(snapshot.nodes.get("s2")?.type).toBe("ul")
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

  it("reads a series written as a plain text block, from before series were bullets", () => {
    let snapshot = tracker()
    snapshot = apply(snapshot, [
      {
        op: "create",
        id: "s1",
        type: "text",
        text: "Read",
        props: JSON.stringify({ kind: "check", colour: "amber" }),
        notesId: "t1",
      },
      { op: "link", source: "t1", destination: "s1", sortKey: "a0" },
    ])
    expect(
      seriesOf({ id: "s1", text: "Read", props: snapshot.nodes.get("s1")?.props ?? null }),
    ).not.toBeNull()
    const states = trackerSeries(snapshot, "t1")
    expect(states).toHaveLength(1)
    expect(states[0].series).toMatchObject({ name: "Read", kind: "check", colour: "amber" })
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

  it("logs a check as a ticked to-do whose text is the day, and opens it to clear", () => {
    let snapshot = tracker()
    snapshot = apply(snapshot, addSeriesOps(snapshot, "t1", "s1"))
    snapshot = apply(snapshot, setEntryOps(snapshot, "s1", "2026-10-27", true))
    const [entryId] = childIdsOf(snapshot, "s1")
    expect(snapshot.nodes.get(entryId)).toMatchObject({
      type: "done",
      text: "2026-10-27",
      props: null,
      notes_id: "t1",
    })
    expect(trackerSeries(snapshot, "t1")[0].entries.get("2026-10-27")?.value).toBe(true)
    // Ticking again writes nothing; clearing opens the to-do and keeps the row.
    expect(setEntryOps(snapshot, "s1", "2026-10-27", true)).toEqual([])
    const clear = setEntryOps(snapshot, "s1", "2026-10-27", null)
    expect(clear).toEqual([{ op: "setType", id: entryId, type: "todo" }])
    snapshot = apply(snapshot, clear)
    expect(trackerSeries(snapshot, "t1")[0].entries.get("2026-10-27")?.value).toBe(false)
    expect(isDone(trackerSeries(snapshot, "t1")[0], "2026-10-27")).toBe(false)
    // A number on a check is a tick; clearing a day with no row writes nothing.
    snapshot = apply(snapshot, setEntryOps(snapshot, "s1", "2026-10-28", 7))
    expect(snapshot.nodes.get(childIdsOf(snapshot, "s1")[1])).toMatchObject({ type: "done" })
    expect(setEntryOps(snapshot, "s1", "2026-10-29", false)).toEqual([])
  })

  it("logs a number as a row of the day and the value, rewrites it, and deletes it to clear", () => {
    let snapshot = tracker()
    snapshot = apply(snapshot, addSeriesOps(snapshot, "t1", "s2", { kind: "number", unit: "km" }))
    snapshot = apply(snapshot, setEntryOps(snapshot, "s2", "2026-10-27", 4))
    const [entryId] = childIdsOf(snapshot, "s2")
    expect(snapshot.nodes.get(entryId)).toMatchObject({
      type: "text",
      text: "2026-10-27 · 4 km",
      props: null,
    })
    // A second value on the same day rewrites the row, it does not add one.
    snapshot = apply(snapshot, setEntryOps(snapshot, "s2", "2026-10-27", 6.5))
    expect(childIdsOf(snapshot, "s2")).toEqual([entryId])
    expect(snapshot.nodes.get(entryId)?.text).toBe("2026-10-27 · 6.5 km")
    expect(trackerSeries(snapshot, "t1")[0].entries.get("2026-10-27")?.value).toBe(6.5)
    expect(setEntryOps(snapshot, "s2", "2026-10-27", 6.5)).toEqual([])
    // Clearing deletes the row.
    snapshot = apply(snapshot, setEntryOps(snapshot, "s2", "2026-10-27", null))
    expect(childIdsOf(snapshot, "s2")).toEqual([])
    expect(setEntryOps(snapshot, "s2", "2026-10-27", null)).toEqual([])
    expect(setEntryOps(snapshot, "s2", "27 Oct", 1)).toEqual([])
    expect(setEntryOps(snapshot, "t1", "2026-10-27", 1)).toEqual([])
  })

  it("keeps the entries under a series in date order", () => {
    let snapshot = tracker()
    snapshot = apply(snapshot, addSeriesOps(snapshot, "t1", "s1"))
    for (const day of ["2026-10-27", "2026-10-20", "2026-10-25", "2026-10-28", "2026-10-01"]) {
      snapshot = apply(snapshot, setEntryOps(snapshot, "s1", day, true))
    }
    const texts = childIdsOf(snapshot, "s1").map((id) => snapshot.nodes.get(id)?.text)
    expect(texts).toEqual(["2026-10-01", "2026-10-20", "2026-10-25", "2026-10-27", "2026-10-28"])
  })

  it("leaves a row it cannot read out of the grid, as an ordinary row", () => {
    let snapshot = tracker()
    snapshot = apply(snapshot, addSeriesOps(snapshot, "t1", "s2", { kind: "number" }))
    snapshot = apply(snapshot, [
      {
        op: "create",
        id: "note1",
        type: "text",
        text: "Knee felt fine",
        props: null,
        notesId: "t1",
      },
      { op: "link", source: "s2", destination: "note1", sortKey: "a0" },
    ])
    snapshot = apply(snapshot, setEntryOps(snapshot, "s2", "2026-10-27", 3))
    const [state] = trackerSeries(snapshot, "t1")
    expect(state.entries.size).toBe(1)
    expect(childIdsOf(snapshot, "s2")).toHaveLength(2)
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
  })

  it("reject a bad kind, colour, period, rollup or step", () => {
    expect(trackerSeriesKeys.safeParse({ kind: "habit" }).success).toBe(false)
    expect(trackerSeriesKeys.safeParse({ colour: "mauve" }).success).toBe(false)
    expect(trackerSeriesKeys.safeParse({ period: "year" }).success).toBe(false)
    expect(trackerSeriesKeys.safeParse({ rollup: "max" }).success).toBe(false)
    expect(trackerSeriesKeys.safeParse({ step: 0 }).success).toBe(false)
    expect(trackerSeriesKeys.safeParse({ target: "5" }).success).toBe(false)
  })
})
