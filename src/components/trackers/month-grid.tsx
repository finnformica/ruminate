import React from "react"
import {
  WEEKDAY_LABELS,
  cellLevel,
  cleanSummary,
  dayLabel,
  formatAmount,
  isLogged,
  monthGrid,
  monthOf,
  rangeDays,
  rollup,
  streak,
  targetProgress,
  trackingStart,
  type DayString,
  type SeriesState,
  type TrackerColour,
} from "../../data/tracker"
import { cx } from "../../utils/cx"
import { Surface } from "../ui/surface"

/** The theme step a cell is filled with at each level (src/styles/
 * radix-colors.css): a tint for a little, the solid for the most. */
const LEVEL_STEPS = [0, 5, 7, 8, 9] as const

/** A series's colour at a theme step, as CSS. */
export const colourVar = (colour: TrackerColour, step: number) => `var(--${colour}-${step})`

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

/** The palette names whose solid step reads with dark marks on it, as
 * Radix's own guidance has it; the rest take white. */
const DARK_ON: readonly TrackerColour[] = ["amber", "yellow"]

/**
 * A slip on a series to avoid (`goal: avoid`, Finn 2026-11-03): a cross
 * over the day's fill, so a day it was logged on reads as a bad day in the
 * heatmap and on its card. Drawn in the colour that reads on `colour`'s
 * solid step. Its parent is `relative`.
 */
export function SlipMark({ colour }: { colour: TrackerColour }) {
  return (
    <svg
      aria-hidden
      data-slip
      viewBox="0 0 10 10"
      className="pointer-events-none absolute inset-0 m-auto size-3/5"
      fill="none"
      stroke={DARK_ON.includes(colour) ? "rgb(0 0 0 / 0.75)" : "white"}
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      <path d="M2 2l6 6M8 2l-6 6" />
    </svg>
  )
}

/** A series to avoid, named as one beside its name: in the cards, the
 * stats row and the heatmap's legend. */
export function AvoidTag() {
  return (
    <span className="shrink-0 rounded-sm border border-border px-1 text-xs leading-4 font-normal text-text-secondary">
      Avoid
    </span>
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
 * grid of the month's days, seven to a row from Monday, filled in the
 * series's colour by how much was logged. Above the
 * grid, the series's name and the month in numbers: its streak, its rollup
 * and, with a target, how far towards it. The cards flow into as many
 * columns as fit, so on a phone they stack and nothing scrolls sideways.
 *
 * A tap on a cell opens the day editor for that day (day-dialog.tsx, Finn
 * 2026-11-03), where every series's value on it can be added, changed or
 * cleared. A day after today cannot be opened and is drawn faint. A series
 * to avoid counts its streak in clean days (`cleanSummary`) and marks a
 * slip with a cross.
 */
export function MonthGrid({
  series,
  start,
  today,
  onOpenDay,
}: {
  series: readonly SeriesState[]
  /** Any day in the month shown. */
  start: DayString
  today: DayString
  /** A cell was tapped: open the day editor on that day. */
  onOpenDay: (day: DayString) => void
}) {
  const month = monthOf(start)
  const days = React.useMemo(() => rangeDays("month", start), [start])
  const rows = React.useMemo(() => monthGrid(month), [month])
  const tracked = React.useMemo(() => trackingStart(series), [series])
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
          tracked={tracked}
          onOpenDay={onOpenDay}
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
  tracked,
  onOpenDay,
}: {
  state: SeriesState
  /** The weeks of the month, rows of seven from Monday. */
  rows: (DayString | null)[][]
  days: DayString[]
  today: DayString
  /** The tracker's first entry (`trackingStart`): where clean days start. */
  tracked: DayString | null
  onOpenDay: (day: DayString) => void
}) {
  const { series } = state
  const name = series.name.trim() || "Untitled"
  const avoid = series.goal === "avoid"
  const run = avoid ? cleanSummary(state, tracked, today).streak : streak(state, today)
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
          {avoid ? <AvoidTag /> : null}
        </h2>
        <dl className="flex shrink-0 gap-3 text-sm text-text-secondary tabular-nums">
          <div className="flex gap-1" title={avoid ? "Clean days in a row" : "Days in a row"}>
            <dt className="sr-only">Streak</dt>
            <dd>{run}d</dd>
          </div>
          <div
            className="flex gap-1"
            title={
              avoid
                ? "Days logged this month"
                : series.kind === "check"
                  ? "Days this month"
                  : "This month"
            }
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
              aria-label={WEEKDAY_NAMES[i]}
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
                  onOpenDay={onOpenDay}
                />
              ),
            )}
          </div>
        ))}
      </div>
    </Surface>
  )
}

/**
 * One day of one series: a cell of its card. A tap opens the day editor on
 * that day. A day after today is faint and cannot be opened. A slip on a
 * series to avoid wears a cross.
 */
function DayCell({
  state,
  day,
  days,
  today,
  onOpenDay,
}: {
  state: SeriesState
  day: DayString
  /** The days shown: a number cell is scaled against their best. */
  days: readonly DayString[]
  today: DayString
  onOpenDay: (day: DayString) => void
}) {
  const { series } = state
  const level = cellLevel(state, day, days)
  const entry = state.entries.get(day)
  const future = day > today
  const check = series.kind === "check"
  const slip = series.goal === "avoid" && isLogged(state, day)
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
        aria-haspopup="dialog"
        aria-current={day === today ? "date" : undefined}
        data-testid="day-cell"
        data-day={day}
        data-series={series.id}
        data-level={level}
        disabled={future}
        onClick={() => onOpenDay(day)}
        // The wall's tile, at a day's size: the one focus ring, the control
        // radius, the hover tint on an empty day, and the disabled fade on a
        // day that has not come.
        className={cx(
          "focus-ring relative block size-full cursor-pointer rounded bg-bg-secondary disabled:cursor-default disabled:opacity-50",
          level === 0 && "enabled:hover:bg-bg-hover",
          day === today && "ring-2 ring-border",
        )}
        style={
          level > 0 ? { backgroundColor: colourVar(series.colour, LEVEL_STEPS[level]) } : undefined
        }
      >
        {slip ? <SlipMark colour={series.colour} /> : null}
      </button>
    </div>
  )
}
