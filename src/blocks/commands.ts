import type { BlockOp } from "./history"
import { DEFAULT_NEW_BLOCK_TYPE, isHeading, toggleType } from "./markers"
import { defOf } from "./registry"
import {
  duplicateBlocks,
  emptyBlock,
  indentBlock,
  insertAfter,
  moveBlock,
  outdentBlock,
  removeBlock,
  siblingsOf,
  updateBlock,
  updateText,
  updateType,
} from "./ops"
import type { BlockDoc, BlockType } from "./types"
import {
  ancestorKeys,
  directionOfKey,
  hasOccurrence,
  idOfKey,
  keyOf,
  parentKeyOf,
  pathIdsOf,
  rowsBeneath,
  siblingKey,
} from "./view"

/**
 * The block editor's **command layer**: named, input-agnostic intents ("indent
 * this row", "delete this row", "split at the caret") expressed as pure
 * functions over the document.
 *
 * This is the seam every entry point calls into — the keyboard today (via the
 * keymap in `keymap.ts`), and touch gestures or a block menu tomorrow. A swipe
 * that indents a row dispatches the same `indent` command a Tab press does, so
 * the behaviour is defined once and never duplicated per input method.
 *
 * Commands act on a **row** — an occurrence key (`src/blocks/view.ts`), the
 * path from a root to the block — so a block that appears twice in the view
 * is two distinct places to indent, delete or navigate from, and its parent
 * is read off the key rather than searched for. The block's own text and
 * type are still the node's, changed by id.
 *
 * Commands are **pure**: they take the current doc plus a little UI context and
 * return a `CommandResult` describing what should change (a new doc, where focus
 * should land, whether a row's fold toggles). The editor component owns the
 * actual state and applies the result — commands never touch React or the
 * DOM, which keeps them trivially testable.
 */

export type Mode = "select" | "edit"

/** Caret state read from the edit textarea, for caret-sensitive commands. */
export interface CaretInput {
  /** The visible body text (marker stripped) currently in the textarea. */
  value: string
  start: number
  end: number
  /** Whether the caret sits on the first / last visual line (for arrow-outs). */
  atFirstLine: boolean
  atLastLine: boolean
}

export interface CommandInput {
  doc: BlockDoc
  /** The row the command acts on: an occurrence key. */
  key: string
  mode: Mode
  /** On-screen order of the visible rows' keys (collapsed children skipped). */
  visibleOrder: string[]
  /** Present in edit mode; absent in select mode. */
  caret?: CaretInput
  /**
   * The character the key would type, when it types one (`KeyboardEvent.key`).
   * Set by the dispatcher for every key; read only by `wrapTyped`, which is
   * the one command whose behaviour depends on *which* character arrived
   * rather than on a binding of its own (see `WRAP_PAIRS`).
   */
  typed?: string
  /** The block the editor is zoomed into ("focus mode"), or null/absent. While
   * zoomed, the visible world is this block plus its subtree — commands must
   * not move, delete, or navigate past that boundary. */
  zoomRootId?: string | null
  /** Zoomed: whether the root is drawn as the view's TITLE, above the rows
   * (a heading — `titlesZoom`, src/blocks/markers.ts), rather than as the
   * view's first row. Titled, moving up out of the rows hands the keyboard
   * to the title; untitled, the root is a row like any other and "up" from
   * one of its children simply lands on it. The boundary itself is the same
   * either way — nothing leaves the zoomed subtree. */
  zoomTitled?: boolean
  /** The id of the view's own root when it is not a block in the doc (the
   * note) — on the path above every row, so a row's parent that is the
   * note is never one of the rows beneath it (`rowsBeneath`). */
  rootId?: string | null
  /** Where zooming out one level returns to: the previous entry in the zoom
   * navigation stack — the path the user actually took, which under the graph
   * model (multi-parent blocks) is the only honest "up". Null/absent when
   * nothing is below on the stack; zoom-out then exits zoom entirely. */
  zoomBackId?: string | null
  /**
   * The type a fresh block starts as when Enter creates one from a block that
   * isn't a list item (those continue their own list), and what an empty list
   * item becomes when Enter leaves the list. A user preference — `ul` by
   * default, `text` for a plain paragraph, or any other type (`todo`,
   * `quote`). Absent = the default.
   */
  newBlockType?: BlockType
  /**
   * How many places a block appears across the corpus (its parents in the
   * graph, this note's included) — what tells a command the block is shared
   * and an edit to its text would show everywhere. Absent = one place.
   */
  placesOf?: (id: string) => number
  /**
   * Whether the doc may be left with no blocks at all. Absent or false, the
   * only root block cannot be removed — a note keeps a block to type in. True
   * for a view whose rows are all it is (the Unassigned basket): removing the
   * last row empties it.
   */
  emptyable?: boolean
}

/** Where selection / edit focus should land after a command runs (a row). */
export type FocusIntent =
  | { mode: "select"; key: string | null }
  | { mode: "edit"; key: string; atStart?: boolean; caret?: number }

