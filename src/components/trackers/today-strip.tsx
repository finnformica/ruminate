import React from "react"
import {
  addDays,
  dayLabel,
  formatAmount,
  isDone,
  stepValue,
  type DayString,
  type SeriesState,
} from "../../data/tracker"
import { FormControl } from "../form-control"
import { ChevronLeftIcon16, ChevronRightIcon16, MinusIcon16, PlusIcon16 } from "../icons"
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
 * Today by default; the arrows beside the heading step it back a day at a
 * time, and **Yesterday** goes straight to the day before (Finn,
 * 2026-11-03: an activity done in the evening is often logged the next
 * morning), with **Today** to come back. A day after today cannot be
 * picked. The controls wrap, so on a phone the strip grows down rather than
 * sideways.
 */
export function TodayStrip({
  series,
  day,
  today,
  onSetEntry,
  onDayChange,
}: {
  series: readonly SeriesState[]
  /** The day being logged. */
  day: DayString
  today: DayString
  onSetEntry: SetEntry
  onDayChange: (day: DayString) => void
}) {
  const isToday = day === today
  const yesterday = addDays(today, -1)
  return (
    <section data-testid="today-strip" className="flex flex-col gap-4">
      <div className="flex min-w-0 items-center gap-1">
        <IconButton aria-label="Previous day" onClick={() => onDayChange(addDays(day, -1))}>
          <ChevronLeftIcon16 />
        </IconButton>
        <h2 className="min-w-0 truncate font-bold leading-4">
          {isToday ? "Today" : day === yesterday ? "Yesterday" : dayLabel(day)}
        </h2>
        <IconButton
          aria-label="Next day"
          disabled={day >= today}
          onClick={() => onDayChange(addDays(day, 1))}
        >
          <ChevronRightIcon16 />
        </IconButton>
        {isToday ? (
          <PillButton variant="dashed" onClick={() => onDayChange(yesterday)}>
            Yesterday
          </PillButton>
        ) : (
          <PillButton variant="dashed" onClick={() => onDayChange(today)}>
            Today
          </PillButton>
        )}
      </div>
      <DayControls series={series} day={day} onSetEntry={onSetEntry} idPrefix="today" />
    </section>
  )
}

/** A day's value on a series: `null` or `false` clears the day. */
type SetEntry = (seriesId: string, day: DayString, value: boolean | number | null) => void

/**
 * One control per series for one day: the check pills in a row, then the
 * number fields. The Today strip and the day editor (day-dialog.tsx) both
 * draw these, and both write through the same `onSetEntry`. `idPrefix`
 * keeps the fields' ids apart when both are on the page.
 */
export function DayControls({
  series,
  day,
  onSetEntry,
  idPrefix,
}: {
  series: readonly SeriesState[]
  day: DayString
  onSetEntry: SetEntry
  idPrefix: string
}) {
  const checks = series.filter((state) => state.series.kind === "check")
  const numbers = series.filter((state) => state.series.kind === "number")
  return (
    <>
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
            // Keyed by the day too, so a value typed and not yet committed
            // does not follow the field to another day.
            <li key={`${state.series.id}-${day}`} className="min-w-0 max-w-full">
              <NumberControl
                state={state}
                day={day}
                onSetEntry={onSetEntry}
                id={`${idPrefix}-${state.series.id}`}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

function CheckControl({
  state,
  day,
  onSetEntry,
}: {
  state: SeriesState
  day: DayString
  onSetEntry: SetEntry
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
  id,
}: {
  state: SeriesState
  day: DayString
  onSetEntry: SetEntry
  /** The field's id, for its label. */
  id: string
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
