import React from "react"
import {
  activeSummary,
  dayLabel,
  heatmapWeeks,
  monthOf,
  monthShortLabel,
  recentEntries,
  seriesOnDay,
  shortDayLabel,
  type DayString,
  type MonthString,
  type SeriesState,
  type TrackerColour,
} from "../../data/tracker"
import { cx } from "../../utils/cx"
import { Button } from "../ui/button"
import { Surface } from "../ui/surface"
import { ColourDot, colourVar } from "./month-grid"
import { fitMonthLabels } from "./month-labels"

/**
 * The tracker at a glance (docs/trackers.md, Finn 2026-10-29): a summary
 * line of active days, a heatmap of the last weeks, and the newest entries.
 * A day is active when any series has something on it (`isLogged`); every
 * number is computed here from the series the page already holds.
 */

/** The summary line at the top of the page: the streak as a pill, then the
 * active days in the last 7, the last 28 and all time. */
export function ActivitySummary({
  series,
  today,
}: {
  series: readonly SeriesState[]
  today: DayString
}) {
  const summary = React.useMemo(() => activeSummary(series, today), [series, today])
  return (
    <p
      data-testid="activity-summary"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary tabular-nums"
    >
      {summary.streak > 0 ? (
        <span className="inline-flex h-6 items-center rounded-full border border-border px-2 text-text">
          {summary.streak}-day streak
        </span>
      ) : null}
      <span>
        {summary.lastWeek} of the last 7 days · {summary.lastFourWeeks} of the last 28 ·{" "}
        {summary.allTime} all time
      </span>
    </p>
  )
}

/** A cell's fill for the colours of the series on its day: the one colour,
 * or the colours side by side in diagonal bands. */
function cellFill(colours: readonly TrackerColour[]): React.CSSProperties | undefined {
  if (colours.length === 0) return undefined
  if (colours.length === 1) return { backgroundColor: colourVar(colours[0], 9) }
  const band = 100 / colours.length
  const stops = colours.map(
    (colour, i) => `${colourVar(colour, 9)} ${i * band}% ${(i + 1) * band}%`,
  )
  return { backgroundImage: `linear-gradient(135deg, ${stops.join(", ")})` }
}

const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const

const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const

/** The weekdays named on the day axis, as a paper calendar's margin does;
 * today's is named too. */
const AXIS_WEEKDAYS = new Set([0, 2, 4])

/** The narrowest a week's column is, with the gap after it: the card beside
 * the range on a desktop (`lg:w-80`), less the day axis. At 390 px wide the
 * card is wider (25 px), so names that fit here fit a phone too. */
const HEATMAP_MIN_PITCH = 21

/** A month's short name at its widest ("Sept", four letters of text-xs)
 * and the space after it. */
const HEATMAP_LABEL_WIDTH = 34

/** Each month in the heatmap and the week column its name starts over: the
 * week its first day falls in, or the first column for the month the
 * heatmap opens in. */
function heatmapMonths(weeks: readonly DayString[][]): { month: MonthString; column: number }[] {
  const months = [{ month: monthOf(weeks[0][0]), column: 0 }]
  weeks.forEach((week, w) => {
    for (const day of week) {
      if (day.endsWith("-01") && day !== weeks[0][0])
        months.push({ month: monthOf(day), column: w })
    }
  })
  return months
}

/**
 * The heatmap: one column a week, one row a weekday from Monday, the week
 * today is in at the right edge (`heatmapWeeks`). A cell is filled in the
 * colour of the series logged that day, split into bands when there is more
 * than one. Today has a ring, its weekday is named in bold and a dot sits
 * under its week; the days of this week still to come have a dashed
 * outline. A stepped line in the gaps between cells divides the months, and
 * each month is named over the week it starts in: every month when the
 * names fit, else this month and every second or third (month-labels.ts,
 * as the Grid's year does; Finn, 2026-11-02). Mon, Wed and Fri are named on
 * the day axis. The columns share the width, so twelve weeks fit a phone
 * with no sideways scroll. It is for reading: the Today strip and the range
 * view log. Below it, a legend of the series.
 */