export interface CommandResult {
  /** Whether the command consumed the gesture (the caller preventDefaults). */
  handled: boolean
  /** New document, when structure or content changed. */
  doc?: BlockDoc
  /** History op describing the change (defaults to structural when `doc` set). */
  op?: BlockOp
  /** Requested focus / selection change. */
  focus?: FocusIntent
  /** Row whose fold should toggle. */
  toggleCollapse?: string
  /** Row that must end up expanded (the editor clears its fold if set).
   * Commands can't see collapse state — it lives in the component — so this
   * is a demand, not a toggle: expanding an already-open row is a no-op. */
  expand?: string
  /** Row that must end up collapsed — the symmetric demand to `expand`: the
   * editor folds the row only if it is currently open. */
  collapse?: string
  /** Row that must be open *whatever the fold rule would say* — recorded as
   * the reader's own, the way opening it by hand would be. `expand` cannot
   * do this: it acts only on a row that is folded right now, and the row
   * this names is one that is about to become a parent for the first time
   * (nothing beneath it yet, so nothing folded), which the depth rule would
   * otherwise close the instant it gains a child. */
  reveal?: string
  /** Navigation tried to move above the first block — the caller may hand focus
   * to whatever sits above the editor (e.g. the note title). */
  exitTop?: boolean
  /** Navigation tried to move below the last block — the caller may hand
   * focus to whatever sits below the editor (a second results list). */
  exitBottom?: boolean
  /** Requested zoom change: `{ id: null }` exits zoom, `{ id }` zooms into a
   * block. Absent = no change. The editor navigates (URL state) accordingly. */
  zoom?: { id: string | null }
  /** Why the command did nothing, for the reader (a toast). */
  notice?: string
}

type Command = (input: CommandInput) => CommandResult

const IGNORED: CommandResult = { handled: false }
const STRUCTURAL: BlockOp = { type: "structural" }

/** The block a row shows. */
const blockOf = ({ doc, key }: CommandInput) => doc.blocks[idOfKey(key)]

/** The keys of the rows beneath a row, in order: its children, then the
 * parents shown under it (`rowsBeneath`) — what a fold hides or shows. */
function keysBeneath({ doc, key, rootId, zoomRootId }: CommandInput): string[] {
  const path = new Set(pathIdsOf(key))
  if (rootId) path.add(rootId)
  if (zoomRootId) path.add(zoomRootId)
  const block = doc.blocks[idOfKey(key)] ?? null
  return rowsBeneath(doc, block, path, directionOfKey(key)).map((row) =>
    keyOf(key, row.id, row.direction),
  )
}

/** Does `parentKey` name the zoomed block — i.e. is this row a direct child
 * of the zoom root, at the top of the zoomed view? What the zoom boundary is
 * drawn at: its children cannot be lifted out of it (`outdent`). */
const parentIsZoomRoot = (parentKey: string | null, zoomRootId: string | null | undefined) =>
  !!zoomRootId && parentKey !== null && idOfKey(parentKey) === zoomRootId

/** The same row, but only where the zoom root is the view's TITLE rather than
 * its first row: a move up from one of its children then leaves the rows for
 * the title — `exitTop`, as leaving the first row of a note does. Untitled,
 * the root is a row, so "up" just selects it like any other parent. */
const parentIsZoomTitle = (parentKey: string | null, { zoomRootId, zoomTitled }: CommandInput) =>
  zoomTitled !== false && parentIsZoomRoot(parentKey, zoomRootId)

/** Up from the rows: the editor hands focus to the title above them. */
const EXIT_TOP: CommandResult = { handled: true, exitTop: true }

/** The reader's configured new-block type — an unordered list item by default. */
const defaultNewType = (input: CommandInput): BlockType =>
  input.newBlockType ?? DEFAULT_NEW_BLOCK_TYPE

/**
 * The type a new sibling block should take. Lists (bullet, numbered, to-do)
 * continue their own type; everything else (paragraph, heading, quote) starts
 * as the user's configured new-block type.
 */
function continuationType(type: BlockType, input: CommandInput): BlockType {
  return defOf(type).continues ?? defaultNewType(input)
}

/** The type for a new block of the *same* type as `type` — used by Shift-Enter
 * so a heading splits into a heading, a quote into a quote, and so on. A
 * checked todo continues as an unchecked one; a note root never continues. */
function sameType(type: BlockType): BlockType {
  return defOf(type).splitsAs ?? type
}

/**
 * Keep the given row focused, in whichever mode we're already in. When a
 * caret is passed (edit mode), preserve its position so an operation that only
 * reshapes the tree — indent, outdent, reorder — doesn't fling the cursor to the
 * end of the block.
 */
function keepFocus(mode: Mode, key: string, caret?: CaretInput): FocusIntent {
  return mode === "edit" ? { mode: "edit", key, caret: caret?.start } : { mode: "select", key }
}

/** The nearest ancestor row of `key` present in `visibleOrder`, or null. Used
 * to recover when the selected row is hidden inside a newly collapsed parent. */
function nearestVisibleAncestor(key: string, visibleOrder: string[]): string | null {
  return ancestorKeys(key).find((ancestor) => visibleOrder.includes(ancestor)) ?? null
}

