import { keyOf } from "../blocks/view"
import { pathToBlock, type GraphSnapshot } from "./graph"
import { formatFrame, parseFrame, pathOfKey, type FocusFrame } from "./panes"
import { inlineText } from "../utils/inline-text"
import { ROOT_LABEL, isRootFrame, rootFrame } from "./root-frame"

/**
 * **A View saves a whole stack** (docs/graph-walk.md, section 7): the
 * `stack` field of a view row (migrations/0027), as written and read.
 *
 * The row's `root_id` is the top frame's root, and its `filter` and `sort`
 * are the top frame's. `stack` holds the rest: the frames above Root, base
 * first, each as the URL writes a frame (`formatFrame`) without its
 * selection or folds, joined by `,`; the last entry is the top frame, which
 * gives only its pivots. Root is never saved — it is the base of every pane
 * (`root-frame.ts`) — and an entry for it is ignored on read.
 */

/** A frame as a View saves it: where it is and how it walks, not where the
 * reader was in it. */
const savedFrame = (frame: FocusFrame): FocusFrame => ({
  noteId: frame.noteId,
  root: frame.root,
  selected: null,
  ...(frame.filter ? { filter: frame.filter } : {}),
  ...(frame.sort ? { sort: frame.sort } : {}),
  ...(frame.pivots ? { pivots: frame.pivots } : {}),
})

/** The root a frame is rooted at: its block, else its note. */
const rootIdOf = (frame: { noteId: string; root: string | null }) => frame.root ?? frame.noteId

/** What **Save as view** writes from a pane's stack, up to the frame on
 * screen (the last of `frames`). */
export interface SavedStack {
  /** The View's `root_id`: the top frame's root. */
  rootId: string
  /** The `stack` field; null when there is nothing beneath the top and the
   * top has no pivots, which is a one-frame View. */
  stack: string | null
}

export function stackToSave(frames: readonly FocusFrame[]): SavedStack {
  const above = frames.filter((frame) => !isRootFrame(frame))
  const top = above[above.length - 1]
  if (!top) throw new Error("stackToSave: no frame above Root")
  const lower = above.slice(0, -1)
  if (lower.length === 0 && !top.pivots) return { rootId: rootIdOf(top), stack: null }
  const topEntry: FocusFrame = {
    noteId: top.noteId,
    root: top.root,
    selected: null,
    ...(top.pivots ? { pivots: top.pivots } : {}),
  }
  return {
    rootId: rootIdOf(top),
    stack: [...lower.map(savedFrame), topEntry].map(formatFrame).join(","),
  }
}

/** A `stack` field read back: the frames beneath the top, base first, and
 * the top's pivots. Malformed entries and Root entries are dropped. The last
 * entry is the top when it is rooted at the View's own root. */
export function parseViewStack(
  stack: string | null | undefined,
  rootId: string,
): { lower: FocusFrame[]; topPivots: FocusFrame["pivots"] } {
  const entries = (stack ?? "")
    .split(",")
    .filter((text) => text !== "")
    .map(parseFrame)
    .filter((frame): frame is FocusFrame => frame !== null && !isRootFrame(frame))
  const last = entries[entries.length - 1]
  if (last && rootIdOf(last) === rootId) {
    return { lower: entries.slice(0, -1), topPivots: last.pivots }
  }
  return { lower: entries, topPivots: undefined }
}

/** The View a pane opens: its row, and the note its root is in. */
export interface ViewToOpen {
  rootId: string
  /** The note the root is in (the root itself for a note View). */
  noteId: string
  filter?: string | null
  sort?: string | null
  stack?: string | null
}

const isLive = (graph: GraphSnapshot, id: string) => graph.nodes.has(id)

/**
 * The frames a View opens as: Root, then the saved frames, the top on
 * screen — restored, not pushed, so each keeps its saved filter and pivots.
 * Null when the top root is gone (the View is left out of the list).
 *
 * **When the saved path no longer holds** (section 7): from the top down,
 * each lower frame is kept while its root still reaches the root of the frame
 * above it (`pathToBlock`). At the first that fails, it and every frame below
 * it are dropped, so the View opens as Root › the frames that still hold ›
 * the top. The row is not changed: the next Save as view writes the stack as
 * it is then.
 *
 * Each lower frame's selection is the path to the next frame's root, with
 * the folds on that path open (as `settleFolds` opens them on the way back
 * up), so the crumbs and the rows agree, and Back lands on that row.
 */
export function restoreViewFrames(view: ViewToOpen, graph: GraphSnapshot): FocusFrame[] | null {
  if (!isLive(graph, view.rootId) || !isLive(graph, view.noteId)) return null
  const { lower, topPivots } = parseViewStack(view.stack, view.rootId)
  const top: FocusFrame = {
    noteId: view.noteId,
    root: view.rootId === view.noteId ? null : view.rootId,
    selected: null,
    ...(topPivots ? { pivots: topPivots } : {}),
  }
  const kept: FocusFrame[] = []
  let above: FocusFrame = top
  for (let i = lower.length - 1; i >= 0; i -= 1) {
    const frame = lower[i]
    const from = rootIdOf(frame)
    const to = rootIdOf(above)
    const chain =
      isLive(graph, from) && isLive(graph, frame.noteId) ? pathToBlock(graph, from, to) : null
    if (chain === null) break
    // The same root as the frame above (a pivot on the root pushed it): the
    // frame stands, with no row to land on.
    let key: string | null = frame.root
    const keys = chain.map((id) => (key = keyOf(key, id)))
    kept.unshift(
      keys.length === 0
        ? frame
        : {
            ...frame,
            selected: pathOfKey(keys[keys.length - 1]),
            ...(keys.length > 1 ? { folds: { open: keys.slice(0, -1), closed: [] } } : {}),
          },
    )
    above = frame
  }
  return [rootFrame(), ...kept, top]
}

/**
 * The path hint a View row shows after its name (section 7): the roots of
 * the frames between Root and the top, from Root — "Notes › Tasks". Empty for
 * a one-frame View. Read from the frames the View opens with
 * (`restoreViewFrames`), so a broken path shows what is left of it. The
 * sidebar and the palette show the same hint.
 */
export function viewPathHint(frames: readonly FocusFrame[], graph: GraphSnapshot): string {
  const lower = frames.slice(1, -1)
  if (lower.length === 0) return ""
  const labelOf = (frame: FocusFrame) =>
    inlineText(graph.nodes.get(rootIdOf(frame))?.text ?? "") || "Untitled"
  return [ROOT_LABEL, ...lower.map(labelOf)].join(" › ")
}
