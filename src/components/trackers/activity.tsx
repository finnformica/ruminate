import React from "react"
import {
  activeSummary,
  addDays,
  cleanSummary,
  dayLabel,
  heatmapWeeks,
  monthOf,
  monthShortLabel,
  recentEntries,
  seriesOnDay,
  shortDayLabel,
  trackingStart,
  weekdayFromMonday,
  type ActiveSummary,
  type DayString,
  type MonthString,
  type SeriesState,
  type TrackerColour,
} from "../../data/tracker"
import { cx } from "../../utils/cx"
import { Button } from "../ui/button"
import { Surface } from "../ui/surface"
import {
  AvoidTag,
  ColourDot,
  DAY_RADIUS,
  DaySquare,
  colourVar,
  dayRadius,
  pieFill,
} from "./month-grid"
import { fitMonthLabels } from "./month-labels"

/**
 * The tracker at a glance (docs/trackers.md, Finn 2026-10-29): a row of
 * stats, a heatmap of the last weeks, and the newest entries.
 * A day is active when any series to keep has something on it
 * (`isLogged`); a series to avoid counts its clean days. Every number is
 * computed here from the series the page already holds.
 */

/**
 * The stats row at the top of the page (Finn, 2026-11-02): the streak, the
 * active days in the last 7 and the last 28, and all time, each a label over
 * its value. It takes the place of the summary line and its streak badge,
 * with the same numbers (`activeSummary`).
 *
 * A series to avoid (`goal: avoid`, Finn 2026-11-03) is left out of those
 * and has a group of its own, named with its dot and **Avoid**: the same
 * four stats counted in clean days (`cleanSummary`), from the tracker's
 * first entry. With a group to avoid on the row, the first group is named
 * **Active days**.
 */
export function TrackerStats({
  series,
  today,
}: {
  series: readonly SeriesState[]
  today: DayString
}) {
  const groups = React.useMemo(() => {
    const avoid = series.filter((state) => state.series.goal === "avoid")
    const start = trackingStart(series)
    const out: { key: string; name: string | null; state?: SeriesState; summary: ActiveSummary }[] =
      []
    if (avoid.length < series.length) {
      out.push({ key: "active", name: null, summary: activeSummary(series, today) })
    }
    for (const state of avoid) {
      out.push({
        key: state.series.id,
        name: state.series.name.trim() || "Untitled",
        state,
        summary: cleanSummary(state, start, today),
      })
    }
    return out
  }, [series, today])
  const named = groups.length > 1
  return (
    <div data-testid="tracker-stats" className="flex flex-wrap gap-x-10 gap-y-4">
      {groups.map(({ key, name, state, summary }) => (
        <section
          key={key}
          aria-label={name === null ? "Active days" : `${name}, avoid`}
          data-stats-group={key}
          className="flex flex-col gap-2"
        >
          {named ? (
            <h2 className="flex items-center gap-2 text-sm leading-4 font-bold">
              {state ? (
                <>
                  <ColourDot colour={state.series.colour} />
                  <span className="truncate">{name}</span>
                  <AvoidTag />
                </>
              ) : (
                "Active days"
              )}
            </h2>
          ) : null}
          <StatList summary={summary} avoiding={name} />
        </section>
      ))}
    </div>
  )
}

/** One group's four stats: active days, or with `avoiding` (the series's
 * name) the clean days without it. */
