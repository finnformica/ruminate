import React from "react"
import { addDays, dayLabel, type DayString, type SeriesState } from "../../data/tracker"
import { useCoarsePointer } from "../../hooks/coarse-pointer"
import { ChevronLeftIcon16, ChevronRightIcon16 } from "../icons"
import { Dialog } from "../ui/dialog"
import { IconButton } from "../ui/icon-button"
import { Sheet } from "../ui/sheet"
import { DayControls } from "./today-strip"

/**
 * The day editor (docs/trackers.md, Finn 2026-11-03): a tap on a day in the
 * heatmap or on a card opens that day, with a control per series to add,
 * change or clear its value, as the Today strip has for today. Every change
 * is written as it is made, through the same `onSetEntry`. The arrows in the
 * header step a day back or on; a day after today cannot be opened. On a
 * phone it is a sheet from the foot of the screen.
 */
export function DayDialog({
  series,
  day,
  today,
  onSetEntry,
  onDayChange,
  onClose,
}: {
  series: readonly SeriesState[]
  /** The day open, or null when the editor is closed. */
  day: DayString | null
  today: DayString
  onSetEntry: (seriesId: string, day: DayString, value: boolean | number | null) => void
  onDayChange: (day: DayString) => void
  onClose: () => void
}) {
  const coarse = useCoarsePointer()
  // Focus opens on the day's controls, not on the header's arrows, whose
  // tooltip would cover them.
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const onOpenChange = (next: boolean) => (next ? undefined : onClose())
  if (day === null || day > today) return null
  const title = day === today ? "Today" : day === addDays(today, -1) ? "Yesterday" : dayLabel(day)
  const actions = (
    <>
      <IconButton aria-label="Previous day" onClick={() => onDayChange(addDays(day, -1))}>
        <ChevronLeftIcon16 />
      </IconButton>
      <IconButton
        aria-label="Next day"
        disabled={day >= today}
        onClick={() => onDayChange(addDays(day, 1))}
      >
        <ChevronRightIcon16 />
      </IconButton>
    </>
  )
  const body = (
    <div
      ref={bodyRef}
      tabIndex={-1}
      data-testid="day-editor"
      data-day={day}
      className="flex flex-col gap-4 focus:outline-hidden"
    >
      {title === dayLabel(day) ? null : (
        <p className="text-sm text-text-secondary">{dayLabel(day)}</p>
      )}
      <DayControls series={series} day={day} onSetEntry={onSetEntry} idPrefix="day" />
    </div>
  )
  if (coarse) {
    return (
      <Sheet open onOpenChange={onOpenChange}>
        <Sheet.Content title={title} titleBar actions={actions}>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">{body}</div>
        </Sheet.Content>
      </Sheet>
    )
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <Dialog.Content title={title} actions={actions} initialFocus={bodyRef}>
        {body}
      </Dialog.Content>
    </Dialog>
  )
}
