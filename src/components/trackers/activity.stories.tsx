import React from "react"
import { addDays, type Entry, type Series, type SeriesState } from "../../data/tracker"
import { ActivityCard, ActivitySummary } from "./activity"

/** A Thursday, so the heatmap's last column has days still to come. */
const TODAY = "2026-10-29"

const BASE: Series = {
  id: "s1",
  name: "Swim",
  kind: "number",
  colour: "green",
  unit: "min",
  min: null,
  max: null,
  step: 1,
  target: null,
  period: "day",
  rollup: "sum",
}

/** A series with entries `ago` days before today, each with its value and
 * the entry's text after the day. */
function stateOf(
  series: Partial<Series>,
  logged: [ago: number, value: boolean | number, detail?: string][],
): SeriesState {
  const id = series.id ?? BASE.id
  const entries = new Map<string, Entry>(
    logged.map(([ago, value, detail]) => {
      const date = addDays(TODAY, -ago)
      return [date, { id: `${id}-${date}`, date, value, ...(detail ? { detail } : {}) }]
    }),
  )
  return { series: { ...BASE, ...series }, entries }
}

const SERIES: SeriesState[] = [
  stateOf({ id: "swim", name: "Swim" }, [
    [0, 34, "34 min · 1km (50 lengths) front crawl in the outdoor pool"],
    [3, 30, "30 min"],
    [8, 40, "40 min"],
    [15, 35, "35 min"],
    [22, 30, "30 min"],
  ]),
  stateOf({ id: "run", name: "Run", colour: "orange", unit: "km" }, [
    [2, 5, "5 km · 33 mins"],
    [6, 5, "5 km"],
    [9, 8, "8 km · long one"],
    [13, 5, "5 km"],
    [20, 6, "6 km"],
    [30, 5, "5 km"],
  ]),
  stateOf({ id: "gym", name: "Gym", kind: "check", colour: "blue" }, [
    [1, true, "Upper body push + pull"],
    [3, true],
    [5, true],
    [10, true],
    [12, true],
    [17, true],
    [24, true],
    [40, true],
  ]),
]

function Activity({ series, width }: { series: SeriesState[]; width: number }) {
  return (
    <div className="flex flex-col gap-4 bg-bg p-4" style={{ width }}>
      <ActivitySummary series={series} today={TODAY} />
      <ActivityCard series={series} today={TODAY} />
    </div>
  )
}

export default {
  title: "Trackers/Activity",
  component: ActivityCard,
  parameters: { layout: "fullscreen" },
}

export const Phone = {
  render: () => <Activity series={SERIES} width={390} />,
}

export const Column = {
  render: () => <Activity series={SERIES} width={352} />,
}

export const OneSeries = {
  render: () => <Activity series={SERIES.slice(0, 1)} width={390} />,
}

export const Empty = {
  render: () => <Activity series={[]} width={390} />,
}
