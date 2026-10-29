import { Link, createFileRoute } from "@tanstack/react-router"
import React from "react"
import {
  TrackerIcon16,
  ChevronLeftIcon16,
  ChevronRightIcon16,
  PlusIcon16,
} from "../components/icons"
import { NoteActionsMenu } from "../components/note-actions-menu"
import { Notice } from "../components/notice"
import { PageLayout } from "../components/page-layout"
import { RootLink } from "../components/root-link"
import { JournalGrid } from "../components/trackers/journal-grid"
import { MonthGrid } from "../components/trackers/month-grid"
import { SeriesDialog } from "../components/trackers/series-dialog"
import { TodayStrip } from "../components/trackers/today-strip"
import { Button } from "../components/ui/button"
import { IconButton } from "../components/ui/icon-button"
import { PillButton } from "../components/ui/pill-button"
import {
  TRACKER_RANGES,
  localDay,
  rangeLabel,
  rangeStart,
  shiftRange,
  type DayString,
  type TrackerRange,
} from "../data/tracker"
import { useNoteById } from "../hooks/note"
import { useTracker, useTrackerWrites } from "../hooks/tracker"

/**
 * A tracker (docs/trackers.md): a note whose root node is of type `tracker`,
 * shown as a month grid of its series with a strip to log today. Its header
 * is the note's own ⋯ menu, which adds **Series**. Everything on screen is
 * the note's own graph — the same rows its outline shows — read and written
 * through the same seams. A note of another type is refused: it is opened
 * as a note.
 *
 * The range switch shows a week, a month or a year; the layout switch draws
 * it as cards (one per series) or as the journal grid (a row per series, a
 * column per day). The cell is one day in all six.
 */

const RANGE_LABELS: Record<TrackerRange, string> = { week: "Week", month: "Month", year: "Year" }

const LAYOUTS = ["cards", "grid"] as const
type TrackerLayout = (typeof LAYOUTS)[number]
const LAYOUT_LABELS: Record<TrackerLayout, string> = { cards: "Cards", grid: "Grid" }

/** A row of buttons of which one is chosen, as Settings → Theme is drawn. */
function Switch<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string
  options: readonly T[]
  labels: Record<T, string>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-1">
      {options.map((option) => (
        <Button
          key={option}
          size="small"
          data-option={option}
          aria-pressed={option === value}
          selected={option === value}
          onClick={() => onChange(option)}
        >
          {labels[option]}
        </Button>
      ))}
    </div>
  )
}

export const Route = createFileRoute("/_appRoot/trackers/$")({
  component: RouteComponent,
})

function RouteComponent() {
  const { _splat: trackerId = "" } = Route.useParams()
  return <TrackerPage key={trackerId} trackerId={trackerId} />
}

/** The viewer's local day, moved on at midnight while the page stays open. */
function useToday(): DayString {
  const [today, setToday] = React.useState(() => localDay())
  React.useEffect(() => {
    const tick = window.setInterval(() => setToday(localDay()), 60_000)
    return () => window.clearInterval(tick)
  }, [])
  return today
}

function TrackerPage({ trackerId }: { trackerId: string }) {
  const note = useNoteById(trackerId)
  const { exists, series } = useTracker(trackerId)
  const writes = useTrackerWrites(trackerId, exists)
  const today = useToday()
  // The range shown, and how: this month as cards until the switches say
  // otherwise.
  const [range, setRange] = React.useState<TrackerRange>("month")
  const [layout, setLayout] = React.useState<TrackerLayout>("cards")
  // The first day of the range shown: the one today is in until the arrows
  // say otherwise.
  const [start, setStart] = React.useState(() => rangeStart("month", today))
  // The day the strip logs: today, or a day picked on a number series's grid.
  const [pickedDay, setPickedDay] = React.useState<DayString | null>(null)
  const day = pickedDay ?? today
  const current = rangeStart(range, today)
  // A new range keeps today in view when the old one held it, else the
  // range the old one began in.
  const changeRange = (next: TrackerRange) => {
    setStart(rangeStart(next, start === current ? today : start))
    setRange(next)
  }
  const [seriesOpen, setSeriesOpen] = React.useState(false)

  return (
    <PageLayout
      title={<span className="truncate">{note?.displayName || "Untitled"}</span>}
      icon={
        <RootLink>
          <TrackerIcon16 />
        </RootLink>
      }
      actions={
        <NoteActionsMenu
          noteId={trackerId}
          align="end"
          surface="tracker"
          onSeries={exists ? () => setSeriesOpen(true) : undefined}
        />
      }
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
        {!exists ? (
          <Notice>
            {note ? (
              <>
                This note is not a tracker.{" "}
                <Link
                  to="/notes/$"
                  params={{ _splat: trackerId }}
                  search={{ query: undefined }}
                  className="link"
                >
                  Open it as a note
                </Link>
                , or make a new tracker from the header.
              </>
            ) : (
              <>There is no tracker here. Make one with New tracker in the header.</>
            )}
          </Notice>
        ) : (
          <>
            <TodayStrip
              series={series}
              day={day}
              today={today}
              onSetEntry={writes.setEntry}
              onBackToToday={() => setPickedDay(null)}
            />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex min-w-0 items-center gap-1">
                <IconButton
                  aria-label={`Previous ${range}`}
                  onClick={() => setStart(shiftRange(range, start, -1))}
                >
                  <ChevronLeftIcon16 />
                </IconButton>
                <h2 className="min-w-0 truncate font-bold [font-variant-numeric:tabular-nums]">
                  {rangeLabel(range, start)}
                </h2>
                <IconButton
                  aria-label={`Next ${range}`}
                  disabled={start >= current}
                  onClick={() => setStart(shiftRange(range, start, 1))}
                >
                  <ChevronRightIcon16 />
                </IconButton>
                {start !== current ? (
                  <PillButton variant="dashed" onClick={() => setStart(current)}>
                    This {range}
                  </PillButton>
                ) : null}
              </div>
              <div className="flex items-center gap-3 sm:ml-auto">
                <Switch
                  label="Range"
                  options={TRACKER_RANGES}
                  labels={RANGE_LABELS}
                  value={range}
                  onChange={changeRange}
                />
                <Switch
                  label="Layout"
                  options={LAYOUTS}
                  labels={LAYOUT_LABELS}
                  value={layout}
                  onChange={setLayout}
                />
              </div>
            </div>
            {series.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center text-text-secondary">
                <p>No series yet. Add one to start logging.</p>
                <Button icon={<PlusIcon16 />} onClick={() => setSeriesOpen(true)}>
                  Add series
                </Button>
              </div>
            ) : layout === "grid" ? (
              <JournalGrid
                series={series}
                range={range}
                start={start}
                today={today}
                selectedDay={day}
                onToggle={(seriesId, cellDay, done) =>
                  writes.setEntry(seriesId, cellDay, done ? true : null)
                }
                onPickDay={(cellDay) => setPickedDay(cellDay === today ? null : cellDay)}
              />
            ) : (
              <MonthGrid
                series={series}
                range={range}
                start={start}
                today={today}
                selectedDay={day}
                onToggle={(seriesId, cellDay, done) =>
                  writes.setEntry(seriesId, cellDay, done ? true : null)
                }
                onPickDay={(cellDay) => setPickedDay(cellDay === today ? null : cellDay)}
              />
            )}
            <SeriesDialog
              open={seriesOpen && exists}
              series={series}
              writes={writes}
              onClose={() => setSeriesOpen(false)}
            />
          </>
        )}
      </div>
    </PageLayout>
  )
}
