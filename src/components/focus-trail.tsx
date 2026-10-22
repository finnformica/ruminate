import { useAtomValue } from "jotai"
import { Fragment } from "react"
import { pathToBlock } from "../data/graph"
import type { FocusFrame, ViewTarget } from "../data/panes"
import { ROOT_LABEL, isRootFrame } from "../data/root-frame"
import { idOfKey } from "../blocks/view"
import { graphSnapshotAtom } from "../global-state"
import { cx } from "../utils/cx"
import { inlineText } from "../utils/inline-text"

/** One crumb of the trail. */
interface Crumb {
  key: string
  label: string
  /** A frame's root (a segment of the stack), or a block on the path
   * between two frames' roots. */
  kind: "frame" | "path"
  /** Absent on the view on screen. */
  onClick?: () => void
}

/**
 * The focus breadcrumb: a pane's focus stack and, between its frames, the
 * path through the graph (docs/split-view.md).
 *
 * - Each **frame** is a segment, its root as the label: a click pops back
 *   to it, with its selection and folds as they were.
 * - Between two frames, the blocks on the path from the earlier root down to
 *   the later one, as the breadcrumb has always shown the way down to the
 *   focused block. Where a block sits in more than one place the stack
 *   decides which path shows: the row the earlier frame recorded as it was
 *   left, else the shortest path from the earlier root. A
 *   click on one pops back to the earlier frame and focuses the block from
 *   there.
 * - The **Root frame** (`src/data/root-frame.ts`) is the first crumb: the
 *   base of every pane, a click on it pops back to the list of every note.
 * - Where the stack starts on a block above Root, the note and the path down to the
 *   block lead the trail, so the whole note is always one click away. No
 *   frame is there to pop to: a click on one replaces the stack with that
 *   view (`goAbove`), as Shift+F does on a lone focus, and never pushes it
 *   above the frames it leads to.
 *
 * The labels are read from the live graph, so a crumb renamed in the other
 * pane reads the new name at once.
 */
export function FocusTrail({
  frames,
  onPopTo,
  onGoVia,
  onGoAbove,
  className,
}: {
  frames: FocusFrame[]
  /** Pop back to the frame at this index. */
  onPopTo: (index: number) => void
  /** Pop back to the frame at this index, then go to the view from it
   * (`goVia`). */
  onGoVia: (index: number, target: ViewTarget) => void
  /** Go to a view above the stack's first frame (`goAbove`). */
  onGoAbove: (target: ViewTarget) => void
  className?: string
}) {
  const graph = useAtomValue(graphSnapshotAtom)
  // A crumb is one plain line: its markdown marks go (`inlineText`).
  const textOf = (id: string) => inlineText(graph.nodes.get(id)?.text ?? "")
  const labelOf = (frame: FocusFrame) =>
    isRootFrame(frame)
      ? ROOT_LABEL
      : frame.root === null
        ? textOf(frame.noteId) || "Untitled"
        : textOf(frame.root) || "…"
  // The blocks strictly between a frame's root and the next frame's. The
  // row the frame recorded as it was left is the way the reader went down
  // (`SelectionPath`: the ids from the frame's root to the row), so it names
  // the path where a block sits under more than one parent. Failing that —
  // the reader focused from another row — the shortest path.
  const between = (from: FocusFrame, to: string) => {
    if (from.selected !== null) {
      const ids = from.selected.map(idOfKey)
      if (from.root !== null && ids[0] === from.root) ids.shift()
      if (ids[ids.length - 1] === to) return ids.slice(0, -1)
    }
    return (pathToBlock(graph, from.root ?? from.noteId, to) ?? []).slice(0, -1)
  }

  const last = frames.length - 1
  const crumbs: Crumb[] = []
  // `at`: the frame the path leaves from, or null above the first frame.
  const pathCrumbs = (at: number | null, from: FocusFrame, to: FocusFrame) => {
    if (to.root === null || to.noteId !== from.noteId) return
    for (const id of between(from, to.root)) {
      const target = { noteId: from.noteId, root: id }
      crumbs.push({
        key: `${at ?? "above"}>${id}`,
        label: textOf(id) || "…",
        kind: "path",
        onClick: () => (at === null ? onGoAbove(target) : onGoVia(at, target)),
      })
    }
  }
  // Root leads the trail; the frames above it start where the note's lead
  // goes.
  const firstIndex = isRootFrame(frames[0]) ? 1 : 0
  if (firstIndex === 1) {
    crumbs.push({
      key: "root",
      label: ROOT_LABEL,
      kind: "frame",
      onClick: last > 0 ? () => onPopTo(0) : undefined,
    })
  }
  const first = frames[firstIndex]
  if (first && first.root !== null) {
    const note: FocusFrame = { noteId: first.noteId, root: null, selected: null }
    crumbs.push({
      key: "note",
      label: textOf(first.noteId) || "Note",
      kind: "path",
      onClick: () => onGoAbove({ noteId: first.noteId, root: null }),
    })
    pathCrumbs(null, note, first)
  }
  frames.forEach((frame, index) => {
    if (index < firstIndex) return
    if (index > firstIndex) pathCrumbs(index - 1, frames[index - 1], frame)
    crumbs.push({
      key: `${index}:${frame.noteId}:${frame.root}`,
      label: labelOf(frame),
      kind: "frame",
      onClick: index < last ? () => onPopTo(index) : undefined,
    })
  })

  // `focus-ring`: a crumb is a real button, and a keyboard user walking the
  // trail must see where they are.
  const crumbClass =
    "focus-ring min-w-0 max-w-48 cursor-pointer truncate rounded-sm px-1 transition-colors duration-150 hover:bg-bg-hover hover:text-text"
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
      {crumbs.map((crumb, index) => (
        <Fragment key={crumb.key}>
          {index > 0 ? (
            <span aria-hidden className="text-text-tertiary">
              ›
            </span>
          ) : null}
          {crumb.onClick ? (
            <button
              type="button"
              data-crumb={crumb.kind}
              // The path between frames reads quieter than the frames.
              className={cx(crumbClass, crumb.kind === "path" && "text-text-tertiary")}
              onClick={crumb.onClick}
            >
              {crumb.label}
            </button>
          ) : (
            <span
              aria-current="page"
              data-crumb={crumb.kind}
              className="min-w-0 max-w-48 truncate px-1 text-text"
            >
              {crumb.label}
            </span>
          )}
        </Fragment>
      ))}
    </nav>
  )
}
