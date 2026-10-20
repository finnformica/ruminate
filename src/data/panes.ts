/**
 * The note page's panes and their focus stacks (docs/split-view.md): view
 * state only, held in the URL, never in the graph.
 *
 * A **pane** shows one note, rooted at the note or at one block in it, and
 * keeps a **focus stack**: its history of frames, the last the one on
 * screen. A **frame** is one live query state: its root, its selection, its
 * filter and sort, and its folds. Focusing on a block pushes a frame, which
 * starts from the defaults — the root's saved view, the standing fold rule
 * and nothing selected; popping one goes back to the frame beneath, with
 * its selection, narrowing and folds as they were.
 *
 * The frame at the bottom comes from a View (or opens a note) and keeps its
 * folds where a note always has, on the device (`src/data/view-state.ts`).
 * Every frame pushed above it carries its folds itself, as what the reader
 * changed over the standing rule, so they travel in the URL with it.
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
   * The row selected when the reader left this frame, as the path of block
   * ids from the frame's root (`SelectionPath`), so a pop lands on it again.
   * Null on the frame on screen, whose selection is the editor's own.
   */
  selected: SelectionPath | null
  /** The frame's filter and sort (the query language, `src/data/filter-view.ts`);
   * absent = what the root's view saved. A pushed frame starts with none. */
  filter?: string
  sort?: string
  /** A pushed frame's folds: the rows the reader opened and closed over the
   * standing rule. Absent on the bottom frame, whose folds are the note's
   * own, kept on the device; and on a frame still at the defaults. */
  folds?: FrameFolds
}

/**
 * A selection: the path of block ids from the frame's root down to the row,
 * as in Pensive, so a block that sits under two parents names one place.
 * In a frame rooted at a block the path starts with that block; on a whole
 * note it starts at a top row. A step up a link to a parent (docs/graph-
 * schema-v2.md, "Upstream") carries `^` before its id. The editor names a
 * row by the same ids joined with `/` (an occurrence key,
 * `src/blocks/view.ts`): `keyOfPath` and `pathOfKey` cross between them.
 */
export type SelectionPath = readonly string[]

export const pathOfKey = (key: string): SelectionPath => key.split("/")
export const keyOfPath = (path: SelectionPath): string => path.join("/")

/** Folds as differences from the standing rule (`Folds`,
 * `src/data/view-state.ts`), in a form the URL can hold. */
