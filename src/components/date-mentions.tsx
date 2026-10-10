import { Link } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import { parseISO } from "date-fns"
import React from "react"
import { dateMentionsAtom, notesAtom } from "../global-state"
import { useDateMentions } from "../hooks/note"
import type { Note } from "../schema"
import { cx } from "../utils/cx"
import { isValidWeekString, toWeekString } from "../utils/date"
import { NoteFavicon } from "./note-favicon"
import { listRow } from "./ui/list"

/** The days a note names in a date-valued property (`dateMentionsAtom`,
 * docs/metadata.md), and the weeks holding them — half of what the calendar
 * dots (`useCalendarMarks`, `day-changes.tsx`). */
export function useDateMarks(): ReadonlySet<string> {
  const mentions = useAtomValue(dateMentionsAtom)
  return React.useMemo(() => {
    const marked = new Set<string>(mentions.keys())
    for (const id of [...marked]) {
      if (!isValidWeekString(id)) marked.add(toWeekString(parseISO(id)))
    }
    return marked
  }, [mentions])
}

/**
 * The notes that name a day or a week in a date-valued property — a
 * birthday, a due date (docs/metadata.md) — listed on the day's page.
 * Nothing when none does.
 */
export function DateMentions({ periodId }: { periodId: string }) {
  const ids = useDateMentions(periodId)
  const notes = useAtomValue(notesAtom)
  const mentioned = ids.map((id) => notes.get(id)).filter((note): note is Note => !!note)
  if (mentioned.length === 0) return null
  return (
    <section aria-label="Notes with this date" className="flex flex-col gap-2">
      <h2 className="font-bold text-text">Notes with this date</h2>
      <ul className="-mx-3 flex flex-col">
        {mentioned.map((note) => (
          <li key={note.id}>
            <Link
              to="/views/$"
              params={{ _splat: note.id }}
              search={{ query: undefined }}
              className={cx(listRow(), "focus-ring text-text")}
            >
              <span className="flex size-icon shrink-0 text-text-secondary">
                <NoteFavicon note={note} />
              </span>
              <span className="truncate">{note.displayName}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
