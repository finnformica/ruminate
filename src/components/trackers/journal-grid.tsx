import React from "react"
import {
  dayLabel,
  monthLabel,
  monthOf,
  rangeDays,
  weekdayFromMonday,
  type DayString,
  type MonthString,
  type SeriesState,
  type TrackerRange,
} from "../../data/tracker"
import { cx } from "../../utils/cx"
import { Popover } from "../ui/popover"
import { Surface } from "../ui/surface"
import { ColourDot, DayCell } from "./month-grid"
import { labelledMonths, yearLabelStep } from "./month-labels"
import { NumberControl } from "./today-strip"

/** A series's column (`--series-column`) and the cell in it, per range: a
 * week has room for big cells. The column is the cell plus 4 px, the gap
 * between cells. Every cell is at least 32 px, big enough to tap on a phone,
 * and a phone (390 px) still shows six series beside the day column with no
 * sideways scroll (Finn, 2026-10-29; the year's cells grew to a month's when
 * they became the place to log a past day, 2026-11-02). `pitch` is a row's
 * height: the cell and the 2 px between rows. */
const SIZES: Record<TrackerRange, { column: string; cell: string; pitch: number }> = {
  week: { column: "[--series-column:44px]", cell: "size-10", pitch: 42 },
  month: { column: "[--series-column:36px]", cell: "size-8", pitch: 34 },
  year: { column: "[--series-column:36px]", cell: "size-8", pitch: 34 },
}

/** A row's weekday, beside its number: "Mon 2". */
const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const

/** The cell a number series's editor hangs off. */
type Editing = { seriesId: string; day: DayString; anchor: HTMLElement }

/**
 * The journal grid (docs/trackers.md, Finn 2026-10-28): the range as one
 * table, a row per day and a column per series, as a bullet journal's habit
 * page is drawn (Finn turned it on its side, 2026-10-29). At the left of each
 * day, its weekday and its number ("Mon 2"), today's number in a chip; a
 * thin line above each Monday starts a week; each month starts under a
 * divider with its name ("November 2026") just below it. The name scrolls
 * with its divider and is not pinned: a month whose first day is before the
 * range (a week that starts mid-month) has no divider in view, and no name
 * (Finn, 2026-11-02). A year names the current month and every second or
 * third month from it (month-labels.ts); the others have the divider alone.
 * Above each
 * column, only the series's colour: the Today strip's chips above the grid
 * are its legend, and the name is the column's label for a screen reader.
 *
 * Every cell up to today is logged in place: a tap on a check series's cell
 * ticks or clears the day, and on a number series's cell opens the Today
 * strip's own field and − and + for that day in a popover, so the entry is
 * the same as the strip writes. The arrow keys move between cells (a day
 * after today is not one), and Enter or Space edits, as a click does.
 *
 * The card fills the space left under the Today strip and date row, down to
 * the bottom of the viewport, rather than scroll the page: it is a flex
 * item (`flex-1 min-h-0` from its caller) and a flex column itself, so its
 * own box is the one that scrolls, under a row of colours and a day column
 * that stay put. It opens scrolled to today, so the day you log is in view
 * and its columns are still coloured. Past six series or so a phone scrolls
 * it sideways too.
 */
