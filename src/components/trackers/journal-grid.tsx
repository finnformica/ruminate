import React from "react"
import {
  WEEKDAY_LABELS,
  formatAmount,
  monthOf,
  monthShortLabel,
  rangeDays,
  rollup,
  streak,
  weekdayFromMonday,
  type DayString,
  type SeriesState,
  type TrackerRange,
} from "../../data/tracker"
import { cx } from "../../utils/cx"
import { Surface } from "../ui/surface"
import { ColourDot, DayCell } from "./month-grid"

/** A day's column and the cell in it, per range: a week has room for big
 * cells, a year needs small ones. The column is the cell plus 2 px, which
 * is the gap between cells, so the sticky series column covers what
 * scrolls under it. */
const SIZES: Record<TrackerRange, { column: number; cell: string }> = {
  week: { column: 42, cell: "size-10" },
  month: { column: 26, cell: "size-6" },
  year: { column: 18, cell: "size-4" },
}

/**
 * The journal grid (docs/trackers.md, Finn 2026-10-28): the range as one
 * table, a row per series and a column per day, as a bullet journal's habit
 * page is drawn. Above the days, their weekday and their number (and, for a
 * year, the month over its first day); at the left, the series's colour,
 * name and rollup for the range.
 *
 * On a narrow screen the days scroll sideways under a series column that
 * stays put, and the grid opens scrolled to today, so the day you log is in
 * view and the row it is on is still named.
 */
export function JournalGrid({
  series,
  range,
  start,
  today,
  selectedDay,
  onToggle,
  onPickDay,
}: {
  series: readonly SeriesState[]
  range: TrackerRange
  /** Any day in the range shown. */
  start: DayString
  today: DayString
  /** The day the strip is logging, when it is not today. */
  selectedDay: DayString
  onToggle: (seriesId: string, day: DayString, done: boolean) => void
  onPickDay: (day: DayString) => void
}) {
  const days = React.useMemo(() => rangeDays(range, start), [range, start])
  const { column, cell } = SIZES[range]
  const scroller = React.useRef<HTMLDivElement>(null)

  // Open with today in the middle of the view when the range holds it.
  React.useLayoutEffect(() => {
    const box = scroller.current
    if (!box) return
    const head = box.querySelector<HTMLElement>(`[data-day="${today}"]`)
    const names = box.querySelector<HTMLElement>("[data-series-column]")
    if (!head) {
      box.scrollLeft = 0
      return
    }
    const fixed = names?.offsetWidth ?? 0
    box.scrollLeft = head.offsetLeft - fixed - (box.clientWidth - fixed - column) / 2
  }, [days, today, column])

  const sticky = "sticky left-0 z-10 bg-bg-card pl-3 pr-2"
  return (
    <Surface tier="card" motion={false} data-testid="journal-grid" data-range={range}>
      <div ref={scroller} className="overflow-x-auto py-3">
        <div
          role="grid"
          aria-label="Series by day"
          className="relative grid w-max items-center gap-y-0.5"
          style={{ gridTemplateColumns: `auto repeat(${days.length}, ${column}px)` }}
        >
          {range === "year" ? (
            <div role="row" className="contents">
              <div aria-hidden data-series-column className={cx(sticky, "self-stretch")} />
              {days.map((day) => (
                <div
                  key={day}
                  aria-hidden
                  className="overflow-visible whitespace-nowrap text-xs leading-4 text-text-secondary"
                >
                  {day.endsWith("-01") ? monthShortLabel(monthOf(day)) : null}
                </div>
              ))}
            </div>
          ) : null}
          <div role="row" className="contents">
            <div
              role="columnheader"
              data-series-column
              className={cx(sticky, "self-stretch text-sm text-text-secondary")}
            >
              <span className="sr-only">Series</span>
            </div>
            {days.map((day) => {
              const weekday = weekdayFromMonday(day)
              return (
                <div
                  key={day}
                  role="columnheader"
                  aria-label={day}
                  data-day={day}
                  className={cx(
                    "flex flex-col items-center leading-4 tabular-nums",
                    range === "year" ? "text-[10px]" : "text-xs",
                    day === today ? "font-bold text-text" : "text-text-secondary",
                    // A weekend reads lighter, as a journal's ruled page does.
                    day !== today && weekday >= 5 && "text-text-tertiary",
                  )}
                >
                  <span>{WEEKDAY_LABELS[weekday]}</span>
                  <span>{Number(day.slice(8))}</span>
                </div>
              )
            })}
          </div>
          {series.map((state) => {
            const name = state.series.name.trim() || "Untitled"
            const total = rollup(state, days)
            return (
              <div key={state.series.id} role="row" data-testid="journal-row" className="contents">
                <div
                  role="rowheader"
                  className={cx(sticky, "flex h-full w-28 items-center gap-2 self-stretch sm:w-44")}
                >
                  <ColourDot colour={state.series.colour} />
                  <span className="min-w-0 flex-1 truncate font-bold leading-4">{name}</span>
                  <span
                    className="hidden shrink-0 text-sm text-text-secondary tabular-nums sm:inline"
                    title={`Days in a row: ${streak(state, today)}`}
                  >
                    {total === null
                      ? "–"
                      : state.series.kind === "check"
                        ? `${total}×`
                        : formatAmount(state.series, total)}
                  </span>
                </div>
                {days.map((day) => (
                  <DayCell
                    key={day}
                    compact={range === "year"}
                    className={cx(cell, "justify-self-center")}
                    state={state}
                    day={day}
                    days={days}
                    today={today}
                    selected={day === selectedDay && selectedDay !== today}
                    onToggle={onToggle}
                    onPickDay={onPickDay}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </Surface>
  )
}
