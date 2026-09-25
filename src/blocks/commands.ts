import type { BlockOp } from "./history"
import { DEFAULT_NEW_BLOCK_TYPE, isHeading, toggleType } from "./markers"
import { defOf } from "./registry"
import {
  duplicateBlocks,
  emptyBlock,
  indentBlock,
  insertAfter,
  moveBlocks,
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
  isWithin,
  keyOf,
  parentKeyOf,
  pathIdsOf,
  rootKeys,
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
 * A **selection** of rows is the same commands over more rows: `keys` is
 * every selected row, and the structural commands — indent, outdent, move,
 * duplicate, delete, turn into, the todo toggle — act on its roots (the
 * rows with no selected ancestor, `rootKeys`) at once, as one undo step, so
 * a subtree the selection covers moves as one. A single row is a selection
 * of one, so there is one delete, not a delete and a bulk delete: the
 * keyboard, the block menu, the selection bar and the touch screen's edit
 * bar all run these, and the only difference between one row and many is
 * what the caller puts in `keys`.
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
  /** The row the command is at: the highlight, or the caret's row — an
   * occurrence key, one of `keys`. What a command about one row (moving
   * the highlight, editing, splitting) acts on. */
  key: string
  /** The rows the command acts on: every selected row, in document order,
   * `key` among them. One row is `[key]`. A structural command acts on
   * their roots (`rootKeys`), so a selected subtree moves as one. */
  keys: string[]
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
  /**
   * The type for `turnInto` — the one command whose target is chosen from a
   * menu (the selection bar's, the edit bar's) rather than bound to a key of
   * its own (`turnIntoHeading` and its siblings). Read only by `turnInto`.
   */
  blockType?: BlockType
  /** The block the editor is focused on, or null/absent. In focus, the
   * visible world is this block plus its subtree — commands must not move,
   * delete, or navigate past that boundary. */
  focusRootId?: string | null
  /** In focus: whether the root is drawn as the view's TITLE, above the rows
   * (a heading — `titlesFocus`, src/blocks/markers.ts), rather than as the
   * view's first row. Titled, moving up out of the rows hands the keyboard
   * to the title; untitled, the root is a row like any other and "up" from
   * one of its children simply lands on it. The boundary itself is the same
   * either way — nothing leaves the focused subtree. */
  focusTitled?: boolean
  /** The id of the view's own root when it is not a block in the doc (the
   * note) — on the path above every row, so a row's parent that is the
   * note is never one of the rows beneath it (`rowsBeneath`). */
  rootId?: string | null
  /** Where stepping back one level returns to: the previous entry in the focus
   * navigation stack — the path the user actually took, which under the graph
   * model (multi-parent blocks) is the only honest "up". Null/absent when
   * nothing is below on the stack; stepping back then leaves focus entirely. */
  focusBackId?: string | null
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
  | {
      mode: "select"
      key: string | null
      /** The rows to leave selected, `key` among them, where the command
       * kept a selection of several (on their new keys, after a move).
       * Absent: `key` alone is highlighted. */
      keys?: string[]
    }
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
  /** Rows that must be open *whatever the fold rule would say* — recorded
   * as the reader's own, the way opening them by hand would be. `expand`
   * cannot do this: it acts only on a row that is folded right now, and the
   * rows this names are ones about to become parents for the first time
   * (nothing beneath them yet, so nothing folded), which the depth rule
   * would otherwise close the instant they gain a child. */
  reveal?: string[]
  /** Navigation tried to move above the first block — the caller may hand focus
   * to whatever sits above the editor (e.g. the note title). */
  exitTop?: boolean
  /** Navigation tried to move below the last block — the caller may hand
   * focus to whatever sits below the editor (a second results list). */
  exitBottom?: boolean
  /** Requested change of focus ROOT — the block the whole view hangs from:
   * `{ id: null }` leaves focus, `{ id }` focuses that block. Absent = no
   * change. The editor navigates (URL state) accordingly. Distinct from
   * `focus` above, which is where the caret or highlight lands. */
  focusRoot?: { id: string | null }
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
function keysBeneath({ doc, key, rootId, focusRootId }: CommandInput): string[] {
  const path = new Set(pathIdsOf(key))
  if (rootId) path.add(rootId)
  if (focusRootId) path.add(focusRootId)
  const block = doc.blocks[idOfKey(key)] ?? null
  return rowsBeneath(doc, block, path, directionOfKey(key)).map((row) =>
    keyOf(key, row.id, row.direction),
  )
}

/** Does `parentKey` name the focused block — i.e. is this row a direct child
 * of the focus root, at the top of the focused view? What the focus boundary is
 * drawn at: its children cannot be lifted out of it (`outdent`). */
const parentIsFocusRoot = (parentKey: string | null, focusRootId: string | null | undefined) =>
  !!focusRootId && parentKey !== null && idOfKey(parentKey) === focusRootId

/** The same row, but only where the focus root is the view's TITLE rather than
 * its first row: a move up from one of its children then leaves the rows for
 * the title — `exitTop`, as leaving the first row of a note does. Untitled,
 * the root is a row, so "up" just selects it like any other parent. */
const parentIsFocusTitle = (parentKey: string | null, { focusRootId, focusTitled }: CommandInput) =>
  focusTitled !== false && parentIsFocusRoot(parentKey, focusRootId)

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

/** The rows a structural command acts on: the selection's roots. */
const rootsOf = (input: CommandInput): string[] => rootKeys(input.keys)

/** Is the selection several rows? Several are kept selected after a
 * command; a single row keeps its mode and caret. */
const isRange = (input: CommandInput): boolean => input.keys.length > 1

/** Carry a row's key across the rekeying a structural move did above it: a
 * row beneath a moved root has the root's new key as its prefix now. */
function rekey(moved: [from: string, to: string][]) {
  return (key: string | null): string | null => {
    if (key === null) return null
    const hit = moved.find(([from]) => isWithin(key, from))
    return hit ? hit[1] + key.slice(hit[0].length) : key
  }
}

/**
 * Where the selection lands after a structural command on its rows: a
 * single row keeps its mode (and, when editing, its caret) on its new key;
 * several rows stay selected, each on its new key, wherever the command
 * put them.
 */
function keepSelection(input: CommandInput, moved: [from: string, to: string][] = []): FocusIntent {
  const follow = rekey(moved)
  const key = follow(input.key) ?? input.key
  if (!isRange(input)) return keepFocus(input.mode, key, input.caret)
  return { mode: "select", key, keys: input.keys.map((row) => follow(row) ?? row) }
}

/** What the structure moves can do to the rows right now — what the
 * selection bar and the edit bar grey their items by, and what the commands
 * themselves check first, so a greyed item and a dead key agree. */
export interface Moves {
  /** Every root has a sibling above it to nest under. A range moves as
   * one: a root left behind would have the rest nest under it — under a
   * selected row, reshaping the very selection. */
  canIndent: boolean
  /** Some root has a parent it can be lifted out of — one that is not the
   * focus root, whose children cannot leave the view. */
  canOutdent: boolean
  /** The roots are one run of siblings with room above / below (`moveBlocks`). */
  canMoveUp: boolean
  canMoveDown: boolean
}

export function movesOf(input: CommandInput): Moves {
  const { doc, focusRootId } = input
  const places = rootsOf(input).flatMap((key) => {
    const at = siblingsOf(doc, key)
    return at ? [{ key, ...at }] : []
  })
  const first = places[0]
  const run =
    first !== undefined &&
    places.every(
      (at, k) =>
        at.parentKey === first.parentKey && at.direction === "down" && at.index === first.index + k,
    )
  return {
    canIndent: places.length > 0 && places.every((at) => at.index > 0),
    canOutdent: places.some(
      (at) =>
        at.parentKey !== null &&
        !parentIsFocusRoot(at.parentKey, focusRootId) &&
        !(focusRootId && idOfKey(at.key) === focusRootId),
    ),
    canMoveUp: run && first.index > 0,
    canMoveDown: run && places[places.length - 1].index < first.siblings.length - 1,
  }
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
    // editor: the note title, or the focus title while focused.
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

/** Duplicate the rows' subtrees as one group; focus follows the copy (VS
 * Code semantics: duplicate-down lands on the lower copy, duplicate-up on
 * the upper). In edit mode the copy opens editing with the caret preserved
 * ("duplicate line"). A range's copies are the new range, first to last. */
function duplicate(direction: "above" | "below"): Command {
  return (input) => {
    const { doc, mode, caret } = input
    const result = duplicateBlocks(doc, rootsOf(input), direction)
    if (!result) return { handled: true }
    const { copies } = result
    const focus: FocusIntent = isRange(input)
      ? { mode: "select", key: copies[copies.length - 1], keys: copies }
      : keepFocus(mode, copies[0], caret)
    return { handled: true, doc: result.doc, op: STRUCTURAL, focus }
  }
}

/** Move the rows as one group among their shared parent's children (a no-op
 * across parents, or at the end they are moving toward). The rows keep their
 * keys, so the selection stays where it was — and the caret with it. */
function moveGroup(direction: "up" | "down"): Command {
  return (input) => {
    const next = moveBlocks(input.doc, rootsOf(input), direction)
    if (next === input.doc) return { handled: true }
    return { handled: true, doc: next, op: STRUCTURAL, focus: keepSelection(input) }
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
 * "Turn into": every root to the given type — toggled, for a marker key (a
 * root already of the kind goes back to a paragraph), or set outright, for
 * a menu's pick. Text and children are never touched — this is a type
 * change only, one structural undo step; the type is the block's, so a
 * block selected in two rows changes once. An *empty* block on its own
 * additionally opens editing (caret at the end) so the marker key starts
 * you typing that block type immediately. Allowed on the focused title too
 * (a type change never escapes the view).
 */
function retype(input: CommandInput, target: BlockType, toggle: boolean): CommandResult {
  const { doc, key } = input
  const block = blockOf(input)
  if (!block) return IGNORED
  let next = doc
  for (const id of new Set(rootsOf(input).map(idOfKey))) {
    const each = next.blocks[id]
    if (each) next = updateType(next, id, toggle ? toggleType(each.type, target) : target)
  }
  const result: CommandResult = { handled: true, doc: next, op: STRUCTURAL }
  if (!isRange(input) && block.text.trim() === "") {
    return { ...result, focus: { mode: "edit", key } }
  }
  return { ...result, focus: keepSelection(input) }
}

/** The marker keys' "turn into": a toggle (see `retype`). */
function turnInto(target: BlockType): Command {
  return (input) => retype(input, target, true)
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
  | "turnInto"
  | "openFence"
  | "toggleCollapse"
  | "insertBelow"
  | "insertSiblingBelow"
  | "splitContinuingList"
  | "splitPlain"
  | "exitList"
  | "stripMarker"
  | "backspaceEmpty"
  | "focusBlock"
  | "focusBack"
  | "leaveFocus"

export const COMMANDS: Record<CommandName, Command> = {
  /** Select → edit the highlighted row. */
  enterEdit: ({ key }) => ({ handled: true, focus: { mode: "edit", key } }),

  /** Edit → back to highlighting the row. */
  exitEdit: ({ key }) => ({ handled: true, focus: { mode: "select", key } }),

  /** Select → nothing focused (Escape's last rung). Arrows re-select. A
   * range first collapses back to its head row, the rung before. */
  deselect: (input) => ({
    handled: true,
    focus: { mode: "select", key: isRange(input) ? input.key : null },
  }),

  /** Nest the row under its previous sibling; keeps the current mode/focus
   * (and, when editing, the caret position) — on the row's new key. The row
   * it goes under is revealed: a leaf that has just become a parent sits at
   * whatever level it sits at, and from the depth rule's second level down
   * that rule would fold it the moment it gains a child — hiding the row
   * just indented, mid-edit. Nesting something under a row is asking to see
   * it, so the open is recorded as the reader's own. */
  indent: (input) => {
    const { doc } = input
    // Consume the key even when it can't indent (no previous sibling), so Tab
    // never escapes the editor. A range moves as one, or not at all
    // (`movesOf`).
    if (!movesOf(input).canIndent) return { handled: true, focus: keepSelection(input) }
    let next = doc
    const moved: [string, string][] = []
    const reveal: string[] = []
    // In document order: each row's new previous sibling is the one the group
    // is nesting under, so a contiguous sibling range nests together.
    for (const key of rootsOf(input)) {
      const result = indentBlock(next, key)
      if (result.doc === next) continue
      moved.push([key, result.key])
      const parent = parentKeyOf(result.key)
      if (parent !== null && !reveal.includes(parent)) reveal.push(parent)
      next = result.doc
    }
    if (next === doc) return { handled: true, focus: keepSelection(input) }
    return {
      handled: true,
      doc: next,
      op: STRUCTURAL,
      reveal,
      focus: keepSelection(input, moved),
    }
  },

  /** Lift the rows out to become siblings of their parents — whichever of
   * them can be lifted. */
  outdent: (input) => {
    const { doc, focusRootId } = input
    let next = doc
    const moved: [string, string][] = []
    // Reverse order keeps siblings in place as each is lifted out. Focus
    // boundary: outdenting a direct child of the focus root (which would
    // become the root's sibling and leave the view) is a no-op — as is
    // outdenting the focus root itself, where it leads the view as a row.
    for (const key of [...rootsOf(input)].reverse()) {
      if (
        parentIsFocusRoot(parentKeyOf(key), focusRootId) ||
        (focusRootId && idOfKey(key) === focusRootId)
      ) {
        continue
      }
      const result = outdentBlock(next, key)
      if (result.doc === next) continue
      moved.push([key, result.key])
      next = result.doc
    }
    if (next === doc) return { handled: true, focus: keepSelection(input) }
    return { handled: true, doc: next, op: STRUCTURAL, focus: keepSelection(input, moved) }
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
   * on the first child of the focused view it steps up to the title. */
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
    // child of the focus root lands on the title (its parent), above the rows.
    if (info.parentKey === null) return { handled: true }
    if (parentIsFocusTitle(info.parentKey, input)) return EXIT_TOP
    return { handled: true, focus: keepFocus(mode, info.parentKey) }
  },

  /** s: next sibling — or, at the LAST sibling of a level, walk up the
   * ancestor chain until an ancestor has a next sibling and select it
   * (continue the traversal one level out, downward). At the end of the
   * document — or of the focused subtree, which the walk never escapes — no-op. */
  treeNext: (input) => {
    const { doc, key, mode, focusRootId } = input
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
      // Last sibling: climb — but never past the focus root or the document.
      if (info.parentKey === null) return { handled: true }
      if (focusRootId && info.parentId === focusRootId) return { handled: true }
      cur = info.parentKey
    }
  },

  /** Step up the tree: select the parent (no-op on a root-level row). While
   * in focus the title *is* the local root: "up" from one of its children goes
   * to the title, above the rows. */
  selectParent: (input) => {
    const { key, mode } = input
    const parentKey = parentKeyOf(key)
    if (parentKey === null) return { handled: true }
    if (parentIsFocusTitle(parentKey, input)) return EXIT_TOP
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
    // Collapsed: open it and stay put — the second press steps in. (The focused
    // title is always open on screen, so it steps straight into its children.)
    if (!visibleOrder.includes(firstKey)) return { handled: true, expand: key }
    return { handled: true, focus: keepFocus(mode, firstKey) }
  },

  /** ←: collapse an expanded row (staying on it); collapsed or leaf → step
   * out to the parent. Root-level collapsed/leaf: no-op. In focus, a direct
   * child's "parent" is the title above the rows, so the fold walk never
   * escapes the focused subtree. */
  collapseOrParent: (input) => {
    const { key, mode, visibleOrder } = input
    const first = keysBeneath(input)[0]
    if (first && visibleOrder.includes(first)) return { handled: true, collapse: key }
    const parentKey = parentKeyOf(key)
    if (parentKey === null) return { handled: true }
    if (parentIsFocusTitle(parentKey, input)) return EXIT_TOP
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
    if (parentIsFocusTitle(info.parentKey, input)) return EXIT_TOP
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

  /** Reorder the rows among their siblings (subtrees come along). Preserves
   * the caret when editing so the cursor rides along with the moved block. */
  moveBlockUp: moveGroup("up"),
  moveBlockDown: moveGroup("down"),

  /** Duplicate the rows (and their subtrees) above / below themselves. */
  duplicateAbove: duplicate("above"),
  duplicateBelow: duplicate("below"),

  /** Remove the highlighted rows and their subtrees. The selection lands on
   * the visible row that takes the removed ones' place — the one that
   * slides up from below — falling back to the row above when the removed
   * rows were last. */
  deleteBlock: (input) => {
    const { doc, visibleOrder, focusRootId, focusTitled } = input
    const roots = rootsOf(input)
    // The focused view's own root, where it leads the view as a row: removing
    // it from inside would take the view with it — a range that happens to
    // include it passes it by; on its own, say so rather than doing nothing,
    // since the row looks removable like any other.
    const removable = roots.filter((key) => !(focusRootId && idOfKey(key) === focusRootId))
    if (removable.length === 0) {
      return { handled: true, notice: "Leave focus to remove the block you're focused on" }
    }
    // A note keeps a block to type in: its one and only leaf stays.
    const onlyId = doc.rootBlockIds.length === 1 ? doc.rootBlockIds[0] : null
    const onlyBlock =
      onlyId !== null &&
      (doc.blocks[onlyId]?.children.length ?? 0) === 0 &&
      removable.some((key) => idOfKey(key) === onlyId)
    if (onlyBlock && !input.emptyable) return { handled: true }
    let next = doc
    for (const key of removable) {
      if (hasOccurrence(next, key)) next = removeBlock(next, key).doc
    }
    if (next === doc) return { handled: true }
    // Walk the pre-delete visible order outward from the removed rows: first
    // below the last of them (skipping their own removed subtrees via the
    // survives-in-next check), then above the first.
    const indices = input.keys.map((key) => visibleOrder.indexOf(key)).filter((i) => i !== -1)
    const lo = indices.length > 0 ? Math.min(...indices) : 0
    const hi = indices.length > 0 ? Math.max(...indices) : -1
    let focusKey: string | null = null
    for (let i = hi + 1; i < visibleOrder.length && !focusKey; i++) {
      if (hasOccurrence(next, visibleOrder[i])) focusKey = visibleOrder[i]
    }
    for (let i = lo - 1; i >= 0 && !focusKey; i--) {
      if (hasOccurrence(next, visibleOrder[i])) focusKey = visibleOrder[i]
    }
    // The focused view emptied: the title above the rows takes the keyboard
    // (the focused block alone is a valid view — Enter on it makes a child).
    // Untitled there is no title to hand it to: the root row is still there,
    // and the fallback below lands on it.
    if (!focusKey && focusRootId && focusTitled !== false) {
      return { handled: true, doc: next, op: STRUCTURAL, exitTop: true }
    }
    const landing = focusKey ?? next.rootBlockIds[0] ?? null
    // Run while editing (the touch screen's edit bar), the edit carries on
    // in the row that takes the deleted one's place — the keyboard stays up
    // for the next delete — rather than dropping to a highlight.
    const focus: FocusIntent =
      landing !== null && input.mode === "edit"
        ? { mode: "edit", key: landing }
        : { mode: "select", key: landing }
    return { handled: true, doc: next, op: STRUCTURAL, focus }
  },

  /** Toggle a todo's checkbox from select mode (no-op on other blocks):
   * checked is a TYPE, so this is `todo` ↔ `done`. Over a range, every
   * todo in it flips; the rest are left alone. */
  toggleTodo: (input) => {
    const { doc } = input
    const todos = [...new Set(rootsOf(input).map(idOfKey))].filter((id) => {
      const type = doc.blocks[id]?.type
      return type === "todo" || type === "done"
    })
    if (todos.length === 0) return IGNORED
    let next = doc
    for (const id of todos) {
      next = updateType(next, id, next.blocks[id].type === "todo" ? "done" : "todo")
    }
    return {
      handled: true,
      doc: next,
      op: { type: "text", blockId: todos[0] },
      focus: keepSelection(input),
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
  /** A menu's "turn into": the rows become `blockType` outright (a pick of
   * Heading over a heading is still a heading). Unbound: the selection bar
   * and the edit bar run it with the type they were given. */
  turnInto: (input) =>
    input.blockType === undefined ? IGNORED : retype(input, input.blockType, false),

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
    const { doc, key, focusRootId, focusTitled } = input
    const id = idOfKey(key)
    if (doc.rootBlockIds.length === 1 && doc.rootBlockIds[0] === id && !input.emptyable) {
      return { handled: true }
    }
    const { doc: next, focusKey } = removeBlock(doc, key)
    // Merging upward out of the focused view lands on its title. Untitled the
    // root is a row, so the merge lands on it like any other parent.
    if (focusTitled !== false && focusRootId && (!focusKey || idOfKey(focusKey) === focusRootId)) {
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

  // ── Focus mode ───────────────────────────────────────────────────────────
  // Commands only *request* the change of focus root; the editor navigates
  // (the focus lives in the URL) and then places the selection — the focused
  // block itself, or its first child under a title, on the way in; the block
  // left behind on the way out.

  /** Focus on the row's block: its subtree becomes the whole view. */
  focusBlock: (input) => ({ handled: true, focusRoot: { id: idOfKey(input.key) } }),

  /** Step back one level — to the focus root's parent, or fully at the top. */
  focusBack: ({ focusRootId, focusBackId }) => {
    if (!focusRootId) return IGNORED
    return { handled: true, focusRoot: { id: focusBackId ?? null } }
  },

  /** Leave focus entirely, back to the whole note. */
  leaveFocus: ({ focusRootId }) =>
    focusRootId ? { handled: true, focusRoot: { id: null } } : IGNORED,
}

/** Run a named command. Unknown names are a no-op (defensive). */
/**
 * The commands a **browse** view runs — a read-only editor the reader still
 * moves through (the Views page, a search's results): everything that moves
 * the highlight, folds a row or focuses, and nothing that writes. Enter is
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
  "focusBlock",
  "focusBack",
  "leaveFocus",
])

export function runCommand(name: CommandName, input: CommandInput): CommandResult {
  const command = COMMANDS[name]
  return command ? command(input) : IGNORED
}
