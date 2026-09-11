import type { BlockOp } from "./history"
import { DEFAULT_NEW_BLOCK_TYPE, isHeading, toggleType } from "./markers"
import { defOf } from "./registry"
import {
  duplicateBlocks,
  emptyBlock,
  indentBlock,
  insertAfter,
  insertFirstChild,
  moveBlock,
  outdentBlock,
  removeBlock,
  siblingsOf,
  updateBlock,
  updateText,
  updateType,
} from "./ops"
import type { BlockDoc, BlockType } from "./types"
import { ancestorKeys, hasOccurrence, idOfKey, keyOf, parentKeyOf } from "./view"

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
  /** The block the editor is zoomed into ("focus mode"), or null/absent. While
   * zoomed, the visible world is this block (rendered as a title) plus its
   * subtree — commands must not move, delete, or navigate past that boundary. */
  zoomRootId?: string | null
  /** Where zooming out one level returns to: the previous entry in the zoom
   * navigation stack — the path the user actually took, which under the graph
   * model (multi-parent blocks) is the only honest "up". Null/absent when
   * nothing is below on the stack; zoom-out then exits zoom entirely. */
  zoomBackId?: string | null
  /**
   * The type a fresh block starts as when Enter creates one from a block that
   * isn't a todo or ordered item (those continue their own list). A user
   * preference — `ul` by default, `text` for a plain paragraph, or any other
   * type (`todo`, `quote`). Absent = the default.
   */
  newBlockType?: BlockType
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
  /** Navigation tried to move above the first block — the caller may hand focus
   * to whatever sits above the editor (e.g. the note title). */
  exitTop?: boolean
  /** Requested zoom change: `{ id: null }` exits zoom, `{ id }` zooms into a
   * block. Absent = no change. The editor navigates (URL state) accordingly. */
  zoom?: { id: string | null }
}

type Command = (input: CommandInput) => CommandResult

const IGNORED: CommandResult = { handled: false }
const STRUCTURAL: BlockOp = { type: "structural" }

/** The block a row shows. */
const blockOf = ({ doc, key }: CommandInput) => doc.blocks[idOfKey(key)]

/** Is the row the zoomed view's title? (The zoom root never recurs beneath
 * itself — the walk never re-enters a block on its own path.) */
const isZoomTitle = ({ key, zoomRootId }: CommandInput) =>
  !!zoomRootId && idOfKey(key) === zoomRootId

/**
 * The type a new sibling block should take. Todo / ordered lists continue
 * their own type; everything else (paragraph, heading, quote, bullet) starts
 * as the user's configured new-block type — an unordered list item by
 * default.
 */
function continuationType(type: BlockType, input: CommandInput): BlockType {
  return defOf(type).continues ?? input.newBlockType ?? DEFAULT_NEW_BLOCK_TYPE
}

/** The type for a new block of the *same* type as `type` — used by Shift-Enter
 * so a heading splits into a heading, a quote into a quote, and so on. A
 * checked todo continues as an unchecked one; a page never continues. */
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
  return ({ key, visibleOrder, zoomRootId }) => {
    const i = visibleOrder.indexOf(key)
    if (i === -1) {
      // The selected row is hidden inside a collapsed parent — arrows would
      // otherwise be dead. Recover onto the nearest visible ancestor.
      const ancestor = nearestVisibleAncestor(key, visibleOrder)
      const target = ancestor ?? visibleOrder[0] ?? null
      return { handled: true, focus: { mode: "select", key: target } }
    }
    const next = direction === "up" ? i - 1 : i + 1
    // Moving up past the first block hands focus to whatever's above the editor
    // — except while zoomed, where the note title isn't the context: swallow.
    if (next < 0) return zoomRootId ? { handled: true } : { handled: true, exitTop: true }
    // Consume the key at the bottom too, so the page never scrolls instead.
    if (next >= visibleOrder.length) return { handled: true }
    return { handled: true, focus: { mode: "select", key: visibleOrder[next] } }
  }
}

/** Move the highlight (or edit focus) to the previous / next sibling, skipping
 * whatever is nested between them. */
