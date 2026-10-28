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
import { MonthGrid } from "../components/trackers/month-grid"
import { SeriesDialog } from "../components/trackers/series-dialog"
import { TodayStrip } from "../components/trackers/today-strip"
import { Button } from "../components/ui/button"
import { IconButton } from "../components/ui/icon-button"
import { PillButton } from "../components/ui/pill-button"
import { addMonths, localDay, monthLabel, monthOf, type DayString } from "../data/tracker"
import { useNoteById } from "../hooks/note"
import { useTracker, useTrackerWrites } from "../hooks/tracker"

/**
 * A tracker (docs/trackers.md): a note whose root node is of type `tracker`,
 * shown as a month grid of its series with a strip to log today. Its header
 * is the note's own ⋯ menu, which adds **Series**. Everything on screen is
 * the note's own graph — the same rows its outline shows — read and written
 * through the same seams. A note of another type is refused: it is opened
 * as a note.
 */

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
  // The month shown: this one until the arrows say otherwise.
  const [month, setMonth] = React.useState(() => monthOf(today))
  // The day the strip logs: today, or a day picked on a number series's grid.
  const [pickedDay, setPickedDay] = React.useState<DayString | null>(null)
  const day = pickedDay ?? today
  const thisMonth = monthOf(today)
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
                  to="/views/$"
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
            <div className="flex items-center gap-1">
              <IconButton
                aria-label="Previous month"
                onClick={() => setMonth(addMonths(month, -1))}
              >
                <ChevronLeftIcon16 />
              </IconButton>
              <h2 className="min-w-0 truncate font-bold [font-variant-numeric:tabular-nums]">
                {monthLabel(month)}
              </h2>
              <IconButton
                aria-label="Next month"
                disabled={month >= thisMonth}
                onClick={() => setMonth(addMonths(month, 1))}
              >
                <ChevronRightIcon16 />
              </IconButton>
              {month !== thisMonth ? (
                <PillButton variant="dashed" onClick={() => setMonth(thisMonth)}>
                  This month
                </PillButton>
              ) : null}
            </div>
            {series.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center text-text-secondary">
                <p>No series yet. Add one to start logging.</p>
                <Button icon={<PlusIcon16 />} onClick={() => setSeriesOpen(true)}>
                  Add series
                </Button>
              </div>
            ) : (
              <MonthGrid
                series={series}
                month={month}
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
