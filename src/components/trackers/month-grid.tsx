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

/** A series logged on a day, as one square in its colour. A slip on a
 * series to avoid is a plain square too: the Heatmap has no slip mark (Finn,
 * 2026-11-03); the cards keep theirs. */
export type DayDot = { colour: TrackerColour }

/** The margin round the squares and the gap between them, in hundredths of
 * the tile's side (Finn, 2026-11-03: the 10 % margin of the dots). */
const DOT_MARGIN = 10
const DOT_GAP = 6

/** The single square's corner radius, as a share of its side (Finn,
 * 2026-11-04: the look of every mark's corner). */
const SQUARE_RADIUS = 0.2

/**
 * The side of a day's grid for `count` series (Finn, 2026-11-03: the grid
 * of the dots): 1 for one series, 2 (a 2×2) for 2 to 4, 3 (a 3×3) for 5 to
 * 9 and more.
 */
export function dotGrid(count: number): number {
  return count <= 0 ? 0 : count === 1 ? 1 : count <= 4 ? 2 : 3
}

/** A mark's place in the day's grid: its first column and row (from 1), and
 * how many columns and rows it spans. */
type DotCell = readonly [column: number, row: number, columns: number, rows: number]

/** One cell of each row of a grid of `k`, row by row from `row`. */
const singles = (k: number, count: number, row = 1): DotCell[] =>
  Array.from({ length: count }, (_, i) => [(i % k) + 1, row + Math.floor(i / k), 1, 1] as const)

/**
 * The marks of a day with 1 to 9 series, in reading order (Finn,
 * 2026-11-03: "empty space should be filled by the closest square"). No
 * cell is left empty: a mark next to an empty cell spans it, with the gap
 * between, so the block keeps one shape.
 * - 2: two halves, one over the other. 3: a half on top, two quarters
 *   below ("one of the activities takes up half and the other two take up
 *   a quarter each"). 4: four quarters.
 * - 5: three over two full-width rows (Finn, 2026-11-04: "5a as that makes
 *   most sense to me"). 6: three over three, the last three down to the
 *   foot. 7: the last spans the last row. 8: the last spans two cells. 9:
 *   nine cells.
 */
const DOT_CELLS: Record<number, readonly DotCell[]> = {
  1: [[1, 1, 1, 1]],
  2: [
    [1, 1, 2, 1],
    [1, 2, 2, 1],
  ],
  3: [[1, 1, 2, 1], ...singles(2, 2, 2)],
  4: singles(2, 4),
  5: [...singles(3, 3), [1, 2, 3, 1], [1, 3, 3, 1]],
  6: [...singles(3, 3), [1, 2, 1, 2], [2, 2, 1, 2], [3, 2, 1, 2]],
  7: [...singles(3, 6), [1, 3, 3, 1]],
  8: [...singles(3, 7), [2, 3, 2, 1]],
  9: singles(3, 9),
}

/** The marks of a day with `count` series. More than 9 is the nine cells
 * of a 3×3, the last a grey outline for the rest; the day editor lists them
 * all. */
export function dotCells(count: number): readonly DotCell[] {
  return count <= 0 ? [] : DOT_CELLS[Math.min(count, 9)]
}

/** One device pixel, in CSS pixels: `--dot-u`, set by the Heatmap from the
 * screen's resolution (`DEVICE_PIXEL_CLASS`), else one CSS pixel. Every
 * length of a day's marks is a whole number of these, so each edge falls on
 * a device pixel. */
const U = "var(--dot-u, 1px)"

/** Added before each `round(down, …)`: far under a device pixel, but more
 * than the error of the browser's sums, so a size of exactly 3 px (14 px
 * less the margins and gaps, over 3) is not 2.99999 px rounded down to 2. */
const EPSILON = "0.01px"

/** Sets `--dot-u` to one device pixel at 2 and 3 dppx (a phone draws two or
 * three device pixels a CSS pixel). */
export const DEVICE_PIXEL_CLASS =
  "[@media(min-resolution:2dppx)]:[--dot-u:0.5px] [@media(min-resolution:3dppx)]:[--dot-u:calc(1px/3)]"

/** A Heatmap day's side as CSS, in a cell that is an inline-size container:
 * the cell's width rounded down to a whole device pixel. A tile of a known
 * whole size lets its marks share it out exactly (`DayDots`). */
export const dayTileSide = `round(down, 100cqw + ${EPSILON}, ${U})`

/** The margin as CSS, in whole device pixels. The grid is inset by it on all
 * four sides: the tile's edges and the grid's edges then sit at the same
 * fraction of a pixel and round the same way, so the margin is the same on
 * each side. (Centred at a fractional offset, a 14.37 px phone day showed
 * 1 px of margin on one side and 2 px on the other.) */
const DOT_MARGIN_CSS = `round(${DOT_MARGIN}cqw, ${U})`

