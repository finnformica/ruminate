import { Link, createFileRoute } from "@tanstack/react-router"
import React from "react"
import {
  TrackerIcon16,
  ChevronLeftIcon16,
  ChevronRightIcon16,
  PlusIcon16,
  SettingsIcon16,
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
import { DropdownMenu } from "../components/ui/dropdown-menu"
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
import { cx } from "../utils/cx"

/**
 * A tracker (docs/trackers.md): a note whose root node is of type `tracker`,
 * shown as a month grid of its series with a strip to log today. Its header
 * is the note's own ⋯ menu, which adds **Series**. Everything on screen is
 * the note's own graph — the same rows its outline shows — read and written
 * through the same seams. A note of another type is refused: it is opened
 * as a note.
 *
 * The display menu in the header shows a week, a month or a year, drawn as
 * cards (one per series) or as the journal grid (a row per day, a column
 * per series). The cell is one day in all six.
 */

const RANGE_LABELS: Record<TrackerRange, string> = { week: "Week", month: "Month", year: "Year" }

const LAYOUTS = ["cards", "grid"] as const
type TrackerLayout = (typeof LAYOUTS)[number]
const LAYOUT_LABELS: Record<TrackerLayout, string> = { cards: "Cards", grid: "Grid" }

/**
 * The display menu, beside the note's ⋯ menu (Finn, 2026-10-29): the range
 * and the layout, as two groups of which one row each is ticked. A pick
 * leaves the menu open, so both can be set at once.
 */
function DisplayMenu({
  range,
  layout,
  onRangeChange,
  onLayoutChange,
}: {
  range: TrackerRange
  layout: TrackerLayout
  onRangeChange: (range: TrackerRange) => void
  onLayoutChange: (layout: TrackerLayout) => void
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton
            aria-label={`Display: ${RANGE_LABELS[range]}, ${LAYOUT_LABELS[layout]}`}
            size="small"
            disableTooltip
            className="shrink-0"
          >
            <SettingsIcon16 />
          </IconButton>
        }
      />
      <DropdownMenu.Content align="end" className="w-48">
        <DropdownMenu.Group>
          <DropdownMenu.GroupLabel>Range</DropdownMenu.GroupLabel>
          {TRACKER_RANGES.map((option) => (
            <DropdownMenu.Item
              key={option}
              closeOnClick={false}
              selected={option === range}
              onClick={() => onRangeChange(option)}
            >
              {RANGE_LABELS[option]}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.GroupLabel>Layout</DropdownMenu.GroupLabel>
          {LAYOUTS.map((option) => (
            <DropdownMenu.Item
              key={option}
              closeOnClick={false}
              selected={option === layout}
              onClick={() => onLayoutChange(option)}
            >
              {LAYOUT_LABELS[option]}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
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
  // The range shown, and how: this month as cards until the display menu
  // says otherwise.
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
        <div className="flex items-center">
          {exists ? (
            <DisplayMenu
              range={range}
              layout={layout}
              onRangeChange={changeRange}
              onLayoutChange={setLayout}
            />
          ) : null}
          <NoteActionsMenu
            noteId={trackerId}
            align="end"
            surface="tracker"
            onSeries={exists ? () => setSeriesOpen(true) : undefined}
          />
        </div>
      }
    >
      <div
        className={cx(
          "mx-auto flex w-full max-w-6xl flex-col gap-4 p-4",
          // Grid layout fills the page rather than scroll it: the card below
          // is the flex item that takes the space left over, and scrolls
          // inside itself (journal-grid.tsx). Cards layout keeps the page's
          // own scroll, so this column stays its natural, unbounded height.
          layout === "grid" && "h-full min-h-0",
        )}
      >
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
