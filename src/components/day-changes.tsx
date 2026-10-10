import { Link } from "@tanstack/react-router"
import { addDays, parseISO, startOfISOWeek } from "date-fns"
import { useAtom, useAtomValue } from "jotai"
import React from "react"
import {
  changesIn,
  daysWithChanges,
  sittingsIn,
  type NoteChange,
  type PeriodChanges,
  type Sitting,
} from "../data/day-changes"
import {
  databaseEventLog,
  databaseModeStatusAtom,
  eventLogVersionAtom,
} from "../data/database-mode"
import type { LoggedEvent } from "../data/events"
import { isMintedNoteId } from "../data/note-identity"
import { writerTimezone } from "../data/writer-identity"
import { calendarChangesViewAtom, isDatabaseModeAtom } from "../global-state"
import { cx } from "../utils/cx"
import { formatDate, isValidWeekString, toDateString, toWeekString } from "../utils/date"
import { BlockEditor } from "./block-editor/block-editor"
import { useDateMarks } from "./date-mentions"
import { NoteIcon16 } from "./icons"
import { Button } from "./ui/button"
import { Skeleton } from "./ui/skeleton"
import { surface } from "./ui/surface"

const noop = () => {}

/**
 * The tenant's event log as this device holds it, re-read whenever it moves
 * (`eventLogVersionAtom`): what the calendar folds its days from
 * (docs/event-sourcing.md). Null signed out, and while the store is opening.
 */
export function useEventLog(): LoggedEvent[] | null {
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const { status } = useAtomValue(databaseModeStatusAtom)
  const version = useAtomValue(eventLogVersionAtom)
  const ready = isDatabaseMode && status === "ready"
  const [log, setLog] = React.useState<LoggedEvent[] | null>(null)
  React.useEffect(() => {
    if (!ready) return
    let cancelled = false
    void databaseEventLog().then((read) => {
      if (!cancelled) setLog(read)
    })
    return () => {
      cancelled = true
    }
  }, [ready, version])
  return ready ? log : null
}

/** The days something was written on, or a note names in a date-valued
 * property (`useDateMarks`), and the weeks holding them — what the calendar
 * dots. */
export function useCalendarMarks(log: LoggedEvent[] | null): ReadonlySet<string> {
  const dates = useDateMarks()
  return React.useMemo(() => {
    const marked = new Set(dates)
    if (log === null) return marked
    for (const day of daysWithChanges(log, writerTimezone())) {
      marked.add(day)
      marked.add(toWeekString(parseISO(day)))
    }
    return marked
  }, [log, dates])
}

/**
 * What was written on a day — or in a week — of the calendar
 * (docs/event-sourcing.md, "A day on the calendar"): every note changed on
 * it, drawn by the block editor with what the day did to each row marked
 * (`BlockEditor.diff`). Two ways to read it, kept as a display setting: **by
 * note**, each note once with the whole period's changes, or **in order**,
 * sitting by sitting as the day happened (`sittingsIn`). Folded from the
 * device's copy of the event log, so it is read-only by nature.
 */
export function DayChanges({ periodId, log }: { periodId: string; log: LoggedEvent[] | null }) {
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const [view, setView] = useAtom(calendarChangesViewAtom)
  // Fold rows the reader has opened (`DiffMark`, kind `fold`): the ids are
  // stable across re-reads of the log, so an opened fold stays open.
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const expandFold = React.useCallback(
    (foldId: string) => setExpanded((prev) => new Set(prev).add(foldId)),
    [],
  )
  const isWeek = isValidWeekString(periodId)
  const viewerTz = writerTimezone()

  const changes = React.useMemo(
    () => (log === null ? null : changesIn(log, periodId, viewerTz, { expanded })),
    [log, periodId, viewerTz, expanded],
  )

  if (!isDatabaseMode) {
    return (
      <section aria-label="Changes" className="flex flex-col gap-4">
        <h2 className="font-bold text-text">Changes</h2>
        <p className="text-text-secondary">Sign in to see what was written on each day.</p>
      </section>
    )
  }

  return (
    <section aria-label="Changes" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h2 className="flex items-baseline gap-2 font-bold text-text">
          Changes
          {changes !== null && changes.notes.length > 0 ? (
            <span className="font-normal text-text-secondary">{summaryOf(changes)}</span>
          ) : null}
        </h2>
        {changes !== null && changes.notes.length > 0 ? (
          <div role="group" aria-label="Show changes" className="ml-auto flex gap-1">
            <Button size="small" selected={view === "notes"} onClick={() => setView("notes")}>
              By note
            </Button>
            <Button size="small" selected={view === "timeline"} onClick={() => setView("timeline")}>
              In order
            </Button>
          </div>
        ) : null}
      </div>
      {changes?.approximate ? (
        // The log was seeded from the rows it found (docs/event-sourcing.md,
        // "Before history began"): a row's last save is all it knows of
        // the days before, so those rows draw as last saved, not written.
        <p className="text-sm text-text-secondary">
          History before this update is approximate: a row appears on the day it was last saved,
          marked <span className="font-mono">·</span>, without what changed in it.
        </p>
      ) : null}
      {changes === null ? (
        <Skeleton className="h-24" />
      ) : changes.notes.length === 0 ? (
        <p className="text-text-secondary">{emptyLine(changes, periodId, isWeek)}</p>
      ) : view === "timeline" ? (
        <Timeline
          log={log as LoggedEvent[]}
          periodId={periodId}
          expanded={expanded}
          expandFold={expandFold}
        />
      ) : isWeek ? (
        <WeekByNote
          log={log as LoggedEvent[]}
          weekId={periodId}
          expanded={expanded}
          expandFold={expandFold}
        />
      ) : (
        <NoteCards notes={changes.notes} expandFold={expandFold} />
      )}
    </section>
  )
}

