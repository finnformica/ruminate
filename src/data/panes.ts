/**
 * The note page's panes and their focus stacks (docs/split-view.md): view
 * state only, held in the URL, never in the graph.
 *
 * A **pane** shows one note, rooted at the note or at one block in it, and
 * keeps a **focus stack**: the views the reader went into, in order, the
 * last the one on screen. Focusing on a block pushes a frame; popping one
 * goes back to the view beneath it, with the row that was selected there
 * selected again. Folds need no record: they are kept per view, keyed by
 * the row's path from the view's root (`src/data/view-state.ts`), so what is
 * folded inside a focus never touches the view it was entered from, and a
 * pop leaves those folds as they were.
 *
 * A **layout** is a list of panes and which one has the keyboard. Two panes
 * sit side by side today (`MAX_PANES`); nothing here depends on the number,
 * so more panes, or a tiling of them, change the cap and the page's grid,
 * not this model.
 *
 * Everything here is pure: the page reads a layout out of the URL
 * (`layoutFromSearch`), changes it with these functions, and writes it back
 * (`layoutToSearch`).
 */

/** One view in a pane's focus stack. */
export interface FocusFrame {
  /** The note the view is in. */
  noteId: string
  /** The block the view is rooted at; null = the whole note. */
  root: string | null
  /**
   * The row selected when the reader left this view (an occurrence key,
   * `src/blocks/view.ts`), so a pop lands on it again. Null on the frame on
   * screen, whose selection is the editor's own.
   */
  selected: string | null
}

/** One pane: its focus stack, bottom first. Never empty; the last frame is
 * the view on screen. */
export interface Pane {
  frames: FocusFrame[]
}

/** The page's panes, left to right, and the one the keyboard is in. */
export interface PaneLayout {
  panes: Pane[]
  active: number
}

/** How many panes the page shows side by side. */
export const MAX_PANES = 2

/** A view to go to: a note, rooted at a block or not. */
export interface ViewTarget {
  noteId: string
  root: string | null
}

/** A change of view in one pane, and the row to select once it shows. */
export interface FocusMove {
  pane: Pane
  /** The row to select in the new view (a popped frame's), or null for the
   * editor's own landing rule. */
  landing: string | null
  /** Whether the move went back to a frame already on the stack. A frame
   * restored keeps its folds as they were; a new view first opens the folds
   * down to the block just left (the page's `revealOnLeaveFocus`). */
  restored: boolean
}

export const paneOf = (noteId: string, root: string | null = null): Pane => ({
  frames: [{ noteId, root, selected: null }],
})

/** The view on screen in a pane. */
export const currentFrame = (pane: Pane): FocusFrame => pane.frames[pane.frames.length - 1]

const sameView = (a: ViewTarget, b: ViewTarget) => a.noteId === b.noteId && a.root === b.root

/**
 * Pop back to the frame at `index`: the frames above it go, and its
 * selection is the landing. Out of range (or the frame on screen), nothing
 * moves.
 */
export function popTo(pane: Pane, index: number): FocusMove | null {
  if (index < 0 || index >= pane.frames.length - 1) return null
  const frame = pane.frames[index]
  return {
    pane: { frames: [...pane.frames.slice(0, index), { ...frame, selected: null }] },
    landing: frame.selected,
    restored: true,
  }
}

/**
 * Pop one frame. With one frame left and a block in focus, the pop leaves
 * the focus for the whole note, as Shift+F always has; on the whole note
 * with nothing beneath it there is nothing to pop.
 */
export function popFrame(pane: Pane): FocusMove | null {
  if (pane.frames.length > 1) return popTo(pane, pane.frames.length - 2)
  const top = currentFrame(pane)
  if (top.root === null) return null
  return { pane: paneOf(top.noteId), landing: null, restored: false }
}

/**
 * Go to a view, with `selected` the row selected where the reader is now.
 * A view already on the stack is popped back to (so the stack never holds
 * one view twice, and a crumb, Shift+F and ⌘⇧. agree on where they lead);
 * anything else is a new frame, pushed with the current frame's selection
 * recorded beneath it.
 */
export function goTo(pane: Pane, target: ViewTarget, selected: string | null): FocusMove | null {
  if (sameView(currentFrame(pane), target)) return null
  for (let i = pane.frames.length - 2; i >= 0; i -= 1) {
    if (sameView(pane.frames[i], target)) return popTo(pane, i)
  }
  const below = pane.frames.slice(0, -1)
  return {
    pane: {
      frames: [
        ...below,
        { ...currentFrame(pane), selected },
        { noteId: target.noteId, root: target.root, selected: null },
      ],
    },
    landing: null,
    restored: false,
  }
}

export const withPane = (layout: PaneLayout, index: number, pane: Pane): PaneLayout => ({
  ...layout,
  panes: layout.panes.map((p, i) => (i === index ? pane : p)),
})

/** The pane after `index`, wrapping: where the keyboard goes next, and
 * where a block opens beside. */
export const nextPaneIndex = (layout: PaneLayout, index = layout.active): number =>
  (index + 1) % layout.panes.length