function StatList({ summary, avoiding }: { summary: ActiveSummary; avoiding: string | null }) {
  const days = (n: number) => (n === 1 ? "day" : "days")
  const clean = avoiding !== null
  const what = clean ? `Days without ${avoiding}` : "Active days"
  const stats: { label: string; value: string; unit?: string; title: string }[] = [
    {
      label: "Streak",
      value: String(summary.streak),
      unit: clean ? `${days(summary.streak)} clean` : days(summary.streak),
      title: `${what} in a row`,
    },
    {
      label: "Last 7 days",
      value: `${summary.lastWeek}/7`,
      unit: clean ? "clean" : undefined,
      title: `${what} in the last 7`,
    },
    {
      label: "Last 28 days",
      value: `${summary.lastFourWeeks}/28`,
      unit: clean ? "clean" : undefined,
      title: `${what} in the last 28: ${Math.round((summary.lastFourWeeks / 28) * 100)}%`,
    },
    {
      label: "All time",
      value: String(summary.allTime),
      unit: clean ? `${days(summary.allTime)} clean` : days(summary.allTime),
      title: clean ? `${what} since the first entry` : `${what} up to today`,
    },
  ]
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 sm:gap-x-8">
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

/** How strongly a placeholder takes the colours of its day: a faint wash,
 * so the real day beside it still stands out. */
const PLACEHOLDER_TINT = 22

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

/** The width the week columns share at their narrowest, less the day axis:
 * what the month names are fitted to before a cell is measured. Once it is,
 * the names are fitted to the measured column, which is wider on a phone
 * and far wider on a desktop. */
const HEATMAP_MIN_WIDTH = 262

/** The gap between columns and between rows, the one value for both. */
const HEATMAP_GAP = 4

/** From this width of the grid up, the heatmap is drawn for a large
 * screen, not as a phone's grown larger (Finn, 2026-11-03): its text at the
 * cards' sizes and a thicker line between months. The grid's width, not a
 * cell's: the names' size sets the day axis's width and so a cell's, never
 * the grid's. A phone's grid is about 330 px wide, a desktop's about 680. */
const LARGE_GRID = 480

/** A line of text trimmed to its capitals and its baseline, so the card's
 * padding is the space seen above the month names and below the legend, as
 * at the sides (Finn, 2026-11-03: the label rows "centre their text in tall
 * containers"). An engine without `text-box` keeps the line's own height. */
const TRIM_TEXT = "[text-box:trim-both_cap_alphabetic]"

/**
 * The heatmap's text and lines at each size. `labelWidth` is a month's short
 * name at its widest ("Sept", four letters) and room to spare: two names,
 * each centred over its divider, at least this far apart never touch.
 */
const HEATMAP_SIZES = {
  small: {
    month: "text-[11px] leading-4",
    weekday: "pr-1 text-[10px]",
    legend: "text-sm",
    divider: "w-px",
    labelWidth: 34,
  },
  large: {
    month: "text-sm leading-5",
    weekday: "pr-2 text-sm",
    legend: "text-base",
    divider: "w-0.5",
    labelWidth: 44,
  },
} as const

/** A weekday's name on the day axis: 10 px of text (`text-[10px]
 * leading-none`) and 2 px clear of the next. */
const AXIS_LABEL_PITCH = 12

/** How far each arrow key moves the focus in the heatmap, in days: a row is
 * a weekday and a column a week. */
const ARROW_STEPS: Record<string, number> = {
  ArrowUp: -1,
  ArrowDown: 1,
  ArrowLeft: -7,
  ArrowRight: 7,
}

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
 * the other month is null, drawn as a placeholder; `week` is the whole
 * week, so a placeholder knows which day it holds the place of. */
type HeatmapColumn = { month: MonthString; days: (DayString | null)[]; week: DayString[] }

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
      columns.push({ month: monthOf(week[0]), days: [...week], week: [...week] })
      continue
    }
    columns.push({
      month: monthOf(week[0]),
      days: week.map((day, d) => (d < split ? day : null)),
      week: [...week],
    })
    columns.push({
      month: monthOf(week[split]),
      days: week.map((day, d) => (d >= split ? day : null)),
      week: [...week],
    })
  }
  return columns
}

/** The track a divider stands in, between two months' columns: with the
 * gap each side of it, the line has room to breathe (Finn, 2026-11-02).
 * About a letter of an 11 px name wide, so a name that starts at its left
 * edge has its first letter over the line. */
const DIVIDER_TRACK = 6

