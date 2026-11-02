import { Link, createFileRoute } from "@tanstack/react-router"
import React, { useSyncExternalStore } from "react"
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
import { ActivityCard, TrackerStats } from "../components/trackers/activity"
import { DisplayGroups, type TrackerView } from "../components/trackers/display-groups"
import { MonthGrid } from "../components/trackers/month-grid"
import { SeriesDialog } from "../components/trackers/series-dialog"
import { TodayStrip } from "../components/trackers/today-strip"
import { Button } from "../components/ui/button"
import { IconButton } from "../components/ui/icon-button"
import { PillButton } from "../components/ui/pill-button"
import { localDay, rangeLabel, rangeStart, shiftRange, type DayString } from "../data/tracker"
import { useNoteById } from "../hooks/note"
import { useTracker, useTrackerWrites } from "../hooks/tracker"
import { cx } from "../utils/cx"

/**
 * A tracker (docs/trackers.md): a note whose root node is of type `tracker`,
 * shown as a month grid of its series with a strip to log today. Its header
 * is the note's own ⋯ menu, which adds **Series**. Everything on screen is
 * the note's own graph — the same rows its outline shows — read and written
 * through the same seams. A note of another type is refused: it is opened
 * as a note.
 *
 * Over it all, a row of stats; under the Today strip, the activity card (a
 * heatmap of the last twelve weeks and the newest entries, activity.tsx)
 * beside the month as cards, one per series (month-grid.tsx). A phone or a
 * narrow window has room for one of the two: the heatmap until the menu's
 * display options pick **Cards** (Finn, 2026-11-02). A wide window shows
 * both, and the menu has no display options. Nothing about the display is
 * saved: every visit opens on the heatmap.
 */

/** The month the cards show. */
const RANGE = "month"

/** The width at which the activity card and the range sit side by side:
 * Tailwind's `lg`, which the classes below key off too. */
const WIDE_QUERY = "(min-width: 1024px)"

function wideQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null
  return window.matchMedia(WIDE_QUERY)
}

function subscribeWide(onChange: () => void): () => void {
  const list = wideQuery()
  if (!list) return () => {}
  list.addEventListener("change", onChange)
  return () => list.removeEventListener("change", onChange)
}

/** Whether the window is wide enough for both views (`WIDE_QUERY`): the
 * menu's display options are only there when it is not. */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => wideQuery()?.matches ?? false,
    () => false,
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
  // The first day of the month shown: the one today is in until the arrows
  // say otherwise.
  const [start, setStart] = React.useState(() => rangeStart(RANGE, today))
  // The day the strip logs: today, or a day picked on a number series's grid.
  const [pickedDay, setPickedDay] = React.useState<DayString | null>(null)
  const day = pickedDay ?? today
  const current = rangeStart(RANGE, today)
  const [seriesOpen, setSeriesOpen] = React.useState(false)
  const [narrowView, setNarrowView] = React.useState<TrackerView>("heatmap")
  const wide = useWide()

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
          groups={
            exists && !wide ? (
              <DisplayGroups view={narrowView} onViewChange={setNarrowView} />
            ) : undefined
          }
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
            {series.length > 0 ? <TrackerStats series={series} today={today} /> : null}
            <TodayStrip
              series={series}
              day={day}
              today={today}
              onSetEntry={writes.setEntry}
              onBackToToday={() => setPickedDay(null)}
            />
            {series.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center text-text-secondary">
                <p>No series yet. Add one to start logging.</p>
                <Button icon={<PlusIcon16 />} onClick={() => setSeriesOpen(true)}>
                  Add series
                </Button>
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
                <ActivityCard
                  series={series}
                  today={today}
                  className={cx("lg:w-80 lg:shrink-0", narrowView === "cards" && "max-lg:hidden")}
                />
                <div
                  data-testid="tracker-range"
                  className={cx(
                    "flex min-w-0 flex-1 flex-col gap-4",
                    narrowView === "heatmap" && "max-lg:hidden",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-1">
                    <IconButton
                      aria-label={`Previous ${RANGE}`}
                      onClick={() => setStart(shiftRange(RANGE, start, -1))}
                    >
                      <ChevronLeftIcon16 />
                    </IconButton>
                    <h2 className="min-w-0 truncate font-bold [font-variant-numeric:tabular-nums]">
                      {rangeLabel(RANGE, start)}
                    </h2>
                    <IconButton
                      aria-label={`Next ${RANGE}`}
                      disabled={start >= current}
                      onClick={() => setStart(shiftRange(RANGE, start, 1))}
                    >
                      <ChevronRightIcon16 />
                    </IconButton>
                    {start !== current ? (
                      <PillButton variant="dashed" onClick={() => setStart(current)}>
                        This {RANGE}
                      </PillButton>
                    ) : null}
                  </div>
                  <MonthGrid
                    series={series}
                    start={start}
                    today={today}
                    selectedDay={day}
                    onToggle={(seriesId, cellDay, done) =>
                      writes.setEntry(seriesId, cellDay, done ? true : null)
                    }
                    onPickDay={(cellDay) => setPickedDay(cellDay === today ? null : cellDay)}
                  />
                </div>
              </div>
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