/** "2 notes · 4 edits" */
function summaryOf(changes: PeriodChanges): string {
  const notes = changes.notes.length === 1 ? "1 note" : `${changes.notes.length} notes`
  const edits = changes.events === 1 ? "1 edit" : `${changes.events} edits`
  return `${notes} · ${edits}`
}

/**
 * Why there is nothing to show. A day before the log began is not an empty
 * day, it is one history cannot answer; a day that has not come is not one
 * nothing was written on.
 */
function emptyLine(changes: PeriodChanges, periodId: string, isWeek: boolean): string {
  const today = new Date()
  const thisPeriod = isWeek ? toWeekString(today) : toDateString(today)
  if (periodId > thisPeriod) {
    return isWeek ? "This week has not come yet." : "This day has not come yet."
  }
  if (changes.earliest !== null) {
    const earliestPeriod = isWeek ? toWeekString(parseISO(changes.earliest)) : changes.earliest
    if (periodId < earliestPeriod) {
      return `History begins on ${formatDate(changes.earliest, { alwaysIncludeYear: true })}.`
    }
  }
  return isWeek ? "Nothing was written this week." : "Nothing was written on this day."
}

/** A week by note: each day with changes under its own heading, and one line
 * for the days without. */
function WeekByNote({
  log,
  weekId,
  expanded,
  expandFold,
}: {
  log: LoggedEvent[]
  weekId: string
  expanded: ReadonlySet<string>
  expandFold: (foldId: string) => void
}) {
  const viewerTz = writerTimezone()
  const days = React.useMemo(() => {
    const start = startOfISOWeek(parseISO(weekId))
    return Array.from({ length: 7 }, (_, index) => {
      const day = toDateString(addDays(start, index))
      return { day, changes: changesIn(log, day, viewerTz, { expanded }) }
    })
  }, [log, weekId, viewerTz, expanded])
  const quiet = days.filter(({ changes }) => changes.notes.length === 0).map(({ day }) => day)

  return (
    <div className="flex flex-col gap-6">
      {days
        .filter(({ changes }) => changes.notes.length > 0)
        .map(({ day, changes }) => (
          <section key={day} aria-label={formatDate(day)} className="flex flex-col gap-3">
            <h3 className="flex items-baseline gap-2 text-text">
              <Link
                to="/calendar/$"
                params={{ _splat: day }}
                search={{}}
                className="focus-ring rounded font-bold hover:underline"
              >
                {formatDate(day)}
              </Link>
              <span className="text-text-secondary">{summaryOf(changes)}</span>
            </h3>
            <NoteCards notes={changes.notes} expandFold={expandFold} />
          </section>
        ))}
      {quiet.length > 0 ? (
        <p className="text-text-secondary">
          Nothing was written on {listDays(quiet.map((day) => formatDate(day).split(",")[0]))}.
        </p>
      ) : null}
    </div>
  )
}

