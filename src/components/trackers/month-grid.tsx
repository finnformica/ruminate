import React from "react"
import {
  WEEKDAY_LABELS,
  cellLevel,
  dayLabel,
  formatAmount,
  isDone,
  monthGrid,
  monthOf,
  monthShortLabel,
  rangeDays,
  rollup,
  streak,
  targetProgress,
  yearWeeks,
  type DayString,
  type SeriesState,
  type TrackerColour,
  type TrackerRange,
} from "../../data/tracker"
import { cx } from "../../utils/cx"
import { Surface } from "../ui/surface"

/** The theme step a cell is filled with at each level (src/styles/
 * radix-colors.css): a tint for a little, the solid for the most. */
const LEVEL_STEPS = [0, 5, 7, 8, 9] as const

/** A series's colour at a theme step, as CSS. */
const colourVar = (colour: TrackerColour, step: number) => `var(--${colour}-${step})`

/** The one place a series's colour shows outside its cells: a small dot
 * beside its name, in the strip, the cards and the Series editor. */
export function ColourDot({ colour }: { colour: TrackerColour }) {
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: colourVar(colour, 9) }}
    />
  )
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

/**
 * The cards (docs/trackers.md): one card per series, each a GitHub-style
 * grid of the range's days filled in the series's colour by how much was
 * logged — a week as one row of seven, a month seven to a row from Monday,
 * a year as a compact heatmap of its weeks, one column a week. Above the
 * grid, the series's name and the range in numbers: its streak, its rollup
 * and, with a target, how far towards it. The cards flow into as many
 * columns as fit, so on a phone they stack and nothing scrolls sideways.
 *
 * A tap on a cell: a check series toggles the day; a number series picks
 * the day, which the Today strip then logs. A day after today is not
 * loggable and is drawn faint.
 */
export function MonthGrid({
  series,
  range = "month",
  start,
  today,
  selectedDay,
  onToggle,
  onPickDay,
}: {
  series: readonly SeriesState[]
  /** The run of days shown: a week, a month or a year. */
  range?: TrackerRange
  /** Any day in the range shown. */
  start: DayString
  today: DayString
  /** The day the strip is logging, when it is not today. */
  selectedDay: DayString
  /** A check series's cell was tapped: tick or clear that day. */
  onToggle: (seriesId: string, day: DayString, done: boolean) => void
  /** A number series's cell was tapped: log that day in the strip. */
  onPickDay: (day: DayString) => void
}) {
  const days = React.useMemo(() => rangeDays(range, start), [range, start])
  const rows = React.useMemo(
    () =>
      range === "week"
        ? [days]
        : range === "month"
          ? monthGrid(monthOf(days[0]))
          : yearWeeks(Number(days[0].slice(0, 4))),
    [range, days],
  )
  return (
    <div
      data-testid="month-grid"
      data-range={range}
      className={cx(
        "grid grid-cols-1 gap-3",
        range === "year" ? "xl:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
      )}
    >
      {series.map((state) => (
        <SeriesCard
          key={state.series.id}
          state={state}
          range={range}
          rows={rows}
          days={days}
          today={today}
          selectedDay={selectedDay}
          onToggle={onToggle}
          onPickDay={onPickDay}
        />
      ))}
    </div>
  )
}