/** The gap as CSS, in whole device pixels and never under one: a phone's
 * 14 px day has 0.84 px of gap, which can round away and join two squares
 * (3 device px at DPR 3, 2 at DPR 2). */
const DOT_GAP_CSS = `max(${U}, round(${DOT_GAP}cqw, ${U}))`

/** A square's side as CSS for a grid of `k`: its share of the room inside
 * the margin less the gaps, in whole device pixels. In a 2×2 it rounds down
 * and the one gap takes what is left over, so both squares are the same. In
 * a 3×3 it rounds to the nearest and the middle column and row take what is
 * left over (`dotMiddleCss`), so the two gaps are the gap and the grid stays
 * symmetric (Finn, 2026-11-04: "tighten it up a little"). 14.37 px at DPR 3
 * is a 43 px tile: margins 4, squares 10, 9 and 10, gaps 3. */
const dotSideCss = (k: number) =>
  k === 1
    ? "calc(100cqw - 2 * var(--dot-margin))"
    : k === 3
      ? `round((100cqw - 2 * var(--dot-margin) - 2 * var(--dot-gap)) / 3, ${U})`
      : `round(down, (100cqw - 2 * var(--dot-margin) - ${k - 1} * var(--dot-gap)) / ${k} + ${EPSILON}, ${U})`

/** The middle column and row of a 3×3: what is left of the room inside the
 * margin, at most one device pixel more or less than the others. */
const dotMiddleCss = "calc(100cqw - 2 * var(--dot-margin) - 2 * var(--dot-gap) - 2 * var(--dot))"

/** A mark's corner radius as CSS: the single square's corner (a share of
 * the room inside the margin), but at most a third of the mark's short side
 * (`--dot`, or a span of `n` cells and the gaps between them), so a small
 * square is not a circle (Finn, 2026-11-04). In whole device pixels and at
 * least one. One length for x and y, so every corner is a circle. */
const dotRadiusCss = (columns: number, rows: number) => {
  const n = Math.min(columns, rows)
  const side = n === 1 ? "var(--dot)" : `(${n} * var(--dot) + ${n - 1} * var(--dot-gap))`
  const single = `round((100cqw - 2 * var(--dot-margin)) * ${SQUARE_RADIUS}, ${U})`
  return `max(${U}, min(${single}, round(${side} / 3, ${U})))`
}

/**
 * A day's series as squares on the day's tile, in their colours: the one
 * look for a day with one series and with many. Plain CSS layout, no
 * measure: the tile is a size container, and the squares a fixed k×k grid
 * (`dotGrid`) inset by the same whole-device-pixel margin on all four sides
 * (lengths in `cqw`, hundredths of the tile's side). One series fills the
 * inset box; in a 2×2 or 3×3 every cell is a whole-device-pixel side (a
 * 3×3's middle one pixel more or less), and the gaps are equal when the tile is whole (`dayTileSide`), the outer cells
 * on the box's edges (`space-between`), and a mark spans the cells of
 * `dotCells`, the gaps between them too. A slip on a series to avoid
 * is a plain square: the Heatmap has no slip mark (Finn, 2026-11-03).
 * `faint` draws the squares of a placeholder. Its parent is `relative`.
 */
export function DayDots({ dots, faint = false }: { dots: readonly DayDot[]; faint?: boolean }) {
  const k = dotGrid(dots.length)
  const track =
    k === 1
      ? "1fr"
      : k === 3
        ? "var(--dot) var(--dot-middle) var(--dot)"
        : `repeat(${k}, var(--dot))`
  return (
    <span
      aria-hidden
      data-dots={dots.length}
      className={cx(
        "pointer-events-none absolute inset-0 [container-type:size]",
        faint && "opacity-40",
      )}
    >
      <span
        data-dot-grid={k}
        className="absolute grid"
        style={
          {
            "--dot-margin": DOT_MARGIN_CSS,
            "--dot-gap": DOT_GAP_CSS,
            "--dot": dotSideCss(k),
            "--dot-middle": dotMiddleCss,
            inset: "var(--dot-margin)",
            gridTemplateColumns: track,
            gridTemplateRows: track,
            gap: "var(--dot-gap)",
            justifyContent: "space-between",
            alignContent: "space-between",
          } as React.CSSProperties
        }
      >
        {dotCells(dots.length).map(([column, row, columns, rows], at) => {
          const more = at === 8 && dots.length > 9
          const place = {
            gridColumn: `${column} / span ${columns}`,
            gridRow: `${row} / span ${rows}`,
            borderRadius: dotRadiusCss(columns, rows),
          }
          return more ? (
            <span
              key={at}
              data-more
              className="border"
              style={{ ...place, borderColor: "var(--neutral-9)" }}
            />
          ) : (
            <span
              key={at}
              data-dot={dots[at].colour}
              style={{ ...place, backgroundColor: colourVar(dots[at].colour, 9) }}
            />
          )
        })}
      </span>
    </span>
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
