import { Link } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import { changesIn, withContext, type NoteChange, type PeriodChanges } from "../data/day-changes"
import {
  databaseEventLog,
  databaseModeStatusAtom,
  eventLogVersionAtom,
} from "../data/database-mode"
import type { LoggedEvent } from "../data/events"
import { isDateNoteId } from "../data/note-identity"
import { writerTimezone } from "../data/writer-identity"
import { isDatabaseModeAtom } from "../global-state"
import { cx } from "../utils/cx"
import { formatDate, formatWeek, isValidWeekString, toWeekString } from "../utils/date"
import { parseISO } from "date-fns"
import { NoteIcon16 } from "./icons"
import { surface } from "./ui/surface"

/**
 * What was written on a day — or in a week — of the calendar
 * (docs/event-sourcing.md): every note changed on it, each as the lines it
 * gained and lost, read as a diff is. Folded from the device's copy of the
 * event log (`src/data/day-changes.ts`), so it is read-only by nature: it is
 * the day as it happened, and only today's note is still being written.
 */
export function DayChanges({ periodId }: { periodId: string }) {
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const { status } = useAtomValue(databaseModeStatusAtom)
  const changes = usePeriodChanges(isDatabaseMode && status === "ready" ? periodId : null)
  if (!isDatabaseMode) return null
  const isWeek = isValidWeekString(periodId)

  return (
    <section aria-label="Changes" className="flex flex-col gap-4">
      <h2 className="flex items-baseline gap-2 font-bold text-text">
        Changes
        {changes !== null && changes.notes.length > 0 ? (
          <span className="font-normal text-text-secondary">
            {changes.notes.length === 1 ? "1 note" : `${changes.notes.length} notes`}
          </span>
        ) : null}
      </h2>
      {changes === null ? null : changes.notes.length === 0 ? (
        <p className="text-text-secondary">{emptyLine(changes, periodId, isWeek)}</p>
      ) : (
        changes.notes.map((note) => <NoteDiff key={note.id} change={note} />)
      )}
    </section>
  )
}

/** The log, folded for the period, re-read whenever the log moves. */
function usePeriodChanges(periodId: string | null): PeriodChanges | null {
  const version = useAtomValue(eventLogVersionAtom)
  const [log, setLog] = React.useState<LoggedEvent[] | null>(null)
  React.useEffect(() => {
    if (periodId === null) return
    let cancelled = false
    void databaseEventLog().then((read) => {
      if (!cancelled) setLog(read)
    })
    return () => {
      cancelled = true
    }
  }, [periodId, version])
  return React.useMemo(
    () => (log === null || periodId === null ? null : changesIn(log, periodId, writerTimezone())),
    [log, periodId],
  )
}

/** Why there is nothing to show: a day before the log began is not an empty
 * day, it is one history cannot answer. */
function emptyLine(changes: PeriodChanges, periodId: string, isWeek: boolean): string {
  if (changes.earliest !== null) {
    const earliestPeriod = isWeek ? toWeekString(parseISO(changes.earliest)) : changes.earliest
    if (periodId < earliestPeriod) {
      return `History begins on ${formatDate(changes.earliest, { alwaysIncludeYear: true })}.`
    }
  }
  return isWeek ? "Nothing was written this week." : "Nothing was written on this day."
}

function NoteDiff({ change }: { change: NoteChange }) {
  const title = isDateNoteId(change.id)
    ? isValidWeekString(change.id)
      ? formatWeek(change.id)
      : formatDate(change.id)
    : change.title === change.id
      ? "Untitled"
      : change.title
  const lines = React.useMemo(() => withContext(change.lines), [change.lines])
  return (
    <article className={cx(surface({ tier: "card" }), "overflow-hidden")}>
      <header className="flex items-center gap-2 px-3 py-2">
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
            {change.kind === "created" ? "New" : "Deleted"}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 gap-2 font-mono text-sm">
          {change.added > 0 ? <span className="text-text-success">+{change.added}</span> : null}
          {change.removed > 0 ? <span className="text-text-danger">−{change.removed}</span> : null}
        </span>
      </header>
      <ol className="border-t border-[var(--neutral-a3)] py-1 font-mono text-sm leading-6">
        {lines.map((line, index) =>
          line.kind === "skipped" ? (
            <li
              key={index}
              aria-label={`${line.count} unchanged lines`}
              className="px-3 text-text-tertiary select-none"
            >
              ⋯
            </li>
          ) : (
            <li
              key={index}
              className={cx(
                "flex gap-2 px-3 whitespace-pre-wrap",
                line.kind === "added" && "bg-bg-added text-text",
                line.kind === "removed" && "bg-bg-removed text-text",
                line.kind === "same" && "text-text-secondary",
              )}
            >
              <span aria-hidden className="w-3 shrink-0 select-none text-text-tertiary">
                {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
              </span>
              <span className="sr-only">
                {line.kind === "added" ? "Added: " : line.kind === "removed" ? "Removed: " : ""}
              </span>
              <span className="min-w-0 flex-1">{line.text || " "}</span>
            </li>
          ),
        )}
      </ol>
    </article>
  )
}
