import React from "react"
import {
  WEEKDAY_LABELS,
  cellLevel,
  dayLabel,
  formatAmount,
  isDone,
  monthDays,
  monthGrid,
  rollup,
  streak,
  targetProgress,
  type DayString,
  type MonthString,
  type SeriesState,
  type TrackerColour,
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

/**
 * The month grid (docs/trackers.md): one card per series, each a GitHub-style
 * grid of the month's days, seven to a row from Monday, filled in the
 * series's colour by how much was logged. Above the grid, the series's name
 * and the month in numbers: its streak, its rollup and, with a target, how
 * far towards it. The cards flow into as many columns as fit, so on a phone
 * they stack and nothing scrolls sideways.
 *
 * A tap on a cell: a check series toggles the day; a number series picks
 * the day, which the Today strip then logs. A day after today is not
 * loggable and is drawn faint.
 */
export function MonthGrid({
  series,
  month,
  today,
  selectedDay,
  onToggle,
  onPickDay,
}: {
  series: readonly SeriesState[]
  month: MonthString
  today: DayString
  /** The day the strip is logging, when it is not today. */
  selectedDay: DayString
  /** A check series's cell was tapped: tick or clear that day. */
  onToggle: (seriesId: string, day: DayString, done: boolean) => void
  /** A number series's cell was tapped: log that day in the strip. */
  onPickDay: (day: DayString) => void
}) {
  const rows = React.useMemo(() => monthGrid(month), [month])
  const days = React.useMemo(() => monthDays(month), [month])
  return (
    <div
      data-testid="month-grid"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
      {series.map((state) => (
        <SeriesCard
          key={state.series.id}
          state={state}
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
  rows,
  days,
  today,
  selectedDay,
  onToggle,
  onPickDay,
}: {
  state: SeriesState
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
            title={series.kind === "check" ? "Days this month" : "This month"}
          >
            <dt className="sr-only">This month</dt>
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
      <div role="grid" aria-label={`${name}, by day`} className="grid grid-cols-7 gap-1">
        <div role="row" className="contents">
          {WEEKDAY_LABELS.map((label, i) => (
            <div
              key={i}
              role="columnheader"
              aria-label={
                ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]
              }
              className="text-center text-sm text-text-secondary"
            >
              {label}
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
    </Surface>
  )
}

function DayCell({
  state,
  day,
  days,
  today,
  selected,
  onToggle,
  onPickDay,
}: {
  state: SeriesState
  day: DayString
  days: DayString[]
  today: DayString
  selected: boolean
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
    <div role="gridcell" className="aspect-square">
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
          "focus-ring block size-full cursor-pointer rounded bg-bg-secondary disabled:cursor-default disabled:opacity-50",
          level === 0 && "enabled:hover:bg-bg-hover",
          day === today && "ring-2 ring-border",
          selected && "ring-2 ring-border-selected",
        )}
        style={
          level > 0 ? { backgroundColor: colourVar(series.colour, LEVEL_STEPS[level]) } : undefined
        }
      />
    </div>
  )
}
