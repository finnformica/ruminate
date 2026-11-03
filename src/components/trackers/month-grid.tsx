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

/** The palette names whose solid step reads with dark marks on it, as
 * Radix's own guidance has it; the rest take white. */
const DARK_ON: readonly TrackerColour[] = ["amber", "yellow"]

/**
 * A slip on a series to avoid (`goal: avoid`, Finn 2026-11-03): a cross
 * over the day's fill, so a day it was logged on reads as a bad day in the
 * heatmap and on its card. Drawn in the colour that reads on `colour`'s
 * solid step. Its parent is `relative`.
 */
function SlipMark({ colour }: { colour: TrackerColour }) {
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

/** A day square's corner radius, as a share of its side: one shape at
 * every size, so a desktop Heatmap's larger days are as round as a card's
 * (Finn, 2026-11-03). */
export const DAY_RADIUS = 0.25

/** The radius as CSS: a percentage of the square's own side. */
export const dayRadius = `${DAY_RADIUS * 100}%`

/** A series logged on a day, as one dot: its colour, and whether it is a
 * slip on a series to avoid. */
export type DayDot = { colour: TrackerColour; slip?: boolean }

/** A dot's place and size, in hundredths of the day's side. `more` is the
 * grey ring that stands for the series not shown. */
export type DotPlace = { x: number; y: number; d: number; more?: boolean }

/** The margin round the dots, and how much of a grid step a dot takes, in
 * hundredths of the side (Finn, 2026-11-03: 10, so the dots have room). */
const DOT_MARGIN = 10
const DOT_SHARE = 0.78

/** The one dot of a day with one series, in hundredths of the side: a
 * little larger than a 2×2 dot (31.2), not a large dot (Finn, 2026-11-03). */
const DOT_SINGLE = 34

/** Where the dots of 2 to 4 series go in a 2×2 grid: two side by side, two
 * over one, four in the corners. */
const SMALL_GRID: Record<number, readonly (readonly [number, number])[]> = {
  2: [
    [0, 0.5],
    [1, 0.5],
  ],
  3: [
    [0, 0],
    [1, 0],
    [0.5, 1],
  ],
  4: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
}

/**
 * The dots of a day with `count` series (Finn, 2026-11-03: "grow the grid").
 * 1: one dot in the centre, a little larger than a 2×2 dot (`DOT_SINGLE`).
 * 2 to 4: medium dots in a 2×2 grid. 5 to 9: smaller dots in a 3×3 grid,
 * row by row. More than 9: eight dots and a grey ring for the rest; the day
 * editor lists them all.
 */
export function dotLayout(count: number): DotPlace[] {
  if (count <= 0) return []
  if (count === 1) return [{ x: 50, y: 50, d: DOT_SINGLE }]
  const k = count <= 4 ? 2 : 3
  const step = (100 - 2 * DOT_MARGIN) / k
  const d = step * DOT_SHARE
  const at = (c: number, r: number): DotPlace => ({
    x: DOT_MARGIN + step * (c + 0.5),
    y: DOT_MARGIN + step * (r + 0.5),
    d,
  })
  if (count <= 4) return SMALL_GRID[count].map(([c, r]) => at(c, r))
  const places = Array.from({ length: Math.min(count, 9) }, (_, i) => at(i % 3, Math.floor(i / 3)))
  if (count > 9) places[8] = { ...places[8], more: true }
  return places
}

/** Under this size, in px, a cross on a dot does not read: a slip is then a
 * ring in its colour. */
const SLIP_RING_BELOW = 6

/**
 * A day's series as dots on the day's tile (`dotLayout`), in their colours:
 * the one look for a day with one series and with many. A slip on a series
 * to avoid is its dot with a white cross, or a ring when the dot is small.
 * `side` is the day's measured side, if known; `faint` draws the dots of a
 * placeholder. Its parent is `relative`.
 */
export function DayDots({
  dots,
  side,
  faint = false,
}: {
  dots: readonly DayDot[]
  side: number | null
  faint?: boolean
}) {
  const places = dotLayout(dots.length)
  return (
    <svg
      aria-hidden
      data-dots={dots.length}
      viewBox="0 0 100 100"
      className={cx("pointer-events-none absolute inset-0 size-full", faint && "opacity-40")}
    >
      {places.map(({ x, y, d, more }, i) => {
        const r = d / 2
        if (more) {
          return (
            <circle
              key={i}
              data-more
              cx={x}
              cy={y}
              r={r - 1}
              fill="none"
              stroke="var(--neutral-9)"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
            />
          )
        }
        const { colour, slip } = dots[i]
        const fill = colourVar(colour, 9)
        if (slip && side !== null && (d / 100) * side < SLIP_RING_BELOW) {
          return (
            <circle
              key={i}
              data-dot={colour}
              data-slip
              cx={x}
              cy={y}
              r={r - 1}
              fill="none"
              stroke={fill}
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
            />
          )
        }
        const c = r * 0.45
        return (
          <g key={i} data-dot={colour} data-slip={slip || undefined}>
            <circle cx={x} cy={y} r={r} fill={fill} />
            {slip ? (
              <path
                d={`M${x - c} ${y - c}L${x + c} ${y + c}M${x + c} ${y - c}L${x - c} ${y + c}`}
                stroke="white"
                strokeWidth={d * 0.12}
                strokeLinecap="round"
              />
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}

/** A day still to come in the Heatmap: half the empty tile's grey, under
 * its dashed outline (Finn, 2026-11-03). */
const TO_COME_FILL = "color-mix(in srgb, var(--color-bg-secondary) 50%, transparent)"

/**
 * A day as a square, the one look for the cards and the Heatmap: the focus
 * ring, the radius, the tile, the ring on today and the cross on a slip. A
 * card's day is filled in its series's shade for the amount (`fill`); a
 * Heatmap day is the tile with its series as dots (`DayDots`, as
 * `children`), and an empty tile takes a hover tint. A day to come is a
 * faint tile on a card (`toCome: "faint"`) and a fainter grey with an
 * outline of its own in the Heatmap (`toCome: "outline"`, the outline drawn
 * as `children`). It fills its grid cell.
 */
export function DaySquare({
  fill,
  today,
  toCome,
  slip,
  children,
  ...button
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style" | "type"> & {
  /** The day's fill, as a CSS colour; none for the tile. */
  fill?: string
  today: boolean
  toCome?: "faint" | "outline"
  /** The colour of a series to avoid that was logged on the day. */
  slip?: TrackerColour
}) {
  return (
    <button
      type="button"
      aria-current={today ? "date" : undefined}
      {...button}
      className={cx(
        "focus-ring relative block size-full cursor-pointer disabled:cursor-default",
        toCome !== "outline" && "bg-bg-secondary",
        toCome === "faint" && "opacity-50",
        !fill && !toCome && "enabled:hover:bg-bg-hover",
        today && "ring-2 ring-border",
      )}
      style={{
        borderRadius: dayRadius,
        backgroundColor: toCome === "outline" ? TO_COME_FILL : fill,
      }}
    >
      {children}
      {slip ? <SlipMark colour={slip} /> : null}
    </button>
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
      <DaySquare
        aria-label={`${dayLabel(day)}: ${logged}`}
        aria-haspopup="dialog"
        data-testid="day-cell"
        data-day={day}
        data-series={series.id}
        data-level={level}
        disabled={future}
        onClick={() => onOpenDay(day)}
        today={day === today}
        toCome={future ? "faint" : undefined}
        fill={level > 0 ? colourVar(series.colour, LEVEL_STEPS[level]) : undefined}
        slip={slip ? series.colour : undefined}
      />
    </div>
  )
}