function siblingJump(direction: "prev" | "next"): Command {
  return (input) => {
    const { doc, key, mode } = input
    // The zoom root's siblings live outside the zoomed view — don't jump there.
    if (isZoomTitle(input)) return { handled: true }
    const info = siblingsOf(doc, key)
    if (!info) return { handled: true }
    const target = direction === "prev" ? info.index - 1 : info.index + 1
    if (target < 0 || target >= info.siblings.length) return { handled: true }
    return { handled: true, focus: keepFocus(mode, keyOf(info.parentKey, info.siblings[target])) }
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
  return ({ key, visibleOrder, zoomRootId }) => {
    const i = visibleOrder.indexOf(key)
    if (direction === "up") {
      if (i > 0) return { handled: true, focus: { mode: "select", key: visibleOrder[i - 1] } }
      // At the very top: hand focus to the note title — unless zoomed, where
      // the title isn't the context; just commit the edit and stay put.
      if (zoomRootId) return { handled: true, focus: { mode: "select", key } }
      return { handled: true, exitTop: true }
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
    const updated = updateText(doc, id, before)
    const fresh = emptyBlock(typeFor(type, input), after)
    // Splitting the zoomed title makes the tail its FIRST child (title + body
    // metaphor) — a sibling would fall outside the zoomed view.
    const [next, freshKey] = isZoomTitle(input)
      ? [insertFirstChild(updated, id, fresh), keyOf(key, fresh.id)]
      : [insertAfter(updated, key, fresh), keyOf(parentKeyOf(key), fresh.id)]
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
    // Can't duplicate the zoom root while inside it — the copy would be an
    // invisible sibling outside the view (Dynalist's rule).
    if (isZoomTitle(input)) return { handled: true }
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
   * (and, when editing, the caret position) — on the row's new key. */
  indent: (input) => {
    const { doc, key, mode, caret } = input
    // The zoom root would nest under an invisible sibling — refuse.
    if (isZoomTitle(input)) return { handled: true, focus: keepFocus(mode, key, caret) }
    const next = indentBlock(doc, key)
    // Consume the key even when it can't indent (no previous sibling), so Tab
    // never escapes the editor.
    if (next.doc === doc) return { handled: true, focus: keepFocus(mode, key, caret) }
    return { handled: true, doc: next.doc, op: STRUCTURAL, focus: keepFocus(mode, next.key, caret) }
  },

  /** Lift the row out to become a sibling of its parent. */
  outdent: (input) => {
    const { doc, key, mode, caret, zoomRootId } = input
    // Zoom boundary: outdenting the zoom root itself, or a direct child (which
    // would become the root's sibling and leave the view), is a no-op.
    const parentKey = parentKeyOf(key)
    if (
      isZoomTitle(input) ||
      (zoomRootId && parentKey !== null && idOfKey(parentKey) === zoomRootId)
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
   * on the zoomed title it no-ops too (zooming out stays `a`'s job). */
  treePrev: (input) => {
    const { doc, key, mode } = input
    if (isZoomTitle(input)) return { handled: true }
    const info = siblingsOf(doc, key)
    if (!info) return { handled: true }
    if (info.index > 0) {
      return {
        handled: true,
        focus: keepFocus(mode, keyOf(info.parentKey, info.siblings[info.index - 1])),
      }
    }
    // Top of the level: continue the traversal one level out, upward. A direct
    // child of the zoom root lands on the title (its parent) — still in view.
    if (info.parentKey === null) return { handled: true }
    return { handled: true, focus: keepFocus(mode, info.parentKey) }
  },

  /** s: next sibling — or, at the LAST sibling of a level, walk up the
   * ancestor chain until an ancestor has a next sibling and select it
   * (continue the traversal one level out, downward). At the end of the
   * document — or of the zoomed subtree, which the walk never escapes — no-op. */
  treeNext: (input) => {
    const { doc, key, mode, zoomRootId } = input
    // The title's own siblings live outside the zoomed view.
    if (isZoomTitle(input)) return { handled: true }
    let cur = key
    for (;;) {
      const info = siblingsOf(doc, cur)
      if (!info) return { handled: true }
      if (info.index < info.siblings.length - 1) {
        return {
          handled: true,
          focus: keepFocus(mode, keyOf(info.parentKey, info.siblings[info.index + 1])),
        }
      }
      // Last sibling: climb — but never past the zoom root or the document.
      if (info.parentKey === null) return { handled: true }
      if (zoomRootId && info.parentId === zoomRootId) return { handled: true }
      cur = info.parentKey
    }
  },

  /** Step up the tree: select the parent (no-op on a root-level row). While
   * zoomed the title *is* the local root, so "up" from it crosses the zoom
   * boundary — reuse `zoomOut` so "a always goes up the tree" keeps holding. */
  selectParent: (input) => {
    const { key, mode } = input
    if (isZoomTitle(input)) return COMMANDS.zoomOut(input)
    const parentKey = parentKeyOf(key)
    if (parentKey === null) return { handled: true }
    return { handled: true, focus: keepFocus(mode, parentKey) }
  },

  /** Step down the tree: select the first child (no-op on a leaf). A collapsed
   * row auto-expands in the same keypress — the `expand` demand tells the
   * editor to clear its fold so the child is actually visible. */
  selectFirstChild: (input) => {
    const { key, mode } = input
    const first = blockOf(input)?.children[0]
    if (!first) return { handled: true }
    return { handled: true, expand: key, focus: keepFocus(mode, keyOf(key, first)) }
  },

  // ── Arrow-key folding (the tree-view convention: ←/→ fold before they
  // move). Commands can't see collapse state, but `visibleOrder` betrays it:
  // a row with children is collapsed exactly when its first child's row was
  // skipped from the on-screen order. ──────────────────────────────────────

  /** →: expand a collapsed row (staying on it); already expanded → step into
   * the first child (like `d`, minus the auto-expand). Leaf: no-op. */
  expandOrFirstChild: (input) => {
    const { key, mode, visibleOrder } = input
    const first = blockOf(input)?.children[0]
    if (!first) return { handled: true }
    // Collapsed: open it and stay put — the second press steps in. (The zoomed
    // title is always open on screen, so it steps straight into its children.)
    const firstKey = keyOf(key, first)
    if (!visibleOrder.includes(firstKey)) return { handled: true, expand: key }
    return { handled: true, focus: keepFocus(mode, firstKey) }
  },

  /** ←: collapse an expanded row (staying on it); collapsed or leaf → step
   * out to the parent. Root-level collapsed/leaf: no-op. On the zoomed title
   * it's a no-op — the title is pinned open and zoom-out stays `a`'s job — and
   * a direct child's "parent" is the title itself, so the fold walk never
   * escapes the zoomed subtree. */
  collapseOrParent: (input) => {
    const { key, mode, visibleOrder } = input
    if (isZoomTitle(input)) return { handled: true }
    const first = blockOf(input)?.children[0]
    if (first && visibleOrder.includes(keyOf(key, first))) return { handled: true, collapse: key }
    const parentKey = parentKeyOf(key)
    if (parentKey === null) return { handled: true }
    return { handled: true, focus: keepFocus(mode, parentKey) }
  },

  /** Jump to the top of the current level (its first sibling); if already there,
   * step up to the parent. Walks up levels rather than to the page top. */
  jumpLevelTop: (input) => {
    const { doc, key, mode } = input
    // The zoom root's own level lives outside the zoomed view — clamp there.
    if (isZoomTitle(input)) return { handled: true }
    const info = siblingsOf(doc, key)
    if (!info) return { handled: true }
    if (info.index > 0) {
      return { handled: true, focus: keepFocus(mode, keyOf(info.parentKey, info.siblings[0])) }
    }
    if (info.parentKey !== null) return { handled: true, focus: keepFocus(mode, info.parentKey) }
    return { handled: true }
  },
  /** Jump to the bottom of the current level (its last sibling). */
  jumpLevelBottom: (input) => {
    const { doc, key, mode } = input
    if (isZoomTitle(input)) return { handled: true }
    const info = siblingsOf(doc, key)
    if (!info || info.index >= info.siblings.length - 1) return { handled: true }
    const last = info.siblings[info.siblings.length - 1]
    return { handled: true, focus: keepFocus(mode, keyOf(info.parentKey, last)) }
  },

  /** Reorder the row among its siblings (subtree comes along). Preserves the
   * caret when editing so the cursor rides along with the moved block. */
  moveBlockUp: (input) => {
    const { doc, key, mode, caret } = input
    // Can't move the zoom root among its (invisible) siblings from inside it.
    if (isZoomTitle(input)) return { handled: true }
    const next = moveBlock(doc, key, "up")
    if (next === doc) return { handled: true }
    return { handled: true, doc: next, op: STRUCTURAL, focus: keepFocus(mode, key, caret) }
  },
  moveBlockDown: (input) => {
    const { doc, key, mode, caret } = input
    if (isZoomTitle(input)) return { handled: true }
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
    const { doc, key, visibleOrder } = input
    // Never delete the block being zoomed into — the view must keep its title.
    // (Deleting the last child inside a zoom is fine: the title remains.)
    if (isZoomTitle(input)) return { handled: true }
    const id = idOfKey(key)
    const onlyBlock =
      doc.rootBlockIds.length === 1 &&
      doc.rootBlockIds[0] === id &&
      (doc.blocks[id]?.children.length ?? 0) === 0
    if (onlyBlock) return { handled: true }
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

  /** Select-mode marker keys: toggle the block's type (see `turnInto`). */
  turnIntoHeading: turnInto("h1"),
  turnIntoBullet: turnInto("ul"),
  turnIntoTodo: turnInto("todo"),
  turnIntoQuote: turnInto("quote"),
  turnIntoOrdered: turnInto("ol"),

  /**
   * The fence shortcut: Enter on a block whose whole text is three backticks
   * and an optional language (```` ```js ````) turns it into an empty code
   * block of that language, editing. The keymap guards the shape
   * (`isFenceOpener`); the language is whatever followed the backticks.
   */
  turnIntoCode: ({ doc, key, caret }) => {
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
    // The zoomed title's children are the whole view — collapsing it would
    // blank the page, so it's pinned open while zoomed.
    if (isZoomTitle(input)) return { handled: true }
    const hasChildren = (blockOf(input)?.children.length ?? 0) > 0
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
    // On the zoomed title, "below" means the top of its body — the first child
    // (a sibling would land outside the view).
    if (isZoomTitle(input)) {
      const next = insertFirstChild(doc, id, fresh)
      return {
        handled: true,
        doc: next,
        op: STRUCTURAL,
        focus: { mode: "edit", key: keyOf(key, fresh.id) },
      }
    }
    let next = insertAfter(doc, key, fresh)
    let freshKey = keyOf(parentKeyOf(key), fresh.id)
    if (isHeading(type)) ({ doc: next, key: freshKey } = indentBlock(next, freshKey))
    return { handled: true, doc: next, op: STRUCTURAL, focus: { mode: "edit", key: freshKey } }
  },

  /** New sibling block below, of the *same* type (Cmd/Shift+Enter). Unlike
   * `insertBelow` a heading stays a heading and doesn't nest. */
  insertSiblingBelow: (input) => {
    const { doc, key } = input
    const id = idOfKey(key)
    const fresh = emptyBlock(sameType(doc.blocks[id]?.type ?? "text"))
    // On the zoomed title a "sibling" would leave the view — first child instead.
    const [next, freshKey] = isZoomTitle(input)
      ? [insertFirstChild(doc, id, fresh), keyOf(key, fresh.id)]
      : [insertAfter(doc, key, fresh), keyOf(parentKeyOf(key), fresh.id)]
    return { handled: true, doc: next, op: STRUCTURAL, focus: { mode: "edit", key: freshKey } }
  },

  splitContinuingList: splitAtCaret(continuationType),
  // Shift-Enter keeps the current block's type for the new block.
  splitPlain: splitAtCaret(sameType),

  /** Enter on an empty list item exits the list (becomes a paragraph). */
  exitList: ({ doc, key }) => {
    const id = idOfKey(key)
    return {
      handled: true,
      doc: updateType(updateText(doc, id, ""), id, "text"),
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
    const { doc, key } = input
    // The zoomed title can't delete itself out of its own view.
    if (isZoomTitle(input)) return { handled: true }
    const id = idOfKey(key)
    if (doc.rootBlockIds.length === 1 && doc.rootBlockIds[0] === id) return { handled: true }
    const { doc: next, focusKey } = removeBlock(doc, key)
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
  zoomIn: (input) =>
    isZoomTitle(input) ? { handled: true } : { handled: true, zoom: { id: idOfKey(input.key) } },

  /** Zoom out one level — to the zoom root's parent, or fully at the top. */
  zoomOut: ({ zoomRootId, zoomBackId }) => {
    if (!zoomRootId) return IGNORED
    return { handled: true, zoom: { id: zoomBackId ?? null } }
  },

  /** Exit zoom entirely, back to the whole note. */
  zoomExit: ({ zoomRootId }) => (zoomRootId ? { handled: true, zoom: { id: null } } : IGNORED),
}

/** Run a named command. Unknown names are a no-op (defensive). */
export function runCommand(name: CommandName, input: CommandInput): CommandResult {
  const command = COMMANDS[name]
  return command ? command(input) : IGNORED
}
