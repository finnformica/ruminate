import {
  getBlockType,
  stripMarker,
  toggleTodo as toggleTodoContent,
  type BlockType,
} from "./block-type"
import type { BlockOp } from "./history"
import {
  duplicateBlocks,
  emptyBlock,
  indentBlock,
  insertAfter,
  moveBlock,
  outdentBlock,
  removeBlock,
  siblingsOf,
  updateContent,
} from "./ops"
import type { BlockDoc } from "./types"

/**
 * The block editor's **command layer**: named, input-agnostic intents ("indent
 * this block", "delete this block", "split at the caret") expressed as pure
 * functions over the document.
 *
 * This is the seam every entry point calls into — the keyboard today (via the
 * keymap in `keymap.ts`), and touch gestures or a block menu tomorrow. A swipe
 * that indents a block dispatches the same `indent` command a Tab press does, so
 * the behaviour is defined once and never duplicated per input method.
 *
 * Commands are **pure**: they take the current doc plus a little UI context and
 * return a `CommandResult` describing what should change (a new doc, where focus
 * should land, whether a block's collapse toggles). The editor component owns
 * the actual state and applies the result — commands never touch React or the
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
  id: string
  mode: Mode
  /** On-screen order of visible block ids (collapsed children skipped). */
  visibleOrder: string[]
  /** Present in edit mode; absent in select mode. */
  caret?: CaretInput
}

/** Where selection / edit focus should land after a command runs. */
export type FocusIntent =
  | { mode: "select"; id: string | null }
  | { mode: "edit"; id: string; atStart?: boolean; caret?: number }

export interface CommandResult {
  /** Whether the command consumed the gesture (the caller preventDefaults). */
  handled: boolean
  /** New document, when structure or content changed. */
  doc?: BlockDoc
  /** History op describing the change (defaults to structural when `doc` set). */
  op?: BlockOp
  /** Requested focus / selection change. */
  focus?: FocusIntent
  /** Id whose collapse state should toggle. */
  toggleCollapse?: string
  /** Navigation tried to move above the first block — the caller may hand focus
   * to whatever sits above the editor (e.g. the note title). */
  exitTop?: boolean
}

type Command = (input: CommandInput) => CommandResult

const IGNORED: CommandResult = { handled: false }
const STRUCTURAL: BlockOp = { type: "structural" }

/** The block's own leading marker (`# `, `- `, `[ ] `, `> `, `1. `), or "". */
function markerPrefix(content: string): string {
  return content.slice(0, content.length - stripMarker(content).length)
}

/**
 * The marker a new sibling block should carry. Todo / ordered lists continue
 * their own type; everything else (paragraph, heading, quote, bullet) starts a
 * fresh unordered list item by default.
 */
function continuationMarker(type: BlockType): string {
  switch (type.kind) {
    case "todo":
      return "[ ] "
    case "ordered":
      return `${type.number + 1}. `
    default:
      return "- "
  }
}

/** The marker for a new block of the *same* type as `type` — used by Shift-Enter
 * so a heading splits into a heading, a quote into a quote, and so on. */
function sameTypeMarker(type: BlockType): string {
  switch (type.kind) {
    case "heading":
      return "# "
    case "todo":
      return "[ ] "
    case "ordered":
      return `${type.number + 1}. `
    case "quote":
      return "> "
    case "bullet":
      return "- "
    default:
      return ""
  }
}

/**
 * Keep the current block focused, in whichever mode we're already in. When a
 * caret is passed (edit mode), preserve its position so an operation that only
 * reshapes the tree — indent, outdent, reorder — doesn't fling the cursor to the
 * end of the block.
 */
function keepFocus(mode: Mode, id: string, caret?: CaretInput): FocusIntent {
  return mode === "edit" ? { mode: "edit", id, caret: caret?.start } : { mode: "select", id }
}

/** The nearest ancestor of `id` present in `visibleOrder`, or null. Used to
 * recover when the selected block is hidden inside a newly collapsed parent. */
