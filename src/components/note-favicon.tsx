import React from "react"
import { Note } from "../schema"
import { cx } from "../utils/cx"
import { CalendarDateIcon16, CalendarIcon16, NoteIcon16 } from "./icons"

type NoteFaviconProps = React.ComponentPropsWithoutRef<"span"> & {
  note: Note
  defaultFavicon?: React.ReactNode
}

const _defaultFavicon = <NoteIcon16 data-testid="favicon-default" className="h-full w-full" />

/** A note's icon: the day for a daily note, a calendar for a weekly one, the
 * note icon otherwise. */
export const NoteFavicon = React.memo(
  ({ note, className, defaultFavicon = _defaultFavicon, ...props }: NoteFaviconProps) => {
    let icon = defaultFavicon

    if (note.type === "daily") {
      icon = (
        <CalendarDateIcon16 data-testid="favicon-daily" date={new Date(note.id).getUTCDate()} />
      )
    }

    if (note.type === "weekly") {
      icon = <CalendarIcon16 data-testid="favicon-weekly" />
    }

    if (!icon) {
      return null
    }

    return (
      <span
        className={cx(
          "inline-grid size-icon shrink-0 place-items-center text-text-secondary",
          className,
        )}
        {...props}
      >
        {icon}
      </span>
    )
  },
)