export interface FrameFolds {
  open: readonly string[]
  closed: readonly string[]
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
const MAX_PANES = 2

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
  landing: SelectionPath | null
  /** Whether the move went back to a frame already on the stack. A frame
   * restored keeps its narrowing and folds as they were; a new frame starts
   * from the defaults, with the folds down to the block just left opened
   * (the page's `settleFolds`). */
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
export function goTo(
  pane: Pane,
  target: ViewTarget,
  selected: SelectionPath | null,
): FocusMove | null {
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

/**
 * Go to a view by way of frame `index`: pop back to that frame, then push
 * `target` from it — a crumb on the path between two frames' roots
 * (docs/split-view.md). The frame keeps the row it recorded, and the frames
 * above it go. On the frame on screen, it is a plain push.
 */
export function goVia(pane: Pane, index: number, target: ViewTarget): FocusMove | null {
  if (index < 0 || index >= pane.frames.length) return null
  const popped = popTo(pane, index)
  const base = popped?.pane ?? pane
  const selected = popped ? popped.landing : null
  const move = goTo(base, target, selected)
  if (move) return move
  return popped
}

/** The pane with its frame on screen changed: its narrowing or folds. */
export const withCurrent = (pane: Pane, patch: Partial<FocusFrame>): Pane => ({
  frames: [...pane.frames.slice(0, -1), { ...currentFrame(pane), ...patch }],
})

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
): { layout: PaneLayout; landing: SelectionPath | null } {
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
// `/views/<note>?block=<root>&filter=…&sort=…`, so every link made before
// panes still opens the same view. Its frame on screen also writes `folds`;
// its stack beneath that frame is `stack`; each other pane is one `pane<i>`
// parameter holding its whole stack; `active` names the pane with the
// keyboard when it is not the first.
//
//   /views/A?block=b2&stack=A::x1,A:b1:@&pane1=B,B:c1;f=type%3Atodo&active=1
//
// A frame is `note[:root[:selected]]`, then any of `;f=<filter>`,
// `;s=<sort>` and `;z=<folds>`; frames are joined by commas. Ids are `blk_…`
// (or, for old notes, date-shaped) and occurrence keys join ids with `/` and
// `^`, so neither `,` nor `:` can appear inside one; a filter or sort escapes
// `%`, `,`, `:` and `;`.
//
// Kept short: a row's path (the selection, a fold) is written from the
// frame's root — the root's own id, which every path in a focused frame
// starts with, is left out (`@` is the root itself) — and each id drops its
// `blk_` (an id without one is written after `~`). Folds are `+path` for a
// row opened and `-path` for a row closed, joined by `.`.

/** The search parameters the layout is written to. */
export interface PaneSearch {
  block?: string
  filter?: string
  sort?: string
  folds?: string
  stack?: string
  pane1?: string
  active?: number
}

/** The parameter that holds pane `index` (1 and up). */
const paneParam = (index: number) => `pane${index}` as const

const validId = (id: string) => id !== "" && !/[,:;.@~+]/.test(id) && !id.startsWith("-")

const MINTED = "blk_"

/** A row's path (an occurrence key) as the URL writes it, from `root`. */
function formatPath(key: string, root: string | null): string {
  let segments = key.split("/")
  if (root !== null && segments[0] === root) segments = segments.slice(1)
  if (segments.length === 0) return "@"
  return segments
    .map((segment) => {
      const up = segment.startsWith("^") ? "^" : ""
      const id = up ? segment.slice(1) : segment
      return up + (id.startsWith(MINTED) ? id.slice(MINTED.length) : `~${id}`)
    })
    .join("/")
}

/** A path read back from the URL: the occurrence key it names. */
function parsePath(text: string, root: string | null): string {
  const ids =
    text === "@"
      ? []
      : text.split("/").map((segment) => {
          const up = segment.startsWith("^") ? "^" : ""
          const id = up ? segment.slice(1) : segment
          return up + (id.startsWith("~") ? id.slice(1) : MINTED + id)
        })
  return (root !== null ? [root, ...ids] : ids).join("/")
}

/** Folds as the URL writes them (`+path` open, `-path` closed, `.`-joined). */
function formatFolds(folds: FrameFolds, root: string | null): string {
  return [
    ...folds.open.map((key) => `+${formatPath(key, root)}`),
    ...folds.closed.map((key) => `-${formatPath(key, root)}`),
  ].join(".")
}

function parseFolds(text: string, root: string | null): FrameFolds | undefined {
  const open: string[] = []
  const closed: string[] = []
  for (const entry of text.split(".")) {
    const path = entry.slice(1)
    if (path === "") continue
    if (entry[0] === "+") open.push(parsePath(path, root))
    else if (entry[0] === "-") closed.push(parsePath(path, root))
  }
  return open.length + closed.length > 0 ? { open, closed } : undefined
}

const escapeText = (text: string) => text.replace(/[%,:;]/g, (c) => encodeURIComponent(c))
const unescapeText = (text: string) => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

export function formatFrame(frame: FocusFrame): string {
  const { noteId, root, selected } = frame
  let text =
    selected !== null
      ? `${noteId}:${root ?? ""}:${formatPath(keyOfPath(selected), root)}`
      : root !== null
        ? `${noteId}:${root}`
        : noteId
  if (frame.filter) text += `;f=${escapeText(frame.filter)}`
  if (frame.sort) text += `;s=${escapeText(frame.sort)}`
  if (frame.folds && frame.folds.open.length + frame.folds.closed.length > 0) {
    text += `;z=${formatFolds(frame.folds, root)}`
  }
  return text
}

/** A frame read back from the URL; null for anything malformed. */
export function parseFrame(text: string): FocusFrame | null {
  const [base = "", ...extras] = text.split(";")
  const [noteId = "", root = "", selected = "", ...rest] = base.split(":")
  if (rest.length > 0 || !validId(noteId)) return null
  if (root !== "" && !validId(root)) return null
  const frameRoot = root || null
  const frame: FocusFrame = {
    noteId,
    root: frameRoot,
    selected: selected ? pathOfKey(parsePath(selected, frameRoot)) : null,
  }
  for (const extra of extras) {
    const value = extra.slice(2)
    if (extra.startsWith("f=") && value) frame.filter = unescapeText(value)
    else if (extra.startsWith("s=") && value) frame.sort = unescapeText(value)
    else if (extra.startsWith("z=")) {
      const folds = parseFolds(value, frameRoot)
      if (folds) frame.folds = folds
    }
  }
  return frame
}

const formatFrames = (frames: FocusFrame[]) => frames.map(formatFrame).join(",")

const parseFrames = (text: unknown): FocusFrame[] =>
  typeof text === "string" && text !== ""
    ? text
        .split(",")
        .map(parseFrame)
        .filter((f): f is FocusFrame => f !== null)
    : []

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined)

/** The layout a URL holds: the first pane from the address (`noteId`,
 * `block`, `filter`, `sort`, `folds`, `stack`), the rest from `pane<i>`.
 * Malformed parts are dropped. */
export function layoutFromSearch(noteId: string, search: Record<string, unknown>): PaneLayout {
  const root = text(search.block) ?? null
  const top: FocusFrame = { noteId, root, selected: null }
  const filter = text(search.filter)
  const sort = text(search.sort)
  const folds = text(search.folds) ? parseFolds(search.folds as string, root) : undefined
  if (filter) top.filter = filter
  if (sort) top.sort = sort
  const below = parseFrames(search.stack)
  // Only a pushed frame keeps its folds in the URL.
  if (folds && below.length > 0) top.folds = folds
  const panes: Pane[] = [{ frames: [...below, top] }]
  for (let i = 1; i < MAX_PANES; i += 1) {
    const frames = parseFrames(search[paneParam(i)])
    if (frames.length === 0) break
    // The frame on screen carries no selection of its own.
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
  const folds = first.frames.length > 1 && top.folds ? formatFolds(top.folds, top.root) : undefined
  const search: PaneSearch & Record<string, string | number | undefined> = {
    block: top.root ?? undefined,
    filter: top.filter || undefined,
    sort: top.sort || undefined,
    folds: folds || undefined,
    stack: first.frames.length > 1 ? formatFrames(first.frames.slice(0, -1)) : undefined,
  }
  for (let i = 1; i < MAX_PANES; i += 1) {
    search[paneParam(i)] = rest[i - 1] ? formatFrames(rest[i - 1].frames) : undefined
  }
  search.active = layout.active > 0 ? layout.active : undefined
  return { noteId: top.noteId, search }
}