function nearestVisibleAncestor(doc: BlockDoc, id: string, visibleOrder: string[]): string | null {
  let parent = siblingsOf(doc, id)?.parentId ?? null
  while (parent !== null && !visibleOrder.includes(parent)) {
    parent = siblingsOf(doc, parent)?.parentId ?? null
  }
  return parent
}

/** Move the highlight to the previous / next visible block (select mode). */
function moveSelection(direction: "up" | "down"): Command {
  return ({ doc, id, visibleOrder }) => {
    const i = visibleOrder.indexOf(id)
    if (i === -1) {
      // The selected block is hidden inside a collapsed parent — arrows would
      // otherwise be dead. Recover onto the nearest visible ancestor.
      const ancestor = nearestVisibleAncestor(doc, id, visibleOrder)
      const target = ancestor ?? visibleOrder[0] ?? null
      return { handled: true, focus: { mode: "select", id: target } }
    }
    const next = direction === "up" ? i - 1 : i + 1
    // Moving up past the first block hands focus to whatever's above the editor.
    if (next < 0) return { handled: true, exitTop: true }
    // Consume the key at the bottom too, so the page never scrolls instead.
    if (next >= visibleOrder.length) return { handled: true }
    return { handled: true, focus: { mode: "select", id: visibleOrder[next] } }
  }
}

/** Move the highlight (or edit focus) to the previous / next sibling, skipping
 * whatever is nested between them. */
function siblingJump(direction: "prev" | "next"): Command {
  return ({ doc, id, mode }) => {
    const info = siblingsOf(doc, id)
    if (!info) return { handled: true }
    const target = direction === "prev" ? info.index - 1 : info.index + 1
    if (target < 0 || target >= info.siblings.length) return { handled: true }
    return { handled: true, focus: keepFocus(mode, info.siblings[target]) }
  }
}

/**
 * An arrow leaving the edited block *commits* the edit: it exits edit mode and
 * highlights the adjacent block (select mode), rather than walking into the
 * neighbour still editing. At the very first block it hands focus upward
 * (`exitTop`, e.g. to the note title); at the very last it exits in place,
 * highlighting the block that was being edited.
 */
function moveEditFocus(direction: "up" | "down"): Command {
  return ({ id, visibleOrder }) => {
    const i = visibleOrder.indexOf(id)
    if (direction === "up") {
      if (i > 0) return { handled: true, focus: { mode: "select", id: visibleOrder[i - 1] } }
      return { handled: true, exitTop: true }
    }
    if (i >= 0 && i < visibleOrder.length - 1) {
      return { handled: true, focus: { mode: "select", id: visibleOrder[i + 1] } }
    }
    return { handled: true, focus: { mode: "select", id } }
  }
}

/** Split the block at the caret; `markerFor` decides the new block's marker —
 * a list continuation for Enter, the same type for Shift-Enter. */
function splitAtCaret(markerFor: (type: BlockType) => string): Command {
  return ({ doc, id, caret }) => {
    if (!caret) return IGNORED
    const content = doc.blocks[id]?.content ?? ""
    const type = getBlockType(content)
    const prefix = markerPrefix(content)
    const before = caret.value.slice(0, caret.start)
    const after = caret.value.slice(caret.end)
    const updated = updateContent(doc, id, prefix + before)
    const fresh = emptyBlock(markerFor(type) + after)
    const next = insertAfter(updated, id, fresh)
    return {
      handled: true,
      doc: next,
      op: STRUCTURAL,
      focus: { mode: "edit", id: fresh.id, atStart: true },
    }
  }
}

/** Duplicate the block's subtree; focus follows the copy (VS Code semantics:
 * duplicate-down lands on the lower copy, duplicate-up on the upper). In edit
 * mode the copy opens editing with the caret preserved ("duplicate line"). */