/** The keyboard moves to pane `index`. */
export function activate(layout: PaneLayout, index: number): PaneLayout {
  if (index < 0 || index >= layout.panes.length || index === layout.active) return layout
  return { ...layout, active: index }
}

/**
 * Open a view in the pane beside `from`: a new pane where there is room for
 * one, else the next pane, where the view is a push onto its stack (so a pop
 * there returns to what it showed). The keyboard goes with it.
 */
export function openBeside(
  layout: PaneLayout,
  from: number,
  target: ViewTarget,
): { layout: PaneLayout; landing: string | null } {
  if (layout.panes.length < MAX_PANES) {
    const panes = [...layout.panes]
    panes.splice(from + 1, 0, paneOf(target.noteId, target.root))
    return { layout: { panes, active: from + 1 }, landing: null }
  }
  const index = nextPaneIndex(layout, from)
  const move = goTo(layout.panes[index], target, null)
  const next = move ? withPane(layout, index, move.pane) : layout
  return { layout: { ...next, active: index }, landing: move?.landing ?? null }
}

/** Close pane `index`. The last pane never closes. The keyboard stays in
 * the pane it was in, or goes to the neighbour of the one closed. */
export function closePane(layout: PaneLayout, index: number): PaneLayout {
  if (layout.panes.length <= 1 || index < 0 || index >= layout.panes.length) return layout
  const panes = layout.panes.filter((_, i) => i !== index)
  let active = layout.active
  if (active > index) active -= 1
  else if (active === index) active = Math.max(0, index - 1)
  return { panes, active }
}

// ── The URL ─────────────────────────────────────────────────────────────────
//
// The first pane is the page's own address, as it has always been:
// `/views/<note>?block=<root>`, so every link made before panes still opens
// the same view. Its stack beneath the view on screen is `stack`; each other
// pane is one `pane<i>` parameter holding its whole stack; `active` names the
// pane with the keyboard when it is not the first.
//
//   /views/A?block=b2&stack=A,A:b1:b1/c3&pane1=B,B:b9&active=1
//
// A frame is `note[:root[:selected]]`, frames are joined by commas. Ids are
// `blk_…` (or, for old notes, date-shaped) and occurrence keys join ids with
// `/` and `^`, so neither separator can appear inside one.

/** The search parameters the layout is written to. */
export interface PaneSearch {
  block?: string
  stack?: string
  pane1?: string
  active?: number
}

/** The parameter that holds pane `index` (1 and up). */
export const paneParam = (index: number) => `pane${index}` as const

const validId = (id: string) => id !== "" && !/[,:]/.test(id)

export function formatFrame({ noteId, root, selected }: FocusFrame): string {
  if (selected !== null) return `${noteId}:${root ?? ""}:${selected}`
  if (root !== null) return `${noteId}:${root}`
  return noteId
}

/** A frame read back from the URL; null for anything malformed. */
export function parseFrame(text: string): FocusFrame | null {
  const [noteId = "", root = "", selected = "", ...rest] = text.split(":")
  if (rest.length > 0 || !validId(noteId)) return null
  if (root !== "" && !validId(root)) return null
  return { noteId, root: root || null, selected: selected || null }
}

const formatFrames = (frames: FocusFrame[]) => frames.map(formatFrame).join(",")

const parseFrames = (text: unknown): FocusFrame[] =>
  typeof text === "string" && text !== ""
    ? text
        .split(",")
        .map(parseFrame)
        .filter((f): f is FocusFrame => f !== null)
    : []

/** The layout a URL holds: the first pane from the address (`noteId`,
 * `block`, `stack`), the rest from `pane<i>`. Malformed parts are dropped. */
export function layoutFromSearch(noteId: string, search: Record<string, unknown>): PaneLayout {
  const block = typeof search.block === "string" && search.block !== "" ? search.block : null
  const first: Pane = {
    frames: [
      // The frame on screen carries no selection of its own.
      ...parseFrames(search.stack),
      { noteId, root: block, selected: null },
    ],
  }
  const panes = [first]
  for (let i = 1; i < MAX_PANES; i += 1) {
    const frames = parseFrames(search[paneParam(i)])
    if (frames.length === 0) break
    frames[frames.length - 1] = { ...frames[frames.length - 1], selected: null }
    panes.push({ frames })
  }
  const active = Number(search.active)
  return {
    panes,
    active: Number.isInteger(active) && active > 0 && active < panes.length ? active : 0,
  }
}

/** Where a layout is written: the first pane's note (the path) and the
 * search parameters for everything else. Parameters with nothing to say are
 * left out, so a page with one unfocused pane is just `/views/<note>`. */
export function layoutToSearch(layout: PaneLayout): { noteId: string; search: PaneSearch } {
  const [first, ...rest] = layout.panes
  const top = currentFrame(first)
  const search: PaneSearch & Record<string, string | number | undefined> = {
    block: top.root ?? undefined,
    stack: first.frames.length > 1 ? formatFrames(first.frames.slice(0, -1)) : undefined,
  }
  for (let i = 1; i < MAX_PANES; i += 1) {
    search[paneParam(i)] = rest[i - 1] ? formatFrames(rest[i - 1].frames) : undefined
  }
  search.active = layout.active > 0 ? layout.active : undefined
  return { noteId: top.noteId, search }
}