/** A cell's side on a phone, where the dashes and stripes were first drawn:
 * at this size or smaller they keep that look, and on a larger cell they
 * grow with it, so a desktop cell does not look dense (Finn, 2026-11-03). */
const PHONE_CELL = 16

/** How much larger than a phone's a cell is, never less than 1. */
function cellScale(cellSize: number | null): number {
  return cellSize === null ? 1 : Math.max(1, cellSize / PHONE_CELL)
}

/** A placeholder's lines: its outline and its stripes, in one solid colour
 * (Finn, 2026-11-02). Solid, not one of the theme's alpha borders: an alpha
 * colour drawn where a stripe meets the outline adds up and shows a
 * brighter spot. The outline stays a 0.5 px hairline; the stripes, 0.5 px
 * every 4 px on a phone, grow with the cell (`cellScale`). */
const PLACEHOLDER_LINE = "var(--neutral-6)"
function stripes(scale: number): string {
  const line = 0.5 * scale
  const period = 4 * scale
  return `repeating-linear-gradient(135deg, ${PLACEHOLDER_LINE} 0 ${line}px, transparent ${line}px ${period}px)`
}

/**
 * A placeholder's look: the outline and the stripes over a faint wash of
 * the colours of the day it holds the place of (Finn, 2026-11-03), so what
 * was logged on a split week's days reads across the month's divider. One
 * colour is a flat wash; more are a pie, as a day's own fill is (`pieFill`).
 */
function placeholderStyle(colours: readonly TrackerColour[], scale: number): React.CSSProperties {
  const lines = stripes(scale)
  const tint = pieFill(
    colours.map(
      (colour) => `color-mix(in srgb, ${colourVar(colour, 9)} ${PLACEHOLDER_TINT}%, transparent)`,
    ),
  )
  return {
    borderColor: PLACEHOLDER_LINE,
    backgroundColor: tint?.backgroundColor,
    backgroundImage: tint?.backgroundImage ? `${lines}, ${tint.backgroundImage}` : lines,
  }
}

/** A day still to come: a dashed outline, 1 px wide, inside the day
 * square's rounded corners (`DAY_RADIUS`). A CSS dashed border has dashes of a fixed length, so the
 * outline is an SVG rect, its dashes and gaps 3 px on a phone and grown
 * with the cell (`cellScale`). The count is rounded so they go evenly round
 * the square, with no short dash where the line meets its start. */
const FUTURE_DASH = 3
function FutureOutline({ cellSize }: { cellSize: number | null }) {
  const side = (cellSize ?? PHONE_CELL) - 1
  const dash = FUTURE_DASH * cellScale(cellSize)
  const dashes = Math.max(4, Math.round((4 * side) / (2 * dash)))
  return (
    <svg aria-hidden data-future-outline className="pointer-events-none absolute inset-0 size-full">
      <rect
        x={0.5}
        y={0.5}
        width={side}
        height={side}
        rx={DAY_RADIUS * (side + 1) - 0.5}
        pathLength={2 * dashes}
        strokeDasharray="1 1"
        className="fill-none stroke-border"
        strokeWidth={1}
      />
    </svg>
  )
}

/**
 * The heatmap: one column a week, one row a weekday from Monday, the week
 * today is in at the right edge (`heatmapWeeks`). A cell is a rounded
 * square filled in the colour of the series logged that day, a pie of
 * equal slices when there is more than one (`pieFill`). Today has a ring,
 * its weekday and its month are named in bold and a dot sits under its
 * column; the days of this week still to come have a faint grey fill and a
 * dashed outline. A week that runs into a new month is split in
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
 * width, so twelve weeks fit a phone with no sideways scroll, and on a
 * desktop the cells grow to fill the card. A tap on a day up to today opens
 * the day editor on it (`onOpenDay`, Finn 2026-11-03); the arrow keys move
 * between days, one tab stop for the grid. A slip on a series to avoid
 * wears a cross. Below it, a legend of the series.
 */