export function JournalGrid({
  series,
  range,
  start,
  today,
  selectedDay,
  onSetEntry,
}: {
  series: readonly SeriesState[]
  range: TrackerRange
  /** Any day in the range shown. */
  start: DayString
  today: DayString
  /** The day the strip is logging, when it is not today. */
  selectedDay: DayString
  /** A day's value on a series: `null` clears the day. */
  onSetEntry: (seriesId: string, day: DayString, value: boolean | number | null) => void
}) {
  const days = React.useMemo(() => rangeDays(range, start), [range, start])
  // The days a cell can be logged on, and the keyboard moved to.
  const loggable = React.useMemo(() => days.filter((day) => day <= today), [days, today])
  const { column, cell, pitch } = SIZES[range]
  // The range's days by month, and the months whose name is drawn: those
  // whose first day, and so whose divider, is in the range; in a year, every
  // second or third of them.
  const months = React.useMemo(() => {
    const groups: { month: MonthString; days: DayString[] }[] = []
    for (const day of days) {
      const month = monthOf(day)
      if (groups[groups.length - 1]?.month !== month) groups.push({ month, days: [] })
      groups[groups.length - 1].days.push(day)
    }
    return groups
  }, [days])
  const labelled = React.useMemo(() => {
    const all = months.filter((group) => group.days[0].endsWith("-01")).map((group) => group.month)
    return range === "year"
      ? labelledMonths(all, monthOf(today), yearLabelStep(pitch))
      : new Set(all)
  }, [months, range, today, pitch])
  const scroller = React.useRef<HTMLDivElement>(null)

  // The cell the keyboard enters the grid at (the one tab stop): the cell
  // last focused, else today's first, else the range's last day.
  const [active, setActive] = React.useState<{ day: DayString; column: number } | null>(null)
  const activeDay =
    active && loggable.includes(active.day)
      ? active.day
      : loggable.includes(today)
        ? today
        : loggable[loggable.length - 1]
  const activeColumn = Math.min(active?.column ?? 0, series.length - 1)

  const [editing, setEditing] = React.useState<Editing | null>(null)
  const editState = editing && series.find((state) => state.series.id === editing.seriesId)
  const editInput = React.useRef<HTMLInputElement>(null)
  // The cell the editor was opened from, which the keyboard goes back to.
  const editAnchor = React.useRef<HTMLElement | null>(null)
  // A tap opens the editor without the phone's keyboard over the grid.
  const pointer = React.useRef("")

  const cellAt = (day: DayString, seriesId: string) =>
    scroller.current?.querySelector<HTMLElement>(
      `[data-testid="day-cell"][data-day="${day}"][data-series="${seriesId}"]`,
    ) ?? null

  const openEditor = (seriesId: string, day: DayString) => {
    const anchor = cellAt(day, seriesId)
    if (!anchor) return
    editAnchor.current = anchor
    setEditing({ seriesId, day, anchor })
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const { day, series: seriesId } = (event.target as HTMLElement).dataset
    if (!day || !seriesId) return
    let row = loggable.indexOf(day)
    let col = series.findIndex((state) => state.series.id === seriesId)
    if (row < 0 || col < 0) return
    if (event.key === "ArrowUp") row -= 1
    else if (event.key === "ArrowDown") row += 1
    else if (event.key === "ArrowLeft") col -= 1
    else if (event.key === "ArrowRight") col += 1
    else if (event.key === "Home") col = 0
    else if (event.key === "End") col = series.length - 1
    else return
    event.preventDefault()
    row = Math.max(0, Math.min(loggable.length - 1, row))
    col = Math.max(0, Math.min(series.length - 1, col))
    setActive({ day: loggable[row], column: col })
    cellAt(loggable[row], series[col].series.id)?.focus()
  }

  const onFocus = (event: React.FocusEvent) => {
    const { day, series: seriesId } = (event.target as HTMLElement).dataset
    if (!day || !seriesId) return
    const col = series.findIndex((state) => state.series.id === seriesId)
    if (col >= 0) setActive({ day, column: col })
  }

  // Open with today in the middle of the view when the range holds it.
  React.useLayoutEffect(() => {
    const box = scroller.current
    if (!box) return
    box.scrollLeft = 0
    const row = box.querySelector<HTMLElement>(`[data-day-row="${today}"]`)
    if (!row) {
      box.scrollTop = 0
      return
    }
    // What stays put over the rows: the colours.
    const colours = box.querySelector<HTMLElement>("[data-series-row]")
    const fixed = colours?.offsetHeight ?? 0
    box.scrollTop = row.offsetTop - fixed - (box.clientHeight - fixed - row.offsetHeight) / 2
  }, [days, today])

  const stickyTop = "sticky top-0 z-20 h-8 self-stretch bg-bg-card"
  const stickyLeft = "sticky left-0 z-10 bg-bg-card pl-3 pr-2"
  return (
    <Surface
      tier="card"
      motion={false}
      data-testid="journal-grid"
      data-range={range}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* The scroll padding keeps a cell the keyboard moves to clear of the
          colours and the day column over it. */}
      <div ref={scroller} className="min-h-0 flex-1 scroll-pl-20 scroll-pt-10 overflow-auto pb-3">
        <div
          role="grid"
          aria-label="Days by series"
          // The cells are the tab stops; the grid only hears their keys.
          tabIndex={-1}
          className={cx("relative grid w-max items-center gap-y-0.5 pr-3", column)}
          style={{ gridTemplateColumns: `auto repeat(${series.length}, var(--series-column))` }}
          onPointerDown={(event) => (pointer.current = event.pointerType)}
          onKeyDown={(event) => {
            pointer.current = ""
            onKeyDown(event)
          }}
          onFocus={onFocus}
        >
          <div role="row" className="contents">
            <div role="columnheader" data-series-row className={cx(stickyTop, stickyLeft, "z-30")}>
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
          {months.map(({ month, days: monthDays }, m) => (
            // A month is a group of rows on the grid's own columns, under a
            // divider, its name just below the divider. The name is not
            // pinned: it scrolls out with its divider (Finn, 2026-11-02).
            <div
              key={month}
              role="rowgroup"
              data-month={month}
              className={cx(
                "col-span-full grid grid-cols-subgrid items-center gap-y-0.5",
                m > 0 && "mt-2 border-t border-border",
              )}
            >
              {labelled.has(month) ? (
                // The divider runs the grid's full width, so it stays in view
                // when the grid scrolls sideways; the name stays at the left
                // with it.
                <div aria-hidden data-month-label={month} className="col-span-full">
                  <span className="sticky left-0 inline-block px-3 py-1.5 text-xs font-bold leading-4 text-text-secondary">
                    {monthLabel(month)}
                  </span>
                </div>
              ) : null}
              {monthDays.map((day, d) => {
                const weekday = weekdayFromMonday(day)
                const isToday = day === today
                return (
                  <React.Fragment key={day}>
                    {d > 0 && weekday === 0 ? (
                      // A week starts on Monday: a thin line above it. A
                      // month's first day has the month's divider instead.
                      <div
                        aria-hidden
                        data-week-start={day}
                        className="col-span-full h-px bg-border-secondary"
                      />
                    ) : null}
                    <div role="row" data-testid="journal-row" className="contents">
                      <div
                        role="rowheader"
                        aria-label={dayLabel(day)}
                        aria-current={isToday ? "date" : undefined}
                        data-day-row={day}
                        className={cx(
                          stickyLeft,
                          "flex h-full items-center gap-1 self-stretch text-xs leading-4 tabular-nums",
                          isToday ? "font-bold text-text" : "text-text-secondary",
                          // A weekend reads lighter, as a journal's ruled page does.
                          !isToday && weekday >= 5 && "text-text-tertiary",
                        )}
                      >
                        <span className="w-7">{WEEKDAY_SHORT[weekday]}</span>
                        {/* Today's number in a chip, as the calendar marks it. */}
                        <span
                          className={cx(
                            "min-w-5 rounded-sm px-1 text-right",
                            isToday && "bg-text text-bg",
                          )}
                        >
                          {Number(day.slice(8))}
                        </span>
                      </div>
                      {series.map((state, c) => (
                        <DayCell
                          key={state.series.id}
                          className={cx(cell, "justify-self-center")}
                          state={state}
                          day={day}
                          days={days}
                          today={today}
                          selected={day === selectedDay && selectedDay !== today}
                          tabIndex={day === activeDay && c === activeColumn ? 0 : -1}
                          onToggle={(seriesId, cellDay, done) =>
                            onSetEntry(seriesId, cellDay, done ? true : null)
                          }
                          onPickDay={(cellDay) => openEditor(state.series.id, cellDay)}
                        />
                      ))}
                    </div>
                  </React.Fragment>
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <Popover
        open={editing !== null && editState != null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
        modal={false}
      >
        {editing && editState ? (
          <Popover.Content
            anchor={editing.anchor}
            align="center"
            width="auto"
            initialFocus={() => (pointer.current === "touch" ? true : editInput.current)}
            finalFocus={editAnchor}
          >
            <div data-testid="grid-cell-editor" className="flex flex-col gap-3 p-3">
              <h3 className="text-sm font-bold leading-4">{dayLabel(editing.day)}</h3>
              <NumberControl
                state={editState}
                day={editing.day}
                onSetEntry={onSetEntry}
                inputRef={editInput}
                onDone={() => setEditing(null)}
              />
            </div>
          </Popover.Content>
        ) : null}
      </Popover>
    </Surface>
  )
}