function duplicate(direction: "above" | "below"): Command {
  return ({ doc, id, mode, caret }) => {
    const result = duplicateBlocks(doc, [id], direction)
    if (!result) return { handled: true }
    return {
      handled: true,
      doc: result.doc,
      op: STRUCTURAL,
      focus: keepFocus(mode, result.copies[0], caret),
    }
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
  | "jumpLevelTop"
  | "jumpLevelBottom"
  | "moveBlockUp"
  | "moveBlockDown"
  | "duplicateAbove"
  | "duplicateBelow"
  | "deleteBlock"
  | "toggleTodo"
  | "toggleCollapse"
  | "insertBelow"
  | "insertSiblingBelow"
  | "splitContinuingList"
  | "splitPlain"
  | "exitList"
  | "stripMarker"
  | "backspaceEmpty"

export const COMMANDS: Record<CommandName, Command> = {
  /** Select → edit the highlighted block. */
  enterEdit: ({ id }) => ({ handled: true, focus: { mode: "edit", id } }),

  /** Edit → back to highlighting the block. */
  exitEdit: ({ id }) => ({ handled: true, focus: { mode: "select", id } }),

  /** Select → nothing focused (Escape's last rung). Arrows re-select. */
  deselect: () => ({ handled: true, focus: { mode: "select", id: null } }),

  /** Nest the block under its previous sibling; keeps the current mode/focus
   * (and, when editing, the caret position). */
  indent: ({ doc, id, mode, caret }) => {
    const next = indentBlock(doc, id)
    // Consume the key even when it can't indent (no previous sibling), so Tab
    // never escapes the editor.
    if (next === doc) return { handled: true, focus: keepFocus(mode, id, caret) }
    return { handled: true, doc: next, op: STRUCTURAL, focus: keepFocus(mode, id, caret) }
  },

  /** Lift the block out to become a sibling of its parent. */
  outdent: ({ doc, id, mode, caret }) => {
    const next = outdentBlock(doc, id)
    if (next === doc) return { handled: true, focus: keepFocus(mode, id, caret) }
    return { handled: true, doc: next, op: STRUCTURAL, focus: keepFocus(mode, id, caret) }
  },

  moveSelectionUp: moveSelection("up"),
  moveSelectionDown: moveSelection("down"),
  moveEditFocusUp: moveEditFocus("up"),
  moveEditFocusDown: moveEditFocus("down"),

  /** Move to the previous / next sibling at the same level, skipping any
   * descendants in between (e.g. jump header→header across their children). */
  prevSibling: siblingJump("prev"),
  nextSibling: siblingJump("next"),

  /** Jump to the top of the current level (its first sibling); if already there,
   * step up to the parent. Walks up levels rather than to the page top. */
  jumpLevelTop: ({ doc, id, mode }) => {
    const info = siblingsOf(doc, id)
    if (!info) return { handled: true }
    if (info.index > 0) return { handled: true, focus: keepFocus(mode, info.siblings[0]) }
    if (info.parentId) return { handled: true, focus: keepFocus(mode, info.parentId) }
    return { handled: true }
  },
  /** Jump to the bottom of the current level (its last sibling). */
  jumpLevelBottom: ({ doc, id, mode }) => {
    const info = siblingsOf(doc, id)
    if (!info || info.index >= info.siblings.length - 1) return { handled: true }
    return { handled: true, focus: keepFocus(mode, info.siblings[info.siblings.length - 1]) }
  },

  /** Reorder the block among its siblings (subtree comes along). Preserves the
   * caret when editing so the cursor rides along with the moved block. */
  moveBlockUp: ({ doc, id, mode, caret }) => {
    const next = moveBlock(doc, id, "up")
    if (next === doc) return { handled: true }
    return { handled: true, doc: next, op: STRUCTURAL, focus: keepFocus(mode, id, caret) }
  },
  moveBlockDown: ({ doc, id, mode, caret }) => {
    const next = moveBlock(doc, id, "down")
    if (next === doc) return { handled: true }
    return { handled: true, doc: next, op: STRUCTURAL, focus: keepFocus(mode, id, caret) }
  },

  /** Duplicate the block (and its subtree) above / below itself. */
  duplicateAbove: duplicate("above"),
  duplicateBelow: duplicate("below"),

  /** Delete the highlighted block and its subtree (select mode). */
  deleteBlock: ({ doc, id }) => {
    const onlyBlock =
      doc.rootBlockIds.length === 1 &&
      doc.rootBlockIds[0] === id &&
      (doc.blocks[id]?.children.length ?? 0) === 0
    if (onlyBlock) return { handled: true }
    const { doc: next, focusId } = removeBlock(doc, id)
    return {
      handled: true,
      doc: next,
      op: STRUCTURAL,
      focus: { mode: "select", id: focusId ?? next.rootBlockIds[0] ?? null },
    }
  },

  /** Toggle a todo's checkbox from select mode (no-op on other blocks). */
  toggleTodo: ({ doc, id, mode }) => {
    const content = doc.blocks[id]?.content ?? ""
    if (getBlockType(content).kind !== "todo") return IGNORED
    return {
      handled: true,
      doc: updateContent(doc, id, toggleTodoContent(content)),
      op: { type: "text", blockId: id },
      focus: keepFocus(mode, id),
    }
  },

  /** Collapse / expand a block with children; consumes Space regardless (so the
   * page never scrolls) but only toggles when there's something to fold. */
  toggleCollapse: ({ doc, id }) => {
    const hasChildren = (doc.blocks[id]?.children.length ?? 0) > 0
    if (!hasChildren) return { handled: true }
    return { handled: true, toggleCollapse: id }
  },

  /** Enter at end of line: a fresh continuation block below. Enter from a
   * heading nests the new block under it, like an outline section. */
  insertBelow: ({ doc, id }) => {
    const content = doc.blocks[id]?.content ?? ""
    const type = getBlockType(content)
    const fresh = emptyBlock(continuationMarker(type))
    let next = insertAfter(doc, id, fresh)
    if (type.kind === "heading") next = indentBlock(next, fresh.id)
    return { handled: true, doc: next, op: STRUCTURAL, focus: { mode: "edit", id: fresh.id } }
  },

  /** New sibling block below, of the *same* type (Cmd/Shift+Enter). Unlike
   * `insertBelow` a heading stays a heading and doesn't nest. */
  insertSiblingBelow: ({ doc, id }) => {
    const content = doc.blocks[id]?.content ?? ""
    const fresh = emptyBlock(sameTypeMarker(getBlockType(content)))
    const next = insertAfter(doc, id, fresh)
    return { handled: true, doc: next, op: STRUCTURAL, focus: { mode: "edit", id: fresh.id } }
  },

  splitContinuingList: splitAtCaret(continuationMarker),
  // Shift-Enter keeps the current block's type for the new block.
  splitPlain: splitAtCaret(sameTypeMarker),

  /** Enter on an empty list item exits the list (becomes a paragraph). */
  exitList: ({ doc, id }) => ({
    handled: true,
    doc: updateContent(doc, id, ""),
    op: { type: "text", blockId: id },
    focus: { mode: "edit", id },
  }),

  /** Backspace at the start of a marked block strips its marker (→ paragraph). */
  stripMarker: ({ doc, id }) => {
    const content = doc.blocks[id]?.content ?? ""
    return {
      handled: true,
      doc: updateContent(doc, id, stripMarker(content)),
      op: { type: "text", blockId: id },
      focus: { mode: "edit", id, atStart: true },
    }
  },

  /** Backspace at the start of an empty block removes it, merging upward. */
  backspaceEmpty: ({ doc, id }) => {
    if (doc.rootBlockIds.length === 1 && doc.rootBlockIds[0] === id) return { handled: true }
    const { doc: next, focusId } = removeBlock(doc, id)
    return {
      handled: true,
      doc: next,
      op: STRUCTURAL,
      focus: focusId
        ? { mode: "edit", id: focusId }
        : { mode: "select", id: next.rootBlockIds[0] ?? null },
    }
  },
}

/** Run a named command. Unknown names are a no-op (defensive). */
export function runCommand(name: CommandName, input: CommandInput): CommandResult {
  const command = COMMANDS[name]
  return command ? command(input) : IGNORED
}
