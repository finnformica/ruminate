import { useAtomValue } from "jotai"
import { Fragment } from "react"
import type { FocusFrame, ViewTarget } from "../data/panes"
import { graphSnapshotAtom } from "../global-state"
import { cx } from "../utils/cx"
import { inlineText } from "../utils/inline-text"

/**
 * A pane's focus stack, drawn as a breadcrumb (docs/split-view.md): one
 * crumb per view the reader went into, oldest first, the view on screen
 * last. A click on a crumb pops back to that view, with the block that was
 * selected there selected again. Where the stack starts on a block, the note
 * leads the trail, so the whole note is always one click away.
 *
 * The labels are read from the live graph, so a crumb renamed in the other
 * pane reads the new name at once.
 */
export function FocusTrail({
  frames,
  onPopTo,
  onGoTo,
  className,
}: {
  frames: FocusFrame[]
  /** Pop back to the frame at this index. */
  onPopTo: (index: number) => void
  /** Go to a view that is not on the stack: the note, from a stack that
   * starts on a block in it. */
  onGoTo: (target: ViewTarget) => void
  className?: string
}) {
  const graph = useAtomValue(graphSnapshotAtom)
  // A crumb is one plain line: its markdown marks go (`inlineText`).
  const textOf = (id: string) => inlineText(graph.nodes.get(id)?.text ?? "")
  const labelOf = (frame: FocusFrame) =>
    frame.root === null ? textOf(frame.noteId) || "Untitled" : textOf(frame.root) || "…"
  const first = frames[0]
  const current = frames[frames.length - 1]
  // `focus-ring`: a crumb is a real button, and a keyboard user walking the
  // trail must see where they are.
  const crumbClass =
    "focus-ring min-w-0 max-w-48 cursor-pointer truncate rounded-sm px-1 transition-colors duration-150 hover:bg-bg-hover hover:text-text"
  const separator = (
    <span aria-hidden className="text-text-tertiary">
      ›
    </span>
  )
  return (
    <nav
      aria-label="Focus path"
      data-testid="focus-breadcrumb"
      // `note-header` hangs the trail into the page gutter with the title
      // (block-editor.css), and the 25px sets it in past the chevron column
      // and its gap, as the title is.
      className={cx(
        "note-header mb-3 flex min-w-0 flex-wrap items-center gap-0.5 pl-[25px] font-content text-sm text-text-secondary",
        className,
      )}
    >
      {first.root !== null ? (
        <>
          <button
            type="button"
            className={crumbClass}
            onClick={() => onGoTo({ noteId: first.noteId, root: null })}
          >
            {textOf(first.noteId) || "Note"}
          </button>
          {separator}
        </>
      ) : null}
      {frames.slice(0, -1).map((frame, index) => (
        <Fragment key={`${index}:${frame.noteId}:${frame.root}`}>
          <button type="button" className={crumbClass} onClick={() => onPopTo(index)}>
            {labelOf(frame)}
          </button>
          {separator}
        </Fragment>
      ))}
      <span aria-current="page" className="min-w-0 max-w-48 truncate px-1 text-text">
        {labelOf(current)}
      </span>
    </nav>
  )
}