/** Move the highlight to the previous / next visible row (select mode). */
function moveSelection(direction: "up" | "down"): Command {
  return ({ key, visibleOrder }) => {
    const i = visibleOrder.indexOf(key)
    if (i === -1) {
      // The selected row is hidden inside a collapsed parent — arrows would
      // otherwise be dead. Recover onto the nearest visible ancestor.
      const ancestor = nearestVisibleAncestor(key, visibleOrder)
      const target = ancestor ?? visibleOrder[0] ?? null
      return { handled: true, focus: { mode: "select", key: target } }
    }
    const next = direction === "up" ? i - 1 : i + 1
    // Moving up past the first block hands focus to whatever's above the
    // editor: the note title, or the zoom title while zoomed.
    if (next < 0) return EXIT_TOP
    // Past the last block it hands focus to whatever is below (`exitBottom`
    // — a second results list under this one); consumed either way, so the
    // page never scrolls instead.
    if (next >= visibleOrder.length) return { handled: true, exitBottom: true }
    return { handled: true, focus: { mode: "select", key: visibleOrder[next] } }
  }
}

/** Move the highlight (or edit focus) to the previous / next sibling, skipping
 * whatever is nested between them. */
function siblingJump(direction: "prev" | "next"): Command {
  return (input) => {
    const { doc, key, mode } = input
    const info = siblingsOf(doc, key)
    if (!info) return { handled: true }
    const target = direction === "prev" ? info.index - 1 : info.index + 1
    if (target < 0 || target >= info.siblings.length) return { handled: true }
    return { handled: true, focus: keepFocus(mode, siblingKey(key, info.siblings[target])) }
  }
}

/**
 * An arrow leaving the edited block *commits* the edit: it exits edit mode and
 * highlights the adjacent row (select mode), rather than walking into the
 * neighbour still editing. At the very first row it hands focus upward
 * (`exitTop`, e.g. to the note title); at the very last it exits in place,
 * highlighting the row that was being edited.
 */
function moveEditFocus(direction: "up" | "down"): Command {
  return ({ key, visibleOrder }) => {
    const i = visibleOrder.indexOf(key)
    if (direction === "up") {
      if (i > 0) return { handled: true, focus: { mode: "select", key: visibleOrder[i - 1] } }
      // At the very top: hand focus to the title above the rows.
      return EXIT_TOP
    }
    if (i >= 0 && i < visibleOrder.length - 1) {
      return { handled: true, focus: { mode: "select", key: visibleOrder[i + 1] } }
    }
    return { handled: true, focus: { mode: "select", key } }
  }
}

/** Split the block at the caret; `typeFor` decides the new block's type — a
 * list continuation for Enter, the same type for Shift-Enter. */
function splitAtCaret(typeFor: (type: BlockType, input: CommandInput) => BlockType): Command {
  return (input) => {
    const { doc, key, caret } = input
    if (!caret) return IGNORED
    const id = idOfKey(key)
    const type = doc.blocks[id]?.type ?? "text"
    const before = caret.value.slice(0, caret.start)
    const after = caret.value.slice(caret.end)
    // A block held in more than one place is one block: cutting its text here
    // would cut it everywhere it shows, with the tail landing only here. So
    // a split that would take text off it is refused — Enter at its end still
    // adds a block below, since that leaves the text alone.
    const places = input.placesOf?.(id) ?? 1
    if (after !== "" && places > 1) {
      return {
        handled: true,
        notice: `This block is in ${places} places, so it can't be split`,
      }
    }
    const updated = updateText(doc, id, before)
    const fresh = emptyBlock(typeFor(type, input), after)
    const next = insertAfter(updated, key, fresh)
    const freshKey = siblingKey(key, fresh.id)
    return {
      handled: true,
      doc: next,
      op: STRUCTURAL,
      focus: { mode: "edit", key: freshKey, atStart: true },
    }
  }
}

/** Duplicate the row's subtree; focus follows the copy (VS Code semantics:
 * duplicate-down lands on the lower copy, duplicate-up on the upper). In edit
 * mode the copy opens editing with the caret preserved ("duplicate line"). */
function duplicate(direction: "above" | "below"): Command {
  return (input) => {
    const { doc, key, mode, caret } = input
    const result = duplicateBlocks(doc, [key], direction)
    if (!result) return { handled: true }
    return {
      handled: true,
      doc: result.doc,
      op: STRUCTURAL,
      focus: keepFocus(mode, result.copies[0], caret),
    }
  }
}

/**
 * Wrap the edit selection in an inline markdown marker — `**` for bold, `_`
 * for italic, a backtick for code — or take the marker off a selection that
 * already has it, either side. With nothing selected the pair goes in at the
 * caret and the caret lands between, ready to type. The text is the block's
 * as stored (markdown), so this is a text edit like typing the marker: one
 * coalescing undo step, the row still editing, the caret after the
 * selection's new end. Edit mode only: select mode has no selection to wrap.
 */
