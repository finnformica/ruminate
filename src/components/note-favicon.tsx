import React from "react"
import { Note } from "../schema"
import { cx } from "../utils/cx"
import {
  CalendarDateFillIcon16,
  CalendarDateIcon16,
  CalendarFillIcon16,
  CalendarIcon16,
  NoteFillIcon16,
  NoteIcon16,
} from "./icons"

type NoteFaviconProps = React.ComponentPropsWithoutRef<"span"> & {
  note: Note
  defaultFavicon?: React.ReactNode
  /** The filled variant of each icon — for the note that is current, as the
   * sidebar's nav links swap to theirs. */
  filled?: boolean
}

const _defaultFavicon = <NoteIcon16 data-testid="favicon-default" className="h-full w-full" />
const _defaultFilledFavicon = (
  <NoteFillIcon16 data-testid="favicon-default" className="h-full w-full" />
)

/** A note's icon: the day for a daily note, a calendar for a weekly one, the
 * note icon otherwise. */
export const NoteFavicon = React.memo(
  ({
    note,
    className,
    filled = false,
    defaultFavicon = filled ? _defaultFilledFavicon : _defaultFavicon,
    ...props
  }: NoteFaviconProps) => {
    let icon = defaultFavicon

    if (note.type === "daily") {
      const Icon = filled ? CalendarDateFillIcon16 : CalendarDateIcon16
      icon = <Icon data-testid="favicon-daily" date={new Date(note.id).getUTCDate()} />
    }

    if (note.type === "weekly") {
      const Icon = filled ? CalendarFillIcon16 : CalendarIcon16
      icon = <Icon data-testid="favicon-weekly" />
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
