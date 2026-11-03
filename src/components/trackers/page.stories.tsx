import React from "react"
import { addDays, rangeLabel, type Entry, type Series, type SeriesState } from "../../data/tracker"
import { cx } from "../../utils/cx"
import { ActivityCard, TrackerStats } from "./activity"
import { DayDialog } from "./day-dialog"
import type { TrackerView } from "./display-groups"
import { MonthGrid } from "./month-grid"
import { TodayStrip } from "./today-strip"

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
  goal: "do",
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

/** Three series to keep, two or three of them on some days, so the Recent
 * list has days with more than one entry; and one to avoid. */
const SERIES: SeriesState[] = [
  stateOf({ id: "swim", name: "Swim", target: 120, period: "week" }, [
    [0, 34, "34 min · 1km front crawl"],
    [3, 30, "30 min"],
    [8, 40, "40 min"],
    [15, 35, "35 min"],
    [22, 30, "30 min"],
  ]),
  stateOf({ id: "run", name: "Run", colour: "orange", unit: "km" }, [
    [0, 5, "5 km · 33 mins"],
    [3, 5, "5 km"],
    [9, 8, "8 km · long one"],
    [13, 5, "5 km"],
    [20, 6, "6 km"],
    [30, 5, "5 km"],
  ]),
  stateOf({ id: "gym", name: "Gym", kind: "check", colour: "blue" }, [
    [0, true, "Upper body push + pull"],
    [1, true],
    [2, true],
    [3, true],
    [5, true],
    [10, true],
    [12, true],
    [17, true],
    [24, true],
    [40, true],
  ]),
  // A habit to avoid: its stats count clean days, and a slip wears a cross.
  stateOf({ id: "scroll", name: "Doomscroll", kind: "check", colour: "red", goal: "avoid" }, [
    [2, true],
    [6, true],
    [7, true],
    [19, true],
  ]),
]

/** The tracker page's body as the route composes it: the stats row, the
 * Today strip, then the activity card beside the month's cards. A narrow
 * window shows one of the two, as the ⋯ menu's display options pick. */
function Page({ view = "heatmap", open = null }: { view?: TrackerView; open?: string | null }) {
  const [series, setSeries] = React.useState(SERIES)
  const [day, setDay] = React.useState(TODAY)
  const [openDay, setOpenDay] = React.useState<string | null>(open)
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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 bg-bg p-4">
      <TrackerStats series={series} today={TODAY} />
      <TodayStrip
        series={series}
        day={day}
        today={TODAY}
        onSetEntry={setEntry}
        onDayChange={setDay}
      />
      <div className="flex min-w-0 flex-col gap-4">
        <ActivityCard
          series={series}
          today={TODAY}
          onOpenDay={setOpenDay}
          className={cx(view === "cards" && "max-lg:hidden")}
        />
        <div
          className={cx(
            "flex min-w-0 flex-1 flex-col gap-4",
            view === "heatmap" && "max-lg:hidden",
          )}
        >
          <h2 className="font-bold">{rangeLabel("month", TODAY)}</h2>
          <MonthGrid series={series} start={TODAY} today={TODAY} onOpenDay={setOpenDay} />
        </div>
      </div>
      <DayDialog
        series={series}
        day={openDay}
        today={TODAY}
        onSetEntry={setEntry}
        onDayChange={setOpenDay}
        onClose={() => setOpenDay(null)}
      />
    </div>
  )
}

export default {
  title: "Trackers/Page",
  parameters: { layout: "fullscreen" },
}

/** At 1024 px or wider, the activity card over the cards; narrower, the
 * heatmap. */
export const Desktop = {
  render: () => <Page />,
}

/** A narrow window with **Cards** picked in the ⋯ menu. */
export const NarrowCards = {
  render: () => <Page view="cards" />,
}

/** The day editor open on yesterday, as a tap on its heatmap day opens it. */
export const DayEditor = {
  render: () => <Page open={addDays(TODAY, -1)} />,
}
