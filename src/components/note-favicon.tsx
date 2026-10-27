import React from "react"
import type { NoteType } from "../schema"
import { cx } from "../utils/cx"
import {
  BoardFillIcon16,
  BoardIcon16,
  TrackerFillIcon16,
  TrackerIcon16,
  GridFillIcon16,
  GridIcon16,
  NoteFillIcon16,
  NoteIcon16,
} from "./icons"

type NoteFaviconProps = React.ComponentPropsWithoutRef<"span"> & {
  /** Only the identity and the kind: the icon says which sort of note this
   * is, so a row that knows an id (and derived its kind with `noteTypeOf`)
   * can draw one without carrying a whole `Note`. `root` is the corpus root
   * (`ROOT_FAVICON`, src/data/root-frame.ts). */
  note: { id: string; type: NoteType | "root" }
  defaultFavicon?: React.ReactNode
  /** The filled variant of each icon — for the note that is current, as the
   * sidebar's nav links swap to theirs. */
  filled?: boolean
}

const _defaultFavicon = <NoteIcon16 data-testid="favicon-default" className="h-full w-full" />
const _defaultFilledFavicon = (
  <NoteFillIcon16 data-testid="favicon-default" className="h-full w-full" />
)

/** The icon of a node that is a page: a board for a board (docs/boards.md),
 * the grid of cells for a tracker (docs/trackers.md),
 * the grid for the Root frame's corpus root, the note icon otherwise. The
 * one icon component for all three, in a row's key slot, the sidebar and a
 * page's header. */
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
    } else if (note.type === "tracker") {
      const Icon = filled ? TrackerFillIcon16 : TrackerIcon16
      icon = <Icon data-testid="favicon-tracker" />
    } else if (note.type === "root") {
      const Icon = filled ? GridFillIcon16 : GridIcon16
      icon = <Icon data-testid="favicon-root" />
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