export function wrapSelection(
  value: string,
  start: number,
  end: number,
  marker: string,
): { text: string; start: number; end: number } {
  const n = marker.length
  const inside = value.slice(start, end)
  // Already wrapped, marker inside the selection: `**bold**` → `bold`.
  if (inside.length >= 2 * n && inside.startsWith(marker) && inside.endsWith(marker)) {
    const bare = inside.slice(n, inside.length - n)
    return {
      text: value.slice(0, start) + bare + value.slice(end),
      start,
      end: start + bare.length,
    }
  }
  // Already wrapped, marker just outside the selection: `**|bold|**` → `bold`.
  if (
    start >= n &&
    value.slice(start - n, start) === marker &&
    value.slice(end, end + n) === marker
  ) {
    return {
      text: value.slice(0, start - n) + inside + value.slice(end + n),
      start: start - n,
      end: start - n + inside.length,
    }
  }
  return {
    text: value.slice(0, start) + marker + inside + marker + value.slice(end),
    start: start + n,
    end: start + n + inside.length,
  }
}

/**
 * The characters that wrap a selection when they are typed over one, each
 * paired with what closes it. Symmetric marks (a quote, a backtick, `*`)
 * close with themselves; a bracket closes with its partner. Typing the
 * closing character of a pair is not a wrap — it types, as it always did —
 * so only the openers are listed.
 *
 * `**` for bold and `_` for italic have keys of their own
 * (<kbd>⌘</kbd><kbd>B</kbd>, <kbd>⌘</kbd><kbd>I</kbd>) which *toggle*; the
 * characters here only ever add, which is what typing a character should do.
 * Wrapping `(foo)` in parentheses again gives `((foo))`, never `foo`.
 */
export const WRAP_PAIRS: Readonly<Record<string, string>> = {
  "`": "`",
  '"': '"',
  "'": "'",
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
  "*": "*",
  _: "_",
  "~": "~",
}

/**
 * Put `open` before the selection and `close` after it — the typed wrap,
 * which never takes a wrap off (see `WRAP_PAIRS`). Returns the text and where
 * the selection now sits inside it.
 */
export function surroundSelection(
  value: string,
  start: number,
  end: number,
  open: string,
  close: string,
): { text: string; start: number; end: number } {
  return {
    text: value.slice(0, start) + open + value.slice(start, end) + close + value.slice(end),
    start: start + open.length,
    end: start + open.length + (end - start),
  }
}

/**
 * Make the selection a markdown link, `[text](url)`, and put the caret where
 * the missing half goes: after the text, in the parentheses, for the address
 * to be typed; or, when the selection is itself an address, in the brackets,
 * for its name (a bare address in a block names itself, so this is for
 * choosing a name). With nothing selected the empty shape goes in with the
 * caret in the brackets.
 */
export function linkSelection(
  value: string,
  start: number,
  end: number,
): { text: string; caret: number } {
  const inside = value.slice(start, end)
  const address = /^(https?:\/\/|www\.)\S+$/i.test(inside)
  const link = address ? `[](${inside})` : `[${inside}]()`
  const caret = address ? start + 1 : start + inside.length + 3
  return { text: value.slice(0, start) + link + value.slice(end), caret }
}

function wrapWith(marker: string): Command {
  return (input) => {
    const { doc, key, mode, caret } = input
    if (mode !== "edit" || !caret) return IGNORED
    const id = idOfKey(key)
    const wrapped = wrapSelection(caret.value, caret.start, caret.end, marker)
    return {
      handled: true,
      doc: updateText(doc, id, wrapped.text),
      op: { type: "text", blockId: id },
      focus: { mode: "edit", key, caret: wrapped.end },
    }
  }
}

/**
 * Select-mode "turn into": toggle the block to the given type. Text and
 * children are never touched — this is a type change only, one structural
 * undo step. An *empty* block additionally opens editing (caret at the end) so
 * the marker key starts you typing that block type immediately. Allowed on the
 * zoomed title too (a type change never escapes the view).
 */
function turnInto(target: BlockType): Command {
  return (input) => {
    const { doc, key, mode } = input
    const block = blockOf(input)
    if (!block) return IGNORED
    const result: CommandResult = {
      handled: true,
      doc: updateType(doc, block.id, toggleType(block.type, target)),
      op: STRUCTURAL,
    }
    if (block.text.trim() === "") return { ...result, focus: { mode: "edit", key } }
    return { ...result, focus: keepFocus(mode, key) }
  }
}

export type CommandName =
  | "wrapBold"
  | "wrapItalic"
  | "wrapStrike"
  | "wrapCode"
  | "wrapMath"
  | "wrapLink"
  | "wrapTyped"
  | "enterEdit"
  | "exitEdit"
  | "deselect"
  | "indent"
  | "outdent"
  | "moveSelectionUp"
  | "moveSelectionDown"
  | "moveEditFocusUp"
  | "moveEditFocusDown"
  | "prevSibling"
  | "nextSibling"
  | "treePrev"
  | "treeNext"
  | "selectParent"
  | "selectFirstChild"
  | "expandOrFirstChild"
  | "collapseOrParent"
  | "jumpLevelTop"
  | "jumpLevelBottom"
  | "moveBlockUp"
  | "moveBlockDown"
  | "duplicateAbove"
  | "duplicateBelow"
  | "deleteBlock"
  | "toggleTodo"
  | "turnIntoHeading"
  | "turnIntoBullet"
  | "turnIntoTodo"
  | "turnIntoQuote"
  | "turnIntoOrdered"
  | "turnIntoCode"
  | "openFence"
  | "toggleCollapse"
  | "insertBelow"
  | "insertSiblingBelow"
  | "splitContinuingList"
  | "splitPlain"
  | "exitList"
  | "stripMarker"
  | "backspaceEmpty"
  | "zoomIn"
  | "zoomOut"
  | "zoomExit"

