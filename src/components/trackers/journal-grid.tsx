import React from "react"
import {
  WEEKDAY_LABELS,
  dayLabel,
  monthOf,
  monthShortLabel,
  rangeDays,
  weekdayFromMonday,
  type DayString,
  type SeriesState,
  type TrackerRange,
} from "../../data/tracker"
import { cx } from "../../utils/cx"
import { Surface } from "../ui/surface"
import { ColourDot, DayCell } from "./month-grid"

/** A series's column (`--series-column`) and the cell in it, per range: a
 * week has room for big cells, a year needs small ones. The column is the
 * cell plus 4 px, the gap between cells. At these sizes a phone (390 px)
 * shows six series beside the day column with no sideways scroll, a week's
 * big cells too (Finn, 2026-10-29). */
const SIZES: Record<TrackerRange, { column: string; cell: string }> = {
  week: { column: "[--series-column:44px]", cell: "size-10" },
  month: { column: "[--series-column:32px]", cell: "size-7" },
  year: { column: "[--series-column:24px]", cell: "size-5" },
}

/**
 * The journal grid (docs/trackers.md, Finn 2026-10-28): the range as one
 * table, a row per day and a column per series, as a bullet journal's habit
 * page is drawn (Finn turned it on its side, 2026-10-29). At the left of each
 * day, its weekday and its number; a year names each month above its first
 * day. Above each column, only the series's colour: the Today strip's chips
 * above the grid are its legend, and the name is the column's label for a
 * screen reader.
 *
 * The grid scrolls in its own box, under a row of colours and a day column
 * that stay put, and opens scrolled to today, so the day you log is in view
 * and its columns are still coloured. Past six series or so a phone scrolls
 * it sideways too.
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
    box.scrollLeft = 0
    const row = box.querySelector<HTMLElement>(`[data-day-row="${today}"]`)
    const colours = box.querySelector<HTMLElement>("[data-series-row]")
    if (!row) {
      box.scrollTop = 0
      return
    }
    const fixed = colours?.offsetHeight ?? 0
    box.scrollTop = row.offsetTop - fixed - (box.clientHeight - fixed - row.offsetHeight) / 2
  }, [days, today])

  const stickyTop = "sticky top-0 z-10 self-stretch bg-bg-card pb-2 pt-3"
  const stickyLeft = "sticky left-0 z-10 bg-bg-card pl-3 pr-2"
  return (
    <Surface tier="card" motion={false} data-testid="journal-grid" data-range={range}>
      <div ref={scroller} className="max-h-[70svh] overflow-auto pb-3">
        <div
          role="grid"
          aria-label="Days by series"
          className={cx("relative grid w-max items-center gap-y-0.5 pr-3", column)}
          style={{ gridTemplateColumns: `auto repeat(${series.length}, var(--series-column))` }}
        >
          <div role="row" className="contents">
            <div role="columnheader" data-series-row className={cx(stickyTop, stickyLeft, "z-20")}>
              <span className="sr-only">Day</span>
            </div>
            {series.map((state) => {
              const name = state.series.name.trim() || "Untitled"
              return (
                <div
                  key={state.series.id}
                  role="columnheader"
                  aria-label={name}
                  title={name}
                  data-testid="journal-column"
                  className={cx(stickyTop, "flex items-center justify-center")}
                >
                  <ColourDot colour={state.series.colour} />
                </div>
              )
            })}
          </div>
          {days.map((day) => {
            const weekday = weekdayFromMonday(day)
            return (
              <React.Fragment key={day}>
                {range === "year" && day.endsWith("-01") ? (
                  // The month over its first day, across the row.
                  <div
                    aria-hidden
                    className={cx(
                      stickyLeft,
                      "col-span-full pt-2 text-xs font-bold leading-4 text-text-secondary",
                    )}
                  >
                    {monthShortLabel(monthOf(day))}
                  </div>
                ) : null}
                <div role="row" data-testid="journal-row" className="contents">
                  <div
                    role="rowheader"
                    aria-label={dayLabel(day)}
                    data-day-row={day}
                    className={cx(
                      stickyLeft,
                      "flex h-full items-center gap-1.5 self-stretch leading-4 tabular-nums",
                      range === "year" ? "text-[10px]" : "text-xs",
                      day === today ? "font-bold text-text" : "text-text-secondary",
                      // A weekend reads lighter, as a journal's ruled page does.
                      day !== today && weekday >= 5 && "text-text-tertiary",
                    )}
                  >
                    <span className="w-2 text-center">{WEEKDAY_LABELS[weekday]}</span>
                    <span className="w-4 text-right">{Number(day.slice(8))}</span>
                  </div>
                  {series.map((state) => (
                    <DayCell
                      key={state.series.id}
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
              </React.Fragment>
            )
          })}
        </div>
      </div>
    </Surface>
  )
}
