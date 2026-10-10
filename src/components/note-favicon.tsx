import React from "react"
import { Note } from "../schema"
import { cx } from "../utils/cx"
import { BoardFillIcon16, BoardIcon16, NoteFillIcon16, NoteIcon16 } from "./icons"

type NoteFaviconProps = React.ComponentPropsWithoutRef<"span"> & {
  /** Only the identity and the kind: the icon says which sort of note this
   * is, so a row that knows an id (and derived its kind with `noteTypeOf`)
   * can draw one without carrying a whole `Note`. */
  note: Pick<Note, "id" | "type">
  defaultFavicon?: React.ReactNode
  /** The filled variant of each icon — for the note that is current, as the
   * sidebar's nav links swap to theirs. */
  filled?: boolean
}

const _defaultFavicon = <NoteIcon16 data-testid="favicon-default" className="h-full w-full" />
const _defaultFilledFavicon = (
  <NoteFillIcon16 data-testid="favicon-default" className="h-full w-full" />
)

/** A note's icon: a board for a board (docs/boards.md), the note icon
 * otherwise. */
export const NoteFavicon = React.memo(
  ({
    note,
    className,
    filled = false,
    defaultFavicon = filled ? _defaultFilledFavicon : _defaultFavicon,
    ...props
  }: NoteFaviconProps) => {
    let icon = defaultFavicon

    if (note.type === "board") {
      const Icon = filled ? BoardFillIcon16 : BoardIcon16
      icon = <Icon data-testid="favicon-board" />
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
