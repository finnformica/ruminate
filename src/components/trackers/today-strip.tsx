import React from "react"
import {
  dayLabel,
  formatAmount,
  isDone,
  stepValue,
  type DayString,
  type SeriesState,
} from "../../data/tracker"
import { FormControl } from "../form-control"
import { MinusIcon16, PlusIcon16 } from "../icons"
import { IconButton } from "../ui/icon-button"
import { PillButton } from "../ui/pill-button"
import { TextInput } from "../ui/text-input"
import { ColourDot } from "./month-grid"

/**
 * The Today strip (docs/trackers.md): one control per series to log the day
 * fast. A check series is a pill that ticks and clears the day — pressed, it
 * wears the pill's applied state, as a scope pill does. A number series is
 * a field with − and + by the series's `step`, laid out as the app's forms
 * are. The series's colour is the dot beside its name and nothing else.
 * Today by default; a tap on a number series's cell in the grid points the
 * strip at that day instead, named in the heading, with **Today** to come
 * back. The controls wrap, so on a phone the strip grows down rather than
 * sideways.
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
  const checks = series.filter((state) => state.series.kind === "check")
  const numbers = series.filter((state) => state.series.kind === "number")
  return (
    <section data-testid="today-strip" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="font-bold leading-4">{isToday ? "Today" : dayLabel(day)}</h2>
        {isToday ? null : (
          <PillButton variant="dashed" onClick={onBackToToday}>
            Today
          </PillButton>
        )}
      </div>
      {checks.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {checks.map((state) => (
            <li key={state.series.id} className="min-w-0 max-w-full">
              <CheckControl state={state} day={day} onSetEntry={onSetEntry} />
            </li>
          ))}
        </ul>
      ) : null}
      {numbers.length > 0 ? (
        <ul className="flex flex-wrap gap-4">
          {numbers.map((state) => (
            <li key={state.series.id} className="min-w-0 max-w-full">
              <NumberControl state={state} day={day} onSetEntry={onSetEntry} />
            </li>
          ))}
        </ul>
      ) : null}
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
      variant={done ? "primary" : "secondary"}
      aria-pressed={done}
      data-testid="check-control"
      className="max-w-full"
      onClick={() => onSetEntry(series.id, day, done ? null : true)}
    >
      <ColourDot colour={series.colour} />
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
  const id = `today-${series.id}`
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
    <FormControl
      htmlFor={id}
      label={
        <span className="flex items-center gap-2">
          <ColourDot colour={series.colour} />
          {name}
        </span>
      }
      className="w-auto"
    >
      <div data-testid="number-control" className="flex items-center gap-2">
        <IconButton
          aria-label={`Less ${name}`}
          disabled={atMin}
          onClick={() => set(stepValue(series, current, -1))}
        >
          <MinusIcon16 />
        </IconButton>
        <TextInput
          id={id}
          type="number"
          inputMode="decimal"
          step={series.step}
          min={series.min ?? 0}
          max={series.max ?? undefined}
          className="w-20 tabular-nums"
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
          disabled={atMax}
          onClick={() => set(stepValue(series, current, 1))}
        >
          <PlusIcon16 />
        </IconButton>
      </div>
    </FormControl>
  )
}