function SeriesCard({
  state,
  range,
  rows,
  days,
  today,
  selectedDay,
  onToggle,
  onPickDay,
}: {
  state: SeriesState
  range: TrackerRange
  /** The weeks of the range: rows of seven for a week or a month, columns of
   * seven for a year. */
  rows: (DayString | null)[][]
  days: DayString[]
  today: DayString
  selectedDay: DayString
  onToggle: (seriesId: string, day: DayString, done: boolean) => void
  onPickDay: (day: DayString) => void
}) {
  const { series } = state
  const name = series.name.trim() || "Untitled"
  const run = streak(state, today)
  const total = rollup(state, days)
  const progress = targetProgress(state, today)
  return (
    <Surface
      tier="card"
      motion={false}
      data-testid="series-card"
      className="flex flex-col gap-4 p-4"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="flex min-w-0 items-center gap-2 font-bold leading-4">
          <ColourDot colour={series.colour} />
          <span className="truncate">{name}</span>
        </h2>
        <dl className="flex shrink-0 gap-3 text-sm text-text-secondary tabular-nums">
          <div className="flex gap-1" title="Days in a row">
            <dt className="sr-only">Streak</dt>
            <dd>{run}d</dd>
          </div>
          <div
            className="flex gap-1"
            title={series.kind === "check" ? `Days this ${range}` : `This ${range}`}
          >
            <dt className="sr-only">This {range}</dt>
            <dd>
              {total === null
                ? "–"
                : series.kind === "check"
                  ? `${total}×`
                  : formatAmount(series, total)}
            </dd>
          </div>
        </dl>
      </div>
      {/* The target row is on every card, so names, bars and grids sit on
          the same lines across the cards (Finn, 2026-10-28). A series with
          no target keeps the row's height and shows nothing in it. */}
      {progress ? (
        <div
          className="flex items-center gap-2 text-sm text-text-secondary tabular-nums"
          data-testid="target-progress"
        >
          <div
            role="progressbar"
            aria-label={`Target this ${progress.period}`}
            aria-valuemin={0}
            aria-valuemax={progress.target}
            aria-valuenow={Math.min(progress.value, progress.target)}
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-secondary"
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${progress.ratio * 100}%`,
                backgroundColor: colourVar(series.colour, 9),
              }}
            />
          </div>
          <span className="shrink-0">
            {series.kind === "check"
              ? `${progress.value}/${progress.target}`
              : `${formatAmount({ unit: "" }, progress.value)}/${formatAmount(series, progress.target)}`}
            {progress.period === "day" ? "" : ` this ${progress.period}`}
          </span>
        </div>
      ) : (
        <div
          aria-hidden
          className="invisible flex items-center gap-2 text-sm tabular-nums"
          data-testid="target-slot"
        >
          <div className="h-1.5 min-w-0 flex-1" />
          <span className="shrink-0">0/0</span>
        </div>
      )}
      {range === "year" ? (
        <YearHeatmap
          name={name}
          state={state}
          weeks={rows}
          days={days}
          today={today}
          selectedDay={selectedDay}
          onToggle={onToggle}
          onPickDay={onPickDay}
        />
      ) : (
        <div role="grid" aria-label={`${name}, by day`} className="grid grid-cols-7 gap-1">
          <div role="row" className="contents">
            {WEEKDAY_LABELS.map((label, i) => (
              <div
                key={i}
                role="columnheader"
                aria-label={WEEKDAY_NAMES[i]}
                className="text-center text-sm text-text-secondary"
              >
                {label}
                {/* A week has one row: each day's number goes under its
                    weekday, as a month's cells have their place instead. */}
                {range === "week" ? (
                  <span
                    className={cx(
                      "block tabular-nums",
                      rows[0][i] === today && "font-bold text-text",
                    )}
                  >
                    {Number(rows[0][i]?.slice(8))}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          {rows.map((row, r) => (
            <div key={r} role="row" className="contents">
              {row.map((day, c) =>
                day === null ? (
                  <div key={c} role="gridcell" aria-hidden className="aspect-square" />
                ) : (
                  <DayCell
                    key={day}
                    state={state}
                    day={day}
                    days={days}
                    today={today}
                    selected={day === selectedDay && selectedDay !== today}
                    onToggle={onToggle}
                    onPickDay={onPickDay}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      )}
    </Surface>
  )
}

/**
 * A year on one card: a heatmap of its weeks, one column a week from Monday
 * and one row a weekday, with the months named above the week each begins
 * in. The columns share the card's width, so the year fits a phone with no
 * sideways scroll; the cells are then too small to tap well, and the year is
 * for reading.
 */
function YearHeatmap({
  name,
  state,
  weeks,
  days,
  today,
  selectedDay,
  onToggle,
  onPickDay,
}: {
  name: string
  state: SeriesState
  weeks: (DayString | null)[][]
  days: DayString[]
  today: DayString
  selectedDay: DayString
  onToggle: (seriesId: string, day: DayString, done: boolean) => void
  onPickDay: (day: DayString) => void
}) {
  return (
    <div
      role="grid"
      aria-label={`${name}, by day`}
      className="grid gap-px"
      style={{ gridTemplateColumns: `auto repeat(${weeks.length}, minmax(0, 1fr))` }}
    >
      <div role="row" className="contents">
        <div aria-hidden />
        {weeks.map((week, w) => {
          // The month is named over the week its first day falls in.
          const first = week.find((day) => day !== null && day.endsWith("-01"))
          return (
            <div
              key={w}
              role="columnheader"
              className="overflow-visible whitespace-nowrap text-xs leading-4 text-text-secondary"
            >
              {/* A phone has room for a letter over each month, not a name. */}
              {first ? (
                <>
                  <span className="sm:hidden">{monthShortLabel(monthOf(first)).slice(0, 1)}</span>
                  <span className="hidden sm:inline">{monthShortLabel(monthOf(first))}</span>
                </>
              ) : null}
            </div>
          )
        })}
      </div>
      {WEEKDAY_NAMES.map((weekday, d) => (
        <div key={weekday} role="row" aria-label={weekday} className="contents">
          {/* No height of its own: the row is a cell high, however small,
              and the letter is centred on it. A phone's rows are too thin
              for letters at all, but the header keeps its place in the
              grid. */}
          <div
            role="rowheader"
            aria-label={weekday}
            className="flex h-0 items-center self-center text-xs leading-none text-text-secondary sm:pr-1"
          >
            {d % 2 === 0 ? <span className="hidden sm:inline">{WEEKDAY_LABELS[d]}</span> : null}
          </div>
          {weeks.map((week, w) => {
            const day = week[d]
            return day === null ? (
              <div key={w} role="gridcell" aria-hidden className="aspect-square" />
            ) : (
              <DayCell
                key={day}
                compact
                state={state}
                day={day}
                days={days}
                today={today}
                selected={day === selectedDay && selectedDay !== today}
                onToggle={onToggle}
                onPickDay={onPickDay}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * One day of one series: the cards' cell and the journal grid's. A tap on a
 * check series toggles the day; on a number series it picks the day for the
 * Today strip. A day after today is faint and not loggable.
 */
export function DayCell({
  state,
  day,
  days,
  today,
  selected,
  compact = false,
  className = "aspect-square",
  onToggle,
  onPickDay,
}: {
  state: SeriesState
  day: DayString
  /** The days shown: a number cell is scaled against their best. */
  days: readonly DayString[]
  today: DayString
  selected: boolean
  /** A small cell, as the year draws them: a tighter radius and a thin ring. */
  compact?: boolean
  /** The cell's box. */
  className?: string
  onToggle: (seriesId: string, day: DayString, done: boolean) => void
  onPickDay: (day: DayString) => void
}) {
  const { series } = state
  const level = cellLevel(state, day, days)
  const entry = state.entries.get(day)
  const future = day > today
  const check = series.kind === "check"
  const done = isDone(state, day)
  const logged =
    entry === undefined
      ? "nothing"
      : check
        ? "done"
        : formatAmount(series, typeof entry.value === "number" ? entry.value : 0)
  return (
    <div role="gridcell" className={className}>
      <button
        type="button"
        aria-label={`${dayLabel(day)}: ${logged}`}
        aria-pressed={check ? done : undefined}
        aria-current={day === today ? "date" : undefined}
        data-testid="day-cell"
        data-day={day}
        data-level={level}
        disabled={future}
        onClick={() => (check ? onToggle(series.id, day, !done) : onPickDay(day))}
        // The wall's tile, at a day's size: the one focus ring, the control
        // radius, the hover tint on an empty day, the selected ring, and the
        // disabled fade on a day that has not come.
        className={cx(
          "focus-ring block size-full cursor-pointer bg-bg-secondary disabled:cursor-default disabled:opacity-50",
          compact ? "rounded-[2px]" : "rounded",
          level === 0 && "enabled:hover:bg-bg-hover",
          day === today && (compact ? "ring-1 ring-text-secondary" : "ring-2 ring-border"),
          selected && (compact ? "ring-1 ring-border-selected" : "ring-2 ring-border-selected"),
        )}
        style={
          level > 0 ? { backgroundColor: colourVar(series.colour, LEVEL_STEPS[level]) } : undefined
        }
      />
    </div>
  )
}