function ActivityHeatmap({
  series,
  today,
  onOpenDay,
}: {
  series: readonly SeriesState[]
  today: DayString
  onOpenDay?: (day: DayString) => void
}) {
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
  // A cell's width, which the columns set: each weekday's row is made as
  // tall, so the gap down is the gap across and the cells are square in any
  // engine (Finn, 2026-11-02). A row left to an `aspect-square` cell alone
  // can come out taller in WebKit. The width also tells whether every
  // weekday's name fits beside a row.
  const grid = React.useRef<HTMLDivElement>(null)
  const [cellSize, setCellSize] = React.useState<number | null>(null)
  const [gridWidth, setGridWidth] = React.useState<number | null>(null)
  React.useLayoutEffect(() => {
    const cell = grid.current?.querySelector<HTMLElement>("[data-day]")
    if (!grid.current || !cell || typeof ResizeObserver === "undefined") return
    const whole = grid.current
    const observer = new ResizeObserver(() => {
      setCellSize(cell.getBoundingClientRect().width)
      setGridWidth(whole.getBoundingClientRect().width)
    })
    observer.observe(cell)
    observer.observe(whole)
    return () => observer.disconnect()
  }, [columns])
  const size = HEATMAP_SIZES[gridWidth !== null && gridWidth >= LARGE_GRID ? "large" : "small"]
  // The months named: those whose first day, and so whose divider, is in
  // the heatmap. The month the heatmap opens in is named only when it opens
  // on the 1st (Finn, 2026-11-02).
  const named = React.useMemo(() => {
    // A column and its gap: measured, else what the narrowest card leaves.
    const room = HEATMAP_MIN_WIDTH + HEATMAP_GAP - dividers * (DIVIDER_TRACK + HEATMAP_GAP)
    const pitch = cellSize === null ? room / columns.length : cellSize + HEATMAP_GAP
    const shown = starts.filter(({ column }) => column > 0 || columns[0].days[0]?.endsWith("-01"))
    return fitMonthLabels(
      shown.map(({ month, column }) => ({
        month,
        start: column * pitch + (track[column] - 2 - column) * (DIVIDER_TRACK + HEATMAP_GAP),
      })),
      monthOf(today),
      size.labelWidth,
    )
  }, [starts, columns, track, dividers, today, cellSize, size])
  const todayWeekday = weekdayFromMonday(today)

  // One tab stop: the day last moved to, today at first. The arrows move a
  // day up or down, a week left or right, within the heatmap and up to
  // today.
  const [focusDay, setFocusDay] = React.useState(today)
  const firstDay = columns[0].week[0]
  const tabDay = focusDay >= firstDay && focusDay <= today ? focusDay : today
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = ARROW_STEPS[event.key]
    const from = (event.target as HTMLElement).dataset.day
    if (step === undefined || !from) return
    event.preventDefault()
    const next = addDays(from, step)
    if (next < firstDay || next > today) return
    setFocusDay(next)
    grid.current?.querySelector<HTMLElement>(`[data-day="${next}"]`)?.focus()
  }

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
        data-size={size === HEATMAP_SIZES.large ? "large" : "small"}
        className="grid items-center"
        // Focusable for its keys, but not a tab stop: its days are.
        tabIndex={-1}
        onKeyDown={onKeyDown}
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
                className={cx(
                  "overflow-visible whitespace-nowrap",
                  TRIM_TEXT,
                  size.month,
                  month === monthOf(today) ? "font-bold text-text" : "text-text-secondary",
                )}
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
                "flex h-0 items-center self-center leading-none tabular-nums",
                size.weekday,
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
                // inside in the same solid colour (Finn, 2026-11-02), over a
                // faint wash of the colours of the day it stands for (Finn,
                // 2026-11-03).
                const held = column.week[d]
                const colours = held > today ? [] : seriesOnDay(series, held).map((s) => s.colour)
                return (
                  <div
                    key={`${c}-${d}`}
                    role="gridcell"
                    aria-hidden
                    data-placeholder
                    data-tint={colours.length}
                    className="aspect-square border-[0.5px]"
                    style={{
                      ...at(track[c], d + 2),
                      borderRadius: dayRadius,
                      ...placeholderStyle(colours, cellScale(cellSize)),
                    }}
                  />
                )
              }
              const on = seriesOnDay(series, day)
              const slip = on.find((s) => s.goal === "avoid")
              const future = day > today
              const label = `${dayLabel(day)}: ${
                future
                  ? "to come"
                  : on
                      .map(
                        (s) =>
                          `${s.name.trim() || "Untitled"}${s.goal === "avoid" ? " (avoid)" : ""}`,
                      )
                      .join(", ") || "nothing"
              }`
              return (
                <div
                  key={day}
                  role="gridcell"
                  className="aspect-square"
                  style={{ ...at(track[c], d + 2), borderRadius: dayRadius }}
                >
                  <DaySquare
                    aria-label={label}
                    aria-haspopup="dialog"
                    title={label}
                    data-day={day}
                    data-series={on.length}
                    disabled={future || !onOpenDay}
                    tabIndex={day === tabDay ? 0 : -1}
                    onClick={() => onOpenDay?.(day)}
                    onFocus={() => setFocusDay(day)}
                    today={day === today}
                    toCome={future ? "outline" : undefined}
                    colours={future ? [] : on.map((s) => colourVar(s.colour, 9))}
                    slip={slip?.colour}
                  >
                    {future ? <FutureOutline cellSize={cellSize} /> : null}
                  </DaySquare>
                </div>
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
            className={cx("self-stretch justify-self-center bg-border", size.divider)}
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
          className={cx("flex flex-wrap gap-x-4 gap-y-2 text-text-secondary", size.legend)}
        >
          {series.map(({ series: s }) => (
            <li key={s.id} className="flex min-w-0 items-center gap-2">
              <ColourDot colour={s.colour} />
              <span className={cx("overflow-x-clip text-ellipsis whitespace-nowrap", TRIM_TEXT)}>
                {s.name.trim() || "Untitled"}
              </span>
              {s.goal === "avoid" ? <AvoidTag /> : null}
            </li>
          ))}
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

/** The heatmap and the Recent list on one card: the phone's default view.
 * On a desktop (`lg`) the card runs the page's width over the cards, the
 * heatmap two thirds of it and the Recent list beside it, so the heatmap's
 * cells are large (Finn, 2026-11-03). The heatmap sets the card's height:
 * the Recent list fills it and scrolls within it, so a long list adds no
 * space under the heatmap (Finn, 2026-11-03: "too much vertical padding
 * inside the Heatmap container"). */
export function ActivityCard({
  series,
  today,
  onOpenDay,
  className,
}: {
  series: readonly SeriesState[]
  today: DayString
  /** A day was tapped in the heatmap: open the day editor on it. */
  onOpenDay?: (day: DayString) => void
  className?: string
}) {
  return (
    <Surface
      tier="card"
      motion={false}
      data-testid="activity-card"
      className={cx("flex flex-col gap-4 p-4 lg:flex-row lg:gap-8", className)}
    >
      <div data-testid="activity-heatmap-column" className="min-w-0 lg:flex-[2] lg:self-start">
        <ActivityHeatmap series={series} today={today} onOpenDay={onOpenDay} />
      </div>
      {/* On a desktop the list is out of the flow, so the row is as tall as
          the heatmap; a little inset keeps focus rings clear of its edge,
          and a fade at its foot says there is more below. */}
      <div data-testid="activity-recent-column" className="relative min-w-0 lg:flex-1">
        <div className="lg:absolute lg:-inset-1 lg:overflow-y-auto lg:p-1 lg:pb-6 lg:[mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)]">
          <RecentEntries series={series} today={today} />
        </div>
      </div>
    </Surface>
  )
}