function ActivityHeatmap({ series, today }: { series: readonly SeriesState[]; today: DayString }) {
  const weeks = React.useMemo(() => heatmapWeeks(today), [today])
  const months = React.useMemo(() => {
    const all = heatmapMonths(weeks)
    const labelled = fitMonthLabels(
      all.map(({ month, column }) => ({ month, start: column * HEATMAP_MIN_PITCH })),
      monthOf(today),
      HEATMAP_LABEL_WIDTH,
    )
    return all.filter(({ month }) => labelled.has(month))
  }, [weeks, today])
  const todayWeekday = weeks[weeks.length - 1].indexOf(today)
  const columns = `auto repeat(${weeks.length}, minmax(0, 1fr))`
  return (
    <div className="flex flex-col gap-3">
      <div
        role="grid"
        aria-label="Active days, by week"
        data-testid="activity-heatmap"
        className="grid items-center gap-1"
        style={{ gridTemplateColumns: columns }}
      >
        <div role="row" className="contents">
          <div aria-hidden />
          {weeks.map((_, w) => {
            const named = months.find((entry) => entry.column === w)
            return (
              <div
                key={w}
                role="columnheader"
                aria-label={named ? monthShortLabel(named.month) : undefined}
                data-month-label={named?.month}
                className="overflow-visible whitespace-nowrap text-xs leading-4 text-text-secondary"
              >
                {named ? monthShortLabel(named.month) : null}
              </div>
            )
          })}
        </div>
        {WEEKDAY_NAMES.map((weekday, d) => (
          <div key={weekday} role="row" aria-label={weekday} className="contents">
            <div
              role="rowheader"
              aria-label={weekday}
              data-weekday={d}
              className={cx(
                "pr-1 text-[10px] leading-none tabular-nums",
                d === todayWeekday ? "font-bold text-text" : "text-text-secondary",
              )}
            >
              {AXIS_WEEKDAYS.has(d) || d === todayWeekday ? WEEKDAY_SHORT[d] : null}
            </div>
            {weeks.map((week, w) => {
              const day = week[d]
              const on = seriesOnDay(series, day)
              const future = day > today
              const label = `${dayLabel(day)}: ${
                future
                  ? "to come"
                  : on.map((s) => s.name.trim() || "Untitled").join(", ") || "nothing"
              }`
              // A month starts here: its line runs in the gap to the left
              // (the week before has the old month on this weekday) and
              // above (the day before, in this column, was the old month).
              const left = w > 0 && monthOf(weeks[w - 1][d]) !== monthOf(day)
              const top = d > 0 && monthOf(week[d - 1]) !== monthOf(day)
              return (
                <div
                  key={day}
                  role="gridcell"
                  aria-label={label}
                  aria-current={day === today ? "date" : undefined}
                  title={label}
                  data-day={day}
                  data-series={on.length}
                  data-divider={left && top ? "both" : left ? "left" : top ? "top" : undefined}
                  className={cx(
                    "relative aspect-square rounded",
                    future ? "border border-dashed border-border" : "bg-bg-secondary",
                    day === today && "ring-2 ring-text-secondary",
                    left &&
                      "before:absolute before:-bottom-[3px] before:-left-[3px] before:-top-[3px] before:w-px before:bg-border",
                    top &&
                      "after:absolute after:-left-[3px] after:-right-[3px] after:-top-[3px] after:h-px after:bg-border",
                  )}
                  style={future ? undefined : cellFill(on.map((s) => s.colour))}
                />
              )
            })}
          </div>
        ))}
        {/* Under today's week, a dot: where you are. */}
        <div aria-hidden className="contents">
          <div />
          {weeks.map((week, w) => (
            <div key={w} className="flex h-1.5 justify-center">
              {week.includes(today) ? (
                <span
                  data-testid="heatmap-today-mark"
                  className="size-1.5 rounded-full bg-text-secondary"
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
      {series.length > 0 ? (
        <ul
          aria-label="Series"
          className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-secondary"
        >
          {series.map(({ series: s }) => (
            <li key={s.id} className="flex min-w-0 items-center gap-2">
              <ColourDot colour={s.colour} />
              <span className="truncate">{s.name.trim() || "Untitled"}</span>
            </li>
          ))}
          {series.length > 1 ? (
            <li className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={cellFill(series.slice(0, 2).map((s) => s.series.colour))}
              />
              <span>More than one</span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

/** How many rows the Recent list shows at first, and how many more each
 * **Show more** adds. */
const RECENT_ROWS = 5
const MORE_ROWS = 10

/**
 * The newest entries (`recentEntries`), a row each: the day, the series and
 * the entry's text after the day (muted, wrapping), newest first. Five rows,
 * and **Show more** for the rest.
 */
function RecentEntries({ series, today }: { series: readonly SeriesState[]; today: DayString }) {
  const entries = React.useMemo(() => recentEntries(series, today), [series, today])
  const [shown, setShown] = React.useState(RECENT_ROWS)
  return (
    <section className="flex flex-col gap-2" aria-labelledby="tracker-recent">
      <h2 id="tracker-recent" className="font-bold leading-4">
        Recent
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-text-secondary">Nothing logged yet.</p>
      ) : (
        <ul data-testid="recent-entries" className="flex flex-col">
          {entries.slice(0, shown).map(({ series: s, entry }) => (
            <li
              key={entry.id}
              className="flex gap-3 border-t border-border-secondary py-2 first:border-t-0"
            >
              <span className="w-14 shrink-0 text-text-secondary tabular-nums">
                {shortDayLabel(entry.date)}
              </span>
              <p className="min-w-0 flex-1 break-words">
                <span className="inline-flex items-center gap-2 align-baseline">
                  <ColourDot colour={s.colour} />
                  {s.name.trim() || "Untitled"}
                </span>
                {entry.detail ? (
                  <span className="text-text-secondary"> · {entry.detail}</span>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      )}
      {entries.length > shown ? (
        <Button size="small" className="self-start" onClick={() => setShown(shown + MORE_ROWS)}>
          Show more
        </Button>
      ) : null}
    </section>
  )
}

/** The heatmap and the Recent list on one card: the phone's default view,
 * and a column beside the range on a wider screen. */
export function ActivityCard({
  series,
  today,
  className,
}: {
  series: readonly SeriesState[]
  today: DayString
  className?: string
}) {
  return (
    <Surface
      tier="card"
      motion={false}
      data-testid="activity-card"
      className={cx("flex flex-col gap-4 p-4", className)}
    >
      <ActivityHeatmap series={series} today={today} />
      <RecentEntries series={series} today={today} />
    </Surface>
  )
}
