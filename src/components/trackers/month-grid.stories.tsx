import React from "react"
import type { Series, SeriesState } from "../../data/tracker"
import { MonthGrid } from "./month-grid"
import { TodayStrip } from "./today-strip"

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

const SERIES: SeriesState[] = [
  stateOf(
    { target: 20, period: "month" },
    Object.fromEntries(
      [1, 2, 3, 5, 6, 8, 9, 10, 11, 12, 15, 16, 19, 20, 21, 22, 25, 26].map((d) => [
        `2026-10-${String(d).padStart(2, "0")}`,
        true,
      ]),
    ),
  ),
  stateOf(
    {
      id: "s2",
      name: "Run",
      kind: "number",
      colour: "blue",
      unit: "km",
      step: 0.5,
      target: 15,
      period: "week",
    },
    {
      "2026-10-04": 5,
      "2026-10-07": 3,
      "2026-10-11": 8,
      "2026-10-14": 4,
      "2026-10-19": 6,
      "2026-10-26": 5,
      "2026-10-27": 3,
    },
  ),
  stateOf(
    { id: "s3", name: "Water", kind: "number", colour: "cyan", unit: "glasses", max: 8, target: 8 },
    {
      "2026-10-20": 4,
      "2026-10-21": 8,
      "2026-10-22": 6,
      "2026-10-23": 2,
      "2026-10-26": 7,
      "2026-10-27": 3,
    },
  ),
  stateOf(
    { id: "s4", name: "Meditate", colour: "violet" },
    { "2026-10-25": true, "2026-10-26": true },
  ),
]

/** The tracker page's body as the route composes it: the Today strip over
 * the month grid, on live state so the story can be logged into. */
function Tracker({ series: initial, width }: { series: SeriesState[]; width: number }) {
  const [series, setSeries] = React.useState(initial)
  const [day, setDay] = React.useState(TODAY)
  const setEntry = (seriesId: string, date: string, value: boolean | number | null) =>
    setSeries((prev) =>
      prev.map((state) => {
        if (state.series.id !== seriesId) return state
        const entries = new Map(state.entries)
        if (value === null || value === false) entries.delete(date)
        else entries.set(date, { id: `${seriesId}-${date}`, date, value })
        return { ...state, entries }
      }),
    )
  return (
    <div className="flex flex-col gap-4 bg-bg p-4" style={{ width }}>
      <TodayStrip
        series={series}
        day={day}
        today={TODAY}
        onSetEntry={setEntry}
        onBackToToday={() => setDay(TODAY)}
      />
      <h2 className="font-bold">October 2026</h2>
      <MonthGrid
        series={series}
        month="2026-10"
        today={TODAY}
        selectedDay={day}
        onToggle={(seriesId, cellDay, done) => setEntry(seriesId, cellDay, done ? true : null)}
        onPickDay={(cellDay) => setDay(cellDay)}
      />
    </div>
  )
}

export default {
  title: "Trackers/Month grid",
  component: MonthGrid,
  parameters: { layout: "fullscreen" },
}

export const Desktop = {
  render: () => <Tracker series={SERIES} width={1024} />,
}

export const Phone = {
  render: () => <Tracker series={SERIES} width={375} />,
}

export const Empty = {
  render: () => <Tracker series={[]} width={375} />,
}
