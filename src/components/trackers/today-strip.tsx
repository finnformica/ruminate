import React from "react"
import {
  dayLabel,
  formatAmount,
  isDone,
  stepValue,
  type DayString,
  type SeriesState,
} from "../../data/tracker"
import { cx } from "../../utils/cx"
import { CheckIcon16, PlusIcon16 } from "../icons"
import { IconButton } from "../ui/icon-button"
import { PillButton } from "../ui/pill-button"
import { colourVar } from "./month-grid"

/** A minus sign at the icon's size, for the step-down control. */
function MinusIcon16(props: React.ComponentPropsWithoutRef<"svg">) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden {...props}>
      <path d="M2.75 7.25a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5H2.75Z" />
    </svg>
  )
}

/**
 * The Today strip (docs/trackers.md): one control per series to log the day
 * fast. A check series is a pill that ticks and clears the day; a number
 * series is its value with − and + by the series's `step`, and the value
 * itself a field to type into. Today by default; a tap on a number series's
 * cell in the grid points the strip at that day instead, named in the
 * heading, with **Today** to come back. The controls wrap, so on a phone the
 * strip grows down rather than sideways.
 */
export function TodayStrip({
  series,
  day,
  today,
  onSetEntry,
  onBackToToday,
}: {
  series: readonly SeriesState[]
  /** The day being logged. */
  day: DayString
  today: DayString
  onSetEntry: (seriesId: string, day: DayString, value: boolean | number | null) => void
  onBackToToday: () => void
}) {
  const isToday = day === today
  return (
    <section data-testid="today-strip" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="font-bold">{isToday ? "Today" : dayLabel(day)}</h2>
        {isToday ? null : (
          <PillButton variant="dashed" onClick={onBackToToday}>
            Today
          </PillButton>
        )}
      </div>
      {series.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2">
          {series.map((state) =>
            state.series.kind === "check" ? (
              <li key={state.series.id} className="min-w-0 max-w-full">
                <CheckControl state={state} day={day} onSetEntry={onSetEntry} />
              </li>
            ) : (
              <li key={state.series.id} className="min-w-0 max-w-full">
                <NumberControl state={state} day={day} onSetEntry={onSetEntry} />
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  )
}

function CheckControl({
  state,
  day,
  onSetEntry,
}: {
  state: SeriesState
  day: DayString
  onSetEntry: (seriesId: string, day: DayString, value: boolean | number | null) => void
}) {
  const { series } = state
  const done = isDone(state, day)
  const name = series.name.trim() || "Untitled"
  return (
    <PillButton
      variant="secondary"
      aria-pressed={done}
      data-testid="check-control"
      className={cx("max-w-full", done && "font-bold")}
      style={done ? { backgroundColor: colourVar(series.colour, 4) } : undefined}
      onClick={() => onSetEntry(series.id, day, done ? null : true)}
    >
      <span
        className="grid size-4 shrink-0 place-items-center rounded-full"
        style={{ backgroundColor: colourVar(series.colour, done ? 9 : 5) }}
      >
        {done ? <CheckIcon16 className="size-3 text-bg" /> : null}
      </span>
      <span className="truncate">{name}</span>
    </PillButton>
  )
}

function NumberControl({
  state,
  day,
  onSetEntry,
}: {
  state: SeriesState
  day: DayString
  onSetEntry: (seriesId: string, day: DayString, value: boolean | number | null) => void
}) {
  const { series } = state
  const entry = state.entries.get(day)
  const current = typeof entry?.value === "number" ? entry.value : 0
  const name = series.name.trim() || "Untitled"
  // What is typed, until it is committed on blur or Enter.
  const [draft, setDraft] = React.useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const text = draft.trim()
    setDraft(null)
    if (text === "") return onSetEntry(series.id, day, null)
    const value = Number(text)
    if (!Number.isFinite(value)) return
    onSetEntry(series.id, day, value === 0 ? null : value)
  }
  const set = (value: number) => onSetEntry(series.id, day, value === 0 ? null : value)
  const atMin = current <= (series.min ?? 0)
  const atMax = series.max !== null && current >= series.max
  return (
    <div
      data-testid="number-control"
      className="flex h-8 max-w-full items-center gap-1 rounded-full bg-bg-secondary pl-2.5 pr-1 coarse:h-10"
      style={entry ? { backgroundColor: colourVar(series.colour, 4) } : undefined}
    >
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: colourVar(series.colour, 9) }}
      />
      <span className="min-w-0 truncate text-sm">{name}</span>
      <IconButton
        aria-label={`Less ${name}`}
        size="small"
        disabled={atMin}
        onClick={() => set(stepValue(series, current, -1))}
      >
        <MinusIcon16 />
      </IconButton>
      <input
        aria-label={`${name} on ${dayLabel(day)}`}
        inputMode="decimal"
        className="focus-ring w-12 rounded bg-transparent text-center text-sm [font-variant-numeric:tabular-nums]"
        value={draft ?? (entry ? formatAmount({ unit: "" }, current) : "")}
        placeholder="0"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
            event.currentTarget.blur()
          }
        }}
      />
      {series.unit ? <span className="text-sm text-text-secondary">{series.unit}</span> : null}
      <IconButton
        aria-label={`More ${name}`}
        size="small"
        disabled={atMax}
        onClick={() => set(stepValue(series, current, 1))}
      >
        <PlusIcon16 />
      </IconButton>
    </div>
  )
}
