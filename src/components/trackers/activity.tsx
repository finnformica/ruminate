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
  weekdayFromMonday,
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
 * The tracker at a glance (docs/trackers.md, Finn 2026-10-29): a row of
 * stats, a heatmap of the last weeks, and the newest entries.
 * A day is active when any series has something on it (`isLogged`); every
 * number is computed here from the series the page already holds.
 */

/**
 * The stats row at the top of the page (Finn, 2026-11-02): the streak, the
 * active days in the last 7 and the last 28, and all time, each a label over
 * its value. It takes the place of the summary line and its streak badge,
 * with the same numbers (`activeSummary`).
 */
export function TrackerStats({
  series,
  today,
}: {
  series: readonly SeriesState[]
  today: DayString
}) {
  const summary = React.useMemo(() => activeSummary(series, today), [series, today])
  const days = (n: number) => (n === 1 ? "day" : "days")
  const stats: { label: string; value: string; unit?: string; title: string }[] = [
    {
      label: "Streak",
      value: String(summary.streak),
      unit: days(summary.streak),
      title: "Active days in a row",
    },
    { label: "Last 7 days", value: `${summary.lastWeek}/7`, title: "Active days in the last 7" },
    {
      label: "Last 28 days",
      value: `${summary.lastFourWeeks}/28`,
      title: `Active days in the last 28: ${Math.round((summary.lastFourWeeks / 28) * 100)}%`,
    },
    {
      label: "All time",
      value: String(summary.allTime),
      unit: days(summary.allTime),
      title: "Active days up to today",
    },
  ]
  return (
    <dl data-testid="tracker-stats" className="flex flex-wrap gap-x-6 gap-y-2 sm:gap-x-8">
      {stats.map(({ label, value, unit, title }) => (
        <div key={label} title={title} className="flex flex-col gap-1">
          <dt className="whitespace-nowrap text-sm leading-4 text-text-secondary">{label}</dt>
          <dd className="whitespace-nowrap text-lg font-bold leading-6">
            {value}
            {unit ? <span className="text-sm font-normal text-text-secondary"> {unit}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
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

/** The width the week columns share at their narrowest: the card beside the
 * range on a desktop (`lg:w-80`), less the day axis. At 390 px wide the card
 * is wider, so month names that fit here fit a phone too. */
const HEATMAP_MIN_WIDTH = 262

/** The gap between columns and between rows, the one value for both. */
const HEATMAP_GAP = 4

/** A month's short name at its widest ("Sept", four letters at 11 px) and
 * room to spare: two names, each centred over its divider, at least this
 * far apart never touch. */
const HEATMAP_LABEL_WIDTH = 34

/** A weekday's name on the day axis: 10 px of text (`text-[10px]
 * leading-none`) and 2 px clear of the next. */
const AXIS_LABEL_PITCH = 12

/** The weekdays the day axis names, 0 for Monday: all seven when a row is
 * tall enough for each name, else Mon, Wed and Fri, as a paper calendar's
 * margin does; today's always. `cellSize` is a cell's measured side, or
 * null before it is measured. */
export function axisWeekdays(cellSize: number | null, todayWeekday: number): Set<number> {
  const all = cellSize === null || cellSize + HEATMAP_GAP >= AXIS_LABEL_PITCH
  const shown = new Set(all ? [0, 1, 2, 3, 4, 5, 6] : [0, 2, 4])
  if (todayWeekday >= 0) shown.add(todayWeekday)
  return shown
}

/** A heatmap column: a week, or the part of a week in one month. A day of
 * the other month is null, drawn as a placeholder. */
type HeatmapColumn = { month: MonthString; days: (DayString | null)[] }

/**
 * The heatmap's columns (Finn, 2026-11-02): a column a week, but a week that
 * runs into a new month is split in two, its old month's days on the left
 * and its new month's on the right, each with placeholders for the other's
 * days. The line between two months is then straight.
 */
export function heatmapColumns(weeks: readonly DayString[][]): HeatmapColumn[] {
  const columns: HeatmapColumn[] = []
  for (const week of weeks) {
    const split = week.findIndex((day, d) => d > 0 && monthOf(day) !== monthOf(week[d - 1]))
    if (split < 0) {
      columns.push({ month: monthOf(week[0]), days: [...week] })
      continue
    }
    columns.push({
      month: monthOf(week[0]),
      days: week.map((day, d) => (d < split ? day : null)),
    })
    columns.push({
      month: monthOf(week[split]),
      days: week.map((day, d) => (d >= split ? day : null)),
    })
  }
  return columns
}

/** The track a divider stands in, between two months' columns: with the
 * gap each side of it, the line has room to breathe (Finn, 2026-11-02).
 * About a letter of an 11 px name wide, so a name that starts at its left
 * edge has its first letter over the line. */
const DIVIDER_TRACK = 6

/** A placeholder's lines: its outline and its stripes, both 0.5 px in one
 * solid colour (Finn, 2026-11-02). Solid, not one of the theme's alpha
 * borders: an alpha colour drawn where a stripe meets the outline adds up
 * and shows a brighter spot. */
const PLACEHOLDER_LINE = "var(--neutral-6)"
const STRIPES: React.CSSProperties = {
  borderColor: PLACEHOLDER_LINE,
  backgroundImage: `repeating-linear-gradient(135deg, ${PLACEHOLDER_LINE} 0 0.5px, transparent 0.5px 4px)`,
}

/**
 * The heatmap: one column a week, one row a weekday from Monday, the week
 * today is in at the right edge (`heatmapWeeks`). A cell is a rounded
 * square filled in the colour of the series logged that day, split into
 * bands when there is more than one. Today has a ring, its weekday is named
 * in bold and a dot sits under its column; the days of this week still to
 * come have a dashed outline. A week that runs into a new month is split in
 * two columns (`heatmapColumns`), the other month's days drawn as hollow
 * striped placeholders (no data), so one straight line divides the months: a
 * single element in a narrow track of its own between the two months, from
 * the Monday row down to Sunday, with the month's name above it. A month
 * whose first day is in the heatmap is named; the month the heatmap opens
 * in has no divider, and is named over its first column only when the
 * heatmap opens on its 1st. Every month when the names fit, else this month
 * and every second or third (month-labels.ts, as the Grid's year does;
 * Finn, 2026-11-02). The day axis names every weekday when a row is tall
 * enough, else Mon, Wed and Fri (`axisWeekdays`). The columns share the
 * width, so twelve weeks fit a phone with no sideways scroll. It is for
 * reading: the Today strip and the range view log. Below it, a legend of
 * the series.
 */
function ActivityHeatmap({ series, today }: { series: readonly SeriesState[]; today: DayString }) {
  const columns = React.useMemo(() => heatmapColumns(heatmapWeeks(today)), [today])
  // Each month and the column it starts in.
  const starts = React.useMemo(
    () =>
      columns.flatMap((column, c) =>
        c === 0 || column.month !== columns[c - 1].month
          ? [{ month: column.month, column: c }]
          : [],
      ),
    [columns],
  )
  // The grid's tracks: the day axis, then each column, with a divider's
  // track before each month's first column. `track[c]` is column c's.
  const { template, track } = React.useMemo(() => {
    const parts = ["auto"]
    const track: number[] = []
    columns.forEach((column, c) => {
      if (c > 0 && column.month !== columns[c - 1].month) parts.push(`${DIVIDER_TRACK}px`)
      parts.push("minmax(0, 1fr)")
      track.push(parts.length)
    })
    return { template: parts.join(" "), track }
  }, [columns])
  const dividers = starts.length - 1
  // The months named: those whose first day, and so whose divider, is in
  // the heatmap. The month the heatmap opens in is named only when it opens
  // on the 1st (Finn, 2026-11-02).
  const named = React.useMemo(() => {
    const room = HEATMAP_MIN_WIDTH + HEATMAP_GAP - dividers * (DIVIDER_TRACK + HEATMAP_GAP)
    const pitch = room / columns.length
    const shown = starts.filter(({ column }) => column > 0 || columns[0].days[0]?.endsWith("-01"))
    return fitMonthLabels(
      shown.map(({ month, column }) => ({
        month,
        start: column * pitch + (track[column] - 2 - column) * (DIVIDER_TRACK + HEATMAP_GAP),
      })),
      monthOf(today),
      HEATMAP_LABEL_WIDTH,
    )
  }, [starts, columns, track, dividers, today])
  const todayWeekday = weekdayFromMonday(today)

  // A cell's width, which the columns set: each weekday's row is made as
  // tall, so the gap down is the gap across and the cells are square in any
  // engine (Finn, 2026-11-02). A row left to an `aspect-square` cell alone
  // can come out taller in WebKit. The width also tells whether every
  // weekday's name fits beside a row.
  const grid = React.useRef<HTMLDivElement>(null)
  const [cellSize, setCellSize] = React.useState<number | null>(null)
  React.useLayoutEffect(() => {
    const cell = grid.current?.querySelector<HTMLElement>("[data-day]")
    if (!cell || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setCellSize(cell.getBoundingClientRect().width))
    observer.observe(cell)
    return () => observer.disconnect()
  }, [columns])
  const weekdays = axisWeekdays(cellSize, todayWeekday)

  // Every item has its place: rows are the names (1), Monday to Sunday (2
  // to 8) and today's dot (9).
  const at = (column: number, row: number | string): React.CSSProperties => ({
    gridColumn: column,
    gridRow: row,
  })
  return (
    <div className="flex flex-col gap-3">
      <div
        ref={grid}
        role="grid"
        aria-label="Active days, by week"
        data-testid="activity-heatmap"
        className="grid items-center"
        style={{
          gap: HEATMAP_GAP,
          gridTemplateColumns: template,
          gridTemplateRows: cellSize === null ? undefined : `auto repeat(7, ${cellSize}px) auto`,
        }}
      >
        {/* The names: over its divider for a month that starts in the
            heatmap, over the first column for the month it opens on. */}
        <div role="row" className="contents">
          {starts.map(({ month, column }) =>
            named.has(month) ? (
              <div
                key={month}
                role="columnheader"
                aria-label={monthShortLabel(month)}
                data-month-label={month}
                // Over a divider, the name starts at its track's left edge:
                // the track is about a letter wide, so the first letter sits
                // over the line, and the name reads on to the right.
                className="overflow-visible whitespace-nowrap text-[11px] leading-4 text-text-secondary"
                style={at(column > 0 ? track[column] - 1 : track[column], 1)}
              >
                {monthShortLabel(month)}
              </div>
            ) : null,
          )}
        </div>
        {WEEKDAY_NAMES.map((weekday, d) => (
          <div key={weekday} role="row" aria-label={weekday} className="contents">
            <div
              role="rowheader"
              aria-label={weekday}
              data-weekday={d}
              className={cx(
                // No height of its own: the row is a cell high, so rows are
                // as far apart as columns and the cells read as squares.
                "flex h-0 items-center self-center pr-1 text-[10px] leading-none tabular-nums",
                d === todayWeekday ? "font-bold text-text" : "text-text-secondary",
              )}
              style={at(1, d + 2)}
            >
              {weekdays.has(d) ? WEEKDAY_SHORT[d] : null}
            </div>
            {columns.map((column, c) => {
              const day = column.days[d]
              if (day === null) {
                // Another month's day, in a split week: holds the place as a
                // hollow square, a hairline outline with hairline stripes
                // inside in the same solid colour, and no fill (Finn,
                // 2026-11-02).
                return (
                  <div
                    key={`${c}-${d}`}
                    role="gridcell"
                    aria-hidden
                    data-placeholder
                    className="aspect-square rounded-sm border-[0.5px]"
                    style={{ ...at(track[c], d + 2), ...STRIPES }}
                  />
                )
              }
              const on = seriesOnDay(series, day)
              const future = day > today
              const label = `${dayLabel(day)}: ${
                future
                  ? "to come"
                  : on.map((s) => s.name.trim() || "Untitled").join(", ") || "nothing"
              }`
              return (
                <div
                  key={day}
                  role="gridcell"
                  aria-label={label}
                  aria-current={day === today ? "date" : undefined}
                  title={label}
                  data-day={day}
                  data-series={on.length}
                  className={cx(
                    "aspect-square rounded-sm",
                    future ? "border border-dashed border-border" : "bg-bg-secondary",
                    day === today && "ring-2 ring-text-secondary",
                  )}
                  style={{
                    ...at(track[c], d + 2),
                    ...(future ? undefined : cellFill(on.map((s) => s.colour))),
                  }}
                />
              )
            })}
          </div>
        ))}
        {/* A line between two months: one element in its own track, from
            the Monday row down to Sunday, under the month's name. */}
        {starts.slice(1).map(({ month, column }) => (
          <div
            key={month}
            aria-hidden
            data-month-divider={month}
            className="w-px self-stretch justify-self-center bg-border"
            style={at(track[column] - 1, "2 / 9")}
          />
        ))}
        {/* Under today's column, a dot: where you are. */}
        {columns.map((column, c) =>
          column.days.includes(today) ? (
            <div
              key={c}
              aria-hidden
              data-testid="heatmap-today-mark"
              data-column={c}
              className="flex h-1.5 justify-center"
              style={at(track[c], 9)}
            >
              <span className="size-1.5 rounded-full bg-text-secondary" />
            </div>
          ) : null,
        )}
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

/** How many days the Recent list shows at first, and how many more each
 * **Show more** adds. */
const RECENT_DAYS = 5
const MORE_DAYS = 10

/**
 * The newest entries (`recentEntries`), newest first, a group a day (Finn,
 * 2026-11-02): the day named once at the left, then a line per series
 * logged on it, with the entry's text after the day (muted, wrapping). A
 * divider runs between two days, never inside one. Five days, and **Show
 * more** for the rest.
 */
function RecentEntries({ series, today }: { series: readonly SeriesState[]; today: DayString }) {
  const days = React.useMemo(() => {
    const groups: { day: DayString; entries: ReturnType<typeof recentEntries> }[] = []
    for (const item of recentEntries(series, today)) {
      const last = groups[groups.length - 1]
      if (last?.day === item.entry.date) last.entries.push(item)
      else groups.push({ day: item.entry.date, entries: [item] })
    }
    return groups
  }, [series, today])
  const [shown, setShown] = React.useState(RECENT_DAYS)
  return (
    <section className="flex flex-col gap-2" aria-labelledby="tracker-recent">
      <h2 id="tracker-recent" className="font-bold leading-4">
        Recent
      </h2>
      {days.length === 0 ? (
        <p className="text-sm text-text-secondary">Nothing logged yet.</p>
      ) : (
        <ul data-testid="recent-entries" className="flex flex-col">
          {days.slice(0, shown).map(({ day, entries }) => (
            <li
              key={day}
              data-recent-day={day}
              className="flex gap-3 border-t border-border-secondary py-2 first:border-t-0"
            >
              <span className="w-14 shrink-0 text-text-secondary tabular-nums">
                {shortDayLabel(day)}
              </span>
              <ul aria-label={dayLabel(day)} className="flex min-w-0 flex-1 flex-col gap-1">
                {entries.map(({ series: s, entry }) => (
                  <li key={entry.id} className="break-words">
                    <span className="inline-flex items-center gap-2 align-baseline">
                      <ColourDot colour={s.colour} />
                      {s.name.trim() || "Untitled"}
                    </span>
                    {entry.detail ? (
                      <span className="text-text-secondary"> · {entry.detail}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {days.length > shown ? (
        <Button size="small" className="self-start" onClick={() => setShown(shown + MORE_DAYS)}>
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