/** "Tue, Sat and Sun" */
function listDays(names: string[]): string {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/** The period in order: one group per sitting, headed by when it was —
 * on the writer's clock, with the zone where it is not the reader's. */
function Timeline({
  log,
  periodId,
  expanded,
  expandFold,
}: {
  log: LoggedEvent[]
  periodId: string
  expanded: ReadonlySet<string>
  expandFold: (foldId: string) => void
}) {
  const viewerTz = writerTimezone()
  const isWeek = isValidWeekString(periodId)
  const sittings = React.useMemo(
    () => sittingsIn(log, periodId, viewerTz, { expanded }),
    [log, periodId, viewerTz, expanded],
  )
  return (
    <ol className="flex flex-col gap-6">
      {sittings.map((sitting, index) => (
        <li key={`${sitting.device}:${sitting.at}:${index}`} className="flex flex-col gap-3">
          <h3 className="flex items-baseline gap-2 text-text">
            <span className="font-bold">
              {sitting.device === "snapshot"
                ? "Last saved"
                : sittingLabel(sitting, viewerTz, isWeek)}
            </span>
            <span className="text-text-secondary">
              {sitting.notes.length === 1 ? "1 note" : `${sitting.notes.length} notes`}
              {sitting.device !== "snapshot" && sitting.tz !== null && sitting.tz !== viewerTz
                ? ` · ${utcOffset(sitting.tz)}`
                : ""}
            </span>
          </h3>
          <NoteCards notes={sitting.notes} expandFold={expandFold} />
        </li>
      ))}
    </ol>
  )
}

/** "14:05–14:32", with the day in front of it on a week's page. */
function sittingLabel(sitting: Sitting, viewerTz: number, withDay: boolean): string {
  const tz = sitting.tz ?? viewerTz
  const from = clockOf(sitting.at, tz)
  const until = clockOf(sitting.until, tz)
  const range = from === until ? from : `${from}–${until}`
  if (!withDay) return range
  const day = formatDate(toDateString(new Date(sitting.at + tz * 60_000)))
  return `${day}, ${range}`
}

/** The wall clock an instant read as, in a zone given as minutes east of UTC. */
function clockOf(at: number, tz: number): string {
  const date = new Date(at + tz * 60_000)
  const hours = String(date.getUTCHours()).padStart(2, "0")
  const minutes = String(date.getUTCMinutes()).padStart(2, "0")
  return `${hours}:${minutes}`
}

/** "UTC+9", "UTC−4", "UTC+5:30" */
function utcOffset(tz: number): string {
  if (tz === 0) return "UTC"
  const sign = tz < 0 ? "−" : "+"
  const hours = Math.floor(Math.abs(tz) / 60)
  const minutes = Math.abs(tz) % 60
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`
}

function NoteCards({
  notes,
  expandFold,
}: {
  notes: NoteChange[]
  expandFold: (foldId: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {notes.map((note) => (
        <NoteCard key={note.id} change={note} expandFold={expandFold} />
      ))}
    </div>
  )
}

/**
 * One note's change: its name, what the period did to it in numbers, and
 * its outline drawn by the block editor in read-only mode with every row
 * marked — the tints, the signs at the edge, the words that went and came,
 * and the folds (`BlockEditor.diff`, `block-item.tsx`).
 */
function NoteCard({
  change,
  expandFold,
}: {
  change: NoteChange
  expandFold: (foldId: string) => void
}) {
  const title = change.title || (isMintedNoteId(change.id) ? "Untitled" : change.id)
  const diff = React.useMemo(
    () => ({ marks: change.marks, expandFold }),
    [change.marks, expandFold],
  )
  return (
    <article className={cx(surface({ tier: "card" }), "overflow-hidden")}>
      <header className="flex items-center gap-2 border-b border-[var(--neutral-a3)] px-3 py-2">
        <Link
          to="/views/$"
          params={{ _splat: change.id }}
          search={{ query: undefined }}
          className="focus-ring flex min-w-0 items-center gap-2 rounded font-bold text-text hover:underline"
        >
          <span className="flex size-icon shrink-0 text-text-secondary">
            <NoteIcon16 />
          </span>
          <span className="truncate">{title}</span>
        </Link>
        {change.kind !== "edited" ? (
          <span className="rounded bg-bg-secondary px-1.5 text-sm text-text-secondary">
            {change.kind === "created"
              ? "New"
              : change.kind === "deleted"
                ? "Deleted"
                : "Last saved"}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 gap-2 font-mono text-sm">
          {change.added > 0 ? <span className="text-text-success">+{change.added}</span> : null}
          {change.removed > 0 ? <span className="text-text-danger">−{change.removed}</span> : null}
          {change.changed > 0 ? <span className="text-text-changed">~{change.changed}</span> : null}
          {change.touched > 0 ? (
            <span className="text-text-tertiary">·{change.touched}</span>
          ) : null}
        </span>
      </header>
      <div className="px-3 py-2">
        <BlockEditor doc={change.doc} onChange={noop} readOnly browse diff={diff} />
      </div>
    </article>
  )
}