export const COMMANDS: Record<CommandName, Command> = {
  /** Select → edit the highlighted row. */
  enterEdit: ({ key }) => ({ handled: true, focus: { mode: "edit", key } }),

  /** Edit → back to highlighting the row. */
  exitEdit: ({ key }) => ({ handled: true, focus: { mode: "select", key } }),

  /** Select → nothing focused (Escape's last rung). Arrows re-select. */
  deselect: () => ({ handled: true, focus: { mode: "select", key: null } }),

  /** Nest the row under its previous sibling; keeps the current mode/focus
   * (and, when editing, the caret position) — on the row's new key. The row
   * it goes under is revealed: a leaf that has just become a parent sits at
   * whatever level it sits at, and from the depth rule's second level down
   * that rule would fold it the moment it gains a child — hiding the row
   * just indented, mid-edit. Nesting something under a row is asking to see
   * it, so the open is recorded as the reader's own. */
  indent: (input) => {
    const { doc, key, mode, caret } = input
    const next = indentBlock(doc, key)
    // Consume the key even when it can't indent (no previous sibling), so Tab
    // never escapes the editor.
    if (next.doc === doc) return { handled: true, focus: keepFocus(mode, key, caret) }
    return {
      handled: true,
      doc: next.doc,
      op: STRUCTURAL,
      reveal: parentKeyOf(next.key) ?? undefined,
      focus: keepFocus(mode, next.key, caret),
    }
  },

  /** Lift the row out to become a sibling of its parent. */
  outdent: (input) => {
    const { doc, key, mode, caret, zoomRootId } = input
    // Zoom boundary: outdenting a direct child of the zoom root (which would
    // become the root's sibling and leave the view) is a no-op — as is
    // outdenting the zoom root itself, where it leads the view as a row.
    if (
      parentIsZoomRoot(parentKeyOf(key), zoomRootId) ||
      (zoomRootId && idOfKey(key) === zoomRootId)
    ) {
      return { handled: true, focus: keepFocus(mode, key, caret) }
    }
    const next = outdentBlock(doc, key)
    if (next.doc === doc) return { handled: true, focus: keepFocus(mode, key, caret) }
    return { handled: true, doc: next.doc, op: STRUCTURAL, focus: keepFocus(mode, next.key, caret) }
  },

  moveSelectionUp: moveSelection("up"),
  moveSelectionDown: moveSelection("down"),
  moveEditFocusUp: moveEditFocus("up"),
  moveEditFocusDown: moveEditFocus("down"),

  /** Move to the previous / next sibling at the same level, skipping any
   * descendants in between (e.g. jump header→header across their children). */
  prevSibling: siblingJump("prev"),
  nextSibling: siblingJump("next"),

  // ── WASD tree navigation (a/d walk depth; w/s traverse siblings, breaking
  // out of the level at its ends — unlike the stop-at-ends Mod+Alt+Arrow
  // sibling jumps, which keep their own commands above) ─────────────────────

  /** w: previous sibling — or, at the FIRST sibling of a level, break out
   * upward to the parent. On the first root block (nothing above) it no-ops;
   * on the first child of the zoomed view it steps up to the title. */
  treePrev: (input) => {
    const { doc, key, mode } = input
    const info = siblingsOf(doc, key)
    if (!info) return { handled: true }
    if (info.index > 0) {
      return {
        handled: true,
        focus: keepFocus(mode, siblingKey(key, info.siblings[info.index - 1])),
      }
    }
    // Top of the level: continue the traversal one level out, upward. A direct
    // child of the zoom root lands on the title (its parent), above the rows.
    if (info.parentKey === null) return { handled: true }
    if (parentIsZoomTitle(info.parentKey, input)) return EXIT_TOP
    return { handled: true, focus: keepFocus(mode, info.parentKey) }
  },

  /** s: next sibling — or, at the LAST sibling of a level, walk up the
   * ancestor chain until an ancestor has a next sibling and select it
   * (continue the traversal one level out, downward). At the end of the
   * document — or of the zoomed subtree, which the walk never escapes — no-op. */
  treeNext: (input) => {
    const { doc, key, mode, zoomRootId } = input
    let cur = key
    for (;;) {
      const info = siblingsOf(doc, cur)
      if (!info) return { handled: true }
      if (info.index < info.siblings.length - 1) {
        return {
          handled: true,
          focus: keepFocus(mode, siblingKey(cur, info.siblings[info.index + 1])),
        }
      }
      // Last sibling: climb — but never past the zoom root or the document.
      if (info.parentKey === null) return { handled: true }
      if (zoomRootId && info.parentId === zoomRootId) return { handled: true }
      cur = info.parentKey
    }
  },

  /** Step up the tree: select the parent (no-op on a root-level row). While
   * zoomed the title *is* the local root: "up" from one of its children goes
   * to the title, above the rows. */
  selectParent: (input) => {
    const { key, mode } = input
    const parentKey = parentKeyOf(key)
    if (parentKey === null) return { handled: true }
    if (parentIsZoomTitle(parentKey, input)) return EXIT_TOP
    return { handled: true, focus: keepFocus(mode, parentKey) }
  },

  /** Step down the tree: select the first child (no-op on a leaf). A collapsed
   * row auto-expands in the same keypress — the `expand` demand tells the
   * editor to clear its fold so the child is actually visible. */
  selectFirstChild: (input) => {
    const { key, mode } = input
    const first = keysBeneath(input)[0]
    if (!first) return { handled: true }
    return { handled: true, expand: key, focus: keepFocus(mode, first) }
  },

  // ── Arrow-key folding (the tree-view convention: ←/→ fold before they
  // move). Commands can't see collapse state, but `visibleOrder` betrays it:
  // a row with children is collapsed exactly when its first child's row was
  // skipped from the on-screen order. ──────────────────────────────────────

  /** →: expand a collapsed row (staying on it); already expanded → step into
   * the first child (like `d`, minus the auto-expand). Leaf: no-op. */
  expandOrFirstChild: (input) => {
    const { key, mode, visibleOrder } = input
    const firstKey = keysBeneath(input)[0]
    if (!firstKey) return { handled: true }
    // Collapsed: open it and stay put — the second press steps in. (The zoomed
    // title is always open on screen, so it steps straight into its children.)
    if (!visibleOrder.includes(firstKey)) return { handled: true, expand: key }
    return { handled: true, focus: keepFocus(mode, firstKey) }
  },

  /** ←: collapse an expanded row (staying on it); collapsed or leaf → step
   * out to the parent. Root-level collapsed/leaf: no-op. Zoomed, a direct
   * child's "parent" is the title above the rows, so the fold walk never
   * escapes the zoomed subtree. */
  collapseOrParent: (input) => {
    const { key, mode, visibleOrder } = input
    const first = keysBeneath(input)[0]
    if (first && visibleOrder.includes(first)) return { handled: true, collapse: key }
    const parentKey = parentKeyOf(key)
    if (parentKey === null) return { handled: true }
    if (parentIsZoomTitle(parentKey, input)) return EXIT_TOP
    return { handled: true, focus: keepFocus(mode, parentKey) }
  },

  /** Jump to the top of the current level (its first sibling); if already there,
   * step up to the parent. Walks up levels rather than to the note top. */
  jumpLevelTop: (input) => {
    const { doc, key, mode } = input
    const info = siblingsOf(doc, key)
    if (!info) return { handled: true }
    if (info.index > 0) {
      return { handled: true, focus: keepFocus(mode, siblingKey(key, info.siblings[0])) }
    }
    if (info.parentKey === null) return { handled: true }
    if (parentIsZoomTitle(info.parentKey, input)) return EXIT_TOP
    return { handled: true, focus: keepFocus(mode, info.parentKey) }
  },
  /** Jump to the bottom of the current level (its last sibling). */
  jumpLevelBottom: (input) => {
    const { doc, key, mode } = input
    const info = siblingsOf(doc, key)
    if (!info || info.index >= info.siblings.length - 1) return { handled: true }
    const last = info.siblings[info.siblings.length - 1]
    return { handled: true, focus: keepFocus(mode, siblingKey(key, last)) }
  },

  /** Reorder the row among its siblings (subtree comes along). Preserves the
   * caret when editing so the cursor rides along with the moved block. */
  moveBlockUp: (input) => {
    const { doc, key, mode, caret } = input
    const next = moveBlock(doc, key, "up")
    if (next === doc) return { handled: true }
    return { handled: true, doc: next, op: STRUCTURAL, focus: keepFocus(mode, key, caret) }
  },
  moveBlockDown: (input) => {
    const { doc, key, mode, caret } = input
    const next = moveBlock(doc, key, "down")
    if (next === doc) return { handled: true }
    return { handled: true, doc: next, op: STRUCTURAL, focus: keepFocus(mode, key, caret) }
  },

  /** Duplicate the row (and its subtree) above / below itself. */
  duplicateAbove: duplicate("above"),
  duplicateBelow: duplicate("below"),

  /** Delete the highlighted row and its subtree (select mode). The selection
   * lands on the visible row that takes the deleted one's place — the one
   * that slides up from below — falling back to the row above when the
   * deleted row was last. */
  deleteBlock: (input) => {
    const { doc, key, visibleOrder, zoomRootId, zoomTitled } = input
    const id = idOfKey(key)
    // The zoomed view's own root, where it leads the view as a row: removing
    // it from inside would take the view with it — say so rather than doing
    // nothing, since the row looks removable like any other.
    if (zoomRootId && id === zoomRootId) {
      return { handled: true, notice: "Leave focus to remove the block you're focused on" }
    }
    const onlyBlock =
      doc.rootBlockIds.length === 1 &&
      doc.rootBlockIds[0] === id &&
      (doc.blocks[id]?.children.length ?? 0) === 0
    if (onlyBlock && !input.emptyable) return { handled: true }
    const { doc: next } = removeBlock(doc, key)
    // Walk the pre-delete visible order outward from the deleted row: first
    // below (skipping its own removed subtree via the survives-in-next check),
    // then above.
    const at = visibleOrder.indexOf(key)
    let focusKey: string | null = null
    for (let i = at + 1; i < visibleOrder.length && !focusKey; i++) {
      if (hasOccurrence(next, visibleOrder[i])) focusKey = visibleOrder[i]
    }
    for (let i = at - 1; i >= 0 && !focusKey; i--) {
      if (hasOccurrence(next, visibleOrder[i])) focusKey = visibleOrder[i]
    }
    // The zoomed view emptied: the title above the rows takes the keyboard
    // (the zoomed block alone is a valid view — Enter on it makes a child).
    // Untitled there is no title to hand it to: the root row is still there,
    // and the fallback below lands on it.
    if (!focusKey && zoomRootId && zoomTitled !== false) {
      return { handled: true, doc: next, op: STRUCTURAL, exitTop: true }
    }
    return {
      handled: true,
      doc: next,
      op: STRUCTURAL,
      focus: { mode: "select", key: focusKey ?? next.rootBlockIds[0] ?? null },
    }
  },

  /** Toggle a todo's checkbox from select mode (no-op on other blocks):
   * checked is a TYPE, so this is `todo` ↔ `done`. */
  toggleTodo: (input) => {
    const { doc, key, mode } = input
    const block = blockOf(input)
    const type = block?.type
    if (!block || (type !== "todo" && type !== "done")) return IGNORED
    return {
      handled: true,
      doc: updateType(doc, block.id, type === "todo" ? "done" : "todo"),
      op: { type: "text", blockId: block.id },
      focus: keepFocus(mode, key),
    }
  },

  /** Inline markdown around the selection (see `wrapWith`): the touch
   * screen's edit bar, which has no Cmd to chord with. */
  wrapBold: wrapWith("**"),
  wrapItalic: wrapWith("_"),
  wrapStrike: wrapWith("~~"),
  wrapCode: wrapWith("`"),
  wrapMath: wrapWith("$$"),
  /**
   * A wrapping character typed over a selection puts the selection inside it
   * rather than replacing it: select a phrase, press <kbd>(</kbd>, and it is
   * in parentheses. Which character arrived decides the pair (`WRAP_PAIRS`),
   * so this is one command rather than ten — the keymap resolves every
   * opener to it (`resolveKey`). With nothing selected there is nothing to
   * wrap and the character simply types.
   */
  wrapTyped: (input) => {
    const { doc, key, mode, caret, typed } = input
    if (mode !== "edit" || !caret || caret.start === caret.end) return IGNORED
    const close = typed === undefined ? undefined : WRAP_PAIRS[typed]
    if (typed === undefined || close === undefined) return IGNORED
    const id = idOfKey(key)
    const wrapped = surroundSelection(caret.value, caret.start, caret.end, typed, close)
    return {
      handled: true,
      doc: updateText(doc, id, wrapped.text),
      op: { type: "text", blockId: id },
      focus: { mode: "edit", key, caret: wrapped.end },
    }
  },
  wrapLink: (input) => {
    const { doc, key, mode, caret } = input
    if (mode !== "edit" || !caret) return IGNORED
    const id = idOfKey(key)
    const linked = linkSelection(caret.value, caret.start, caret.end)
    return {
      handled: true,
      doc: updateText(doc, id, linked.text),
      op: { type: "text", blockId: id },
      focus: { mode: "edit", key, caret: linked.caret },
    }
  },

  /** Select-mode marker keys: toggle the block's type (see `turnInto`). */
  turnIntoHeading: turnInto("h1"),
  turnIntoBullet: turnInto("ul"),
  turnIntoTodo: turnInto("todo"),
  turnIntoQuote: turnInto("quote"),
  turnIntoOrdered: turnInto("ol"),
  turnIntoCode: turnInto("code"),

  /**
   * The fence shortcut: Enter on a block whose whole text is three backticks
   * and an optional language (```` ```js ````) turns it into an empty code
   * block of that language, editing. The keymap guards the shape
   * (`isFenceOpener`); the language is whatever followed the backticks.
   */
  openFence: ({ doc, key, caret }) => {
    const id = idOfKey(key)
    const language = /^```[ \t]*(\S*)\s*$/.exec(caret?.value ?? "")?.[1] ?? ""
    return {
      handled: true,
      doc: updateBlock(doc, id, {
        type: "code",
        text: "",
        props: language ? { language } : null,
      }),
      op: STRUCTURAL,
      focus: { mode: "edit", key, atStart: true },
    }
  },

  /** Collapse / expand a row with children; consumes Space regardless (so the
   * page never scrolls) but only toggles when there's something to fold. */
  toggleCollapse: (input) => {
    const hasChildren = keysBeneath(input).length > 0
    if (!hasChildren) return { handled: true }
    return { handled: true, toggleCollapse: input.key }
  },

  /** Enter at end of line: a fresh continuation block below. Enter from a
   * heading nests the new block under it, like an outline section. */
  insertBelow: (input) => {
    const { doc, key } = input
    const id = idOfKey(key)
    const type = doc.blocks[id]?.type ?? "text"
    const fresh = emptyBlock(continuationType(type, input))
    let next = insertAfter(doc, key, fresh)
    let freshKey = siblingKey(key, fresh.id)
    if (isHeading(type)) ({ doc: next, key: freshKey } = indentBlock(next, freshKey))
    return { handled: true, doc: next, op: STRUCTURAL, focus: { mode: "edit", key: freshKey } }
  },

  /** New sibling block below, of the *same* type (Cmd/Shift+Enter). Unlike
   * `insertBelow` a heading stays a heading and doesn't nest. */
  insertSiblingBelow: (input) => {
    const { doc, key } = input
    const id = idOfKey(key)
    const fresh = emptyBlock(sameType(doc.blocks[id]?.type ?? "text"))
    const next = insertAfter(doc, key, fresh)
    const freshKey = siblingKey(key, fresh.id)
    return { handled: true, doc: next, op: STRUCTURAL, focus: { mode: "edit", key: freshKey } }
  },

  splitContinuingList: splitAtCaret(continuationType),
  // Shift-Enter keeps the current block's type for the new block.
  splitPlain: splitAtCaret(sameType),

  /** Enter on an empty list item exits the list: the block becomes the
   * reader's default new-block type, or a paragraph when the default is this
   * very list (the key must still leave the list). */
  exitList: (input) => {
    const { doc, key } = input
    const id = idOfKey(key)
    const preferred = defaultNewType(input)
    const type = preferred === doc.blocks[id]?.type ? "text" : preferred
    return {
      handled: true,
      doc: updateType(updateText(doc, id, ""), id, type),
      op: { type: "text", blockId: id },
      focus: { mode: "edit", key },
    }
  },

  /** Backspace at the start of a typed block drops its type (→ paragraph); the
   * text stays exactly as it was. */
  stripMarker: ({ doc, key }) => {
    const id = idOfKey(key)
    return {
      handled: true,
      doc: updateType(doc, id, "text"),
      op: { type: "text", blockId: id },
      focus: { mode: "edit", key, atStart: true },
    }
  },

  /** Backspace at the start of an empty block removes it, merging upward. */
  backspaceEmpty: (input) => {
    const { doc, key, zoomRootId, zoomTitled } = input
    const id = idOfKey(key)
    if (doc.rootBlockIds.length === 1 && doc.rootBlockIds[0] === id && !input.emptyable) {
      return { handled: true }
    }
    const { doc: next, focusKey } = removeBlock(doc, key)
    // Merging upward out of the zoomed view lands on its title. Untitled the
    // root is a row, so the merge lands on it like any other parent.
    if (zoomTitled !== false && zoomRootId && (!focusKey || idOfKey(focusKey) === zoomRootId)) {
      return { handled: true, doc: next, op: STRUCTURAL, exitTop: true }
    }
    return {
      handled: true,
      doc: next,
      op: STRUCTURAL,
      focus: focusKey
        ? { mode: "edit", key: focusKey }
        : { mode: "select", key: next.rootBlockIds[0] ?? null },
    }
  },

  // ── Zoom ("focus mode") ──────────────────────────────────────────────────
  // Commands only *request* the zoom change; the editor navigates (the zoom
  // lives in the URL) and then places the selection — first child on zoom-in,
  // the block zoomed out from on zoom-out.

  /** Zoom into the row's block: its subtree becomes the whole view. */
  zoomIn: (input) => ({ handled: true, zoom: { id: idOfKey(input.key) } }),

  /** Zoom out one level — to the zoom root's parent, or fully at the top. */
  zoomOut: ({ zoomRootId, zoomBackId }) => {
    if (!zoomRootId) return IGNORED
    return { handled: true, zoom: { id: zoomBackId ?? null } }
  },

  /** Exit zoom entirely, back to the whole note. */
  zoomExit: ({ zoomRootId }) => (zoomRootId ? { handled: true, zoom: { id: null } } : IGNORED),
}

/** Run a named command. Unknown names are a no-op (defensive). */
/**
 * The commands a **browse** view runs — a read-only editor the reader still
 * moves through (the notes list, a search's results): everything that moves
 * the highlight, folds a row or zooms, and nothing that writes. Enter is
 * the view's own (it opens the row rather than editing it), so `enterEdit`
 * is not here.
 */
export const BROWSE_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  "deselect",
  "moveSelectionUp",
  "moveSelectionDown",
  "prevSibling",
  "nextSibling",
  "treePrev",
  "treeNext",
  "selectParent",
  "selectFirstChild",
  "expandOrFirstChild",
  "collapseOrParent",
  "jumpLevelTop",
  "jumpLevelBottom",
  "toggleCollapse",
  "zoomIn",
  "zoomOut",
  "zoomExit",
])

export function runCommand(name: CommandName, input: CommandInput): CommandResult {
  const command = COMMANDS[name]
  return command ? command(input) : IGNORED
}
