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

/** A cell's top left corner and size, in the units `dotLayout` was given.
 * `more` is the grey outline that stands for the series not shown. */
export type DotPlace = { x: number; y: number; w: number; h: number; more?: boolean }

/** The margin round the cells and the gap between them, as a share of the
 * side (Finn, 2026-11-03: the 10 % margin of the dots). */
const DOT_MARGIN = 0.1
const DOT_GAP = 0.06

/** A cell's corner radius, as a share of its shorter side. */
const SQUARE_RADIUS = 0.2

/** The cells in each row: full rows of 2 (up to 4 series) or 3 (5 to 9),
 * then the rest. One series is one row of one. */
function rowsOf(count: number): number[] {
  const n = Math.min(count, 9)
  const k = n === 1 ? 1 : n <= 4 ? 2 : 3
  const rows: number[] = []
  for (let left = n; left > 0; left -= k) rows.push(Math.min(k, left))
  return rows
}

/** `length` split in `parts` cells, the margin each side and the gap between:
 * each cell's start and size. With `snap`, every value is a whole unit (a
 * device pixel) and the cells are placed so the margins stay equal: a spare
 * pixel goes to the middle cell, two go to the end cells, and with two cells
 * the gap takes one. */
function split(length: number, parts: number, snap: boolean): [number, number][] {
  const margin = snap ? Math.round(length * DOT_MARGIN) : length * DOT_MARGIN
  let gap = parts === 1 ? 0 : snap ? Math.max(1, Math.round(length * DOT_GAP)) : length * DOT_GAP
  let room = length - 2 * margin - (parts - 1) * gap
  if (snap && parts === 2 && room % 2 === 1) {
    gap += gap > 1 ? -1 : 1
    room = length - 2 * margin - gap
  }
  const base = snap ? Math.floor(room / parts) : room / parts
  const spare = room - base * parts
  const sizes = Array.from({ length: parts }, () => base)
  if (spare % 2 === 1) sizes[Math.floor(parts / 2)] += 1
  for (let i = 0; i < Math.floor(spare / 2); i++) {
    sizes[i] += 1
    sizes[parts - 1 - i] += 1
  }
  let at = margin
  return sizes.map((size) => {
    const cell: [number, number] = [at, size]
    at += size + gap
    return cell
  })
}

/**
 * The cells of a day with `count` series, in a tile `width` by `height`
 * (Finn, 2026-11-03: "grow the grid", and fill the space). The cells sit in
 * rows inside the margin, with a gap between: 1 series fills the space, 2
 * to 4 are rows of 2, 5 to 9 rows of 3, and a short last row's cells widen
 * to fill the width (3 is two over one). No cell is left empty. More than 9:
 * eight cells and a grey outline for the rest; the day editor lists them
 * all. With `snap` the units are device pixels and every edge is on one, so
 * the cells are sharp and centred.
 */
export function dotLayout(count: number, width = 100, height = width, snap = false): DotPlace[] {
  if (count <= 0) return []
  const rows = rowsOf(count)
  const ys = split(height, rows.length, snap)
  const places: DotPlace[] = rows.flatMap((parts, r) =>
    split(width, parts, snap).map(([x, w]) => ({ x, y: ys[r][0], w, h: ys[r][1] })),
  )
  if (count > 9) places[8] = { ...places[8], more: true }
  return places
}

/** A tile's size in device pixels, as painted (each edge on the nearest
 * pixel), and one device pixel in the tile's own CSS pixels. Null before it
 * is measured, and where nothing is laid out. It is measured after each
 * render, as the grid's tracks can move a tile without a change of size,
 * and again when the fonts are in. */
type PixelBox = { w: number; h: number; unit: number }

function usePixelBox(ref: React.RefObject<HTMLElement | null>) {
  const [box, setBox] = React.useState<PixelBox | null>(null)
  const measure = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(rect.right * dpr) - Math.round(rect.left * dpr)
    const h = Math.round(rect.bottom * dpr) - Math.round(rect.top * dpr)
    // The tile's scale on the page: more than 1 under a CSS zoom.
    const scale = rect.width / parseFloat(getComputedStyle(el).width) || 1
    const unit = 1 / (dpr * scale)
    setBox((old) =>
      !(w > 0 && h > 0)
        ? null
        : old && old.w === w && old.h === h && old.unit === unit
          ? old
          : { w, h, unit },
    )
  }, [ref])
  React.useLayoutEffect(measure)
  React.useEffect(() => {
    let live = true
    void document.fonts?.ready.then(() => live && measure())
    return () => {
      live = false
    }
  }, [measure])
  return box
}

/**
 * A day's series as squares on the day's tile (`dotLayout`), in their
 * colours: the one look for a day with one series and with many. A tile of
 * a phone's Heatmap is a fraction of a pixel in size and place, and a cell
 * with an edge inside a pixel shows one soft side and looks off centre.
 * So the tile is measured in device pixels, the drawing is given that size
 * exactly (the browser puts its corner on a pixel, but scales its view box
 * to its CSS size), and every edge is on a whole pixel. `faint` draws the
 * squares of a placeholder. Its parent is `relative`.
 */
export function DayDots({ dots, faint = false }: { dots: readonly DayDot[]; faint?: boolean }) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const box = usePixelBox(ref)
  const width = box?.w ?? 100
  const height = box?.h ?? 100
  const places = dotLayout(dots.length, width, height, box !== null)
  // The outline past 9: one CSS pixel, on whole device pixels when measured.
  const stroke = box ? Math.max(1, Math.round(1 / box.unit)) : 1.2
  return (
    <span ref={ref} aria-hidden className="pointer-events-none absolute inset-0">
      <svg
        data-dots={dots.length}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={cx("absolute top-0 left-0", !box && "size-full", faint && "opacity-40")}
        style={box ? { width: box.w * box.unit, height: box.h * box.unit } : undefined}
      >
        {places.map(({ x, y, w, h, more }, i) => {
          if (more) {
            const inset = box ? stroke / 2 : 1
            return (
              <rect
                key={i}
                data-more
                x={x + inset}
                y={y + inset}
                width={w - 2 * inset}
                height={h - 2 * inset}
                rx={(Math.min(w, h) - 2 * inset) * SQUARE_RADIUS}
                fill="none"
                stroke="var(--neutral-9)"
                strokeWidth={stroke}
                vectorEffect={box ? undefined : "non-scaling-stroke"}
              />
            )
          }
          const { colour } = dots[i]
          return (
            <rect
              key={i}
              data-dot={colour}
              x={x}
              y={y}
              width={w}
              height={h}
              rx={Math.min(w, h) * SQUARE_RADIUS}
              fill={colourVar(colour, 9)}
            />
          )
        })}
      </svg>
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
