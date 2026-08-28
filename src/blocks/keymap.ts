import { getBlockType, stripMarker } from "./block-type"
import type { CommandInput, CommandName, Mode } from "./commands"

/**
 * The block editor's **keymap**: a declarative table mapping a mode + key combo
 * (and, where it matters, the caret situation) to a command name. This table is
 * the human-readable spec of the editor's keyboard behaviour — greppable in one
 * place, unit-tested, and the thing that stops these personal conventions from
 * silently eroding over time.
 *
 * A future touch layer would sit beside this as a second table mapping gestures
 * (swipe-right → `indent`) to the same command names — no behaviour duplicated,
 * just a different set of bindings feeding the same command layer.
 *
 * Combos are normalised strings built by `comboFromEvent` — modifier order is
 * fixed (`Mod+Alt+Shift+Key`) so a binding string always matches. `Mod` is
 * Cmd/Ctrl. Some edit-mode keys (Enter, Backspace, arrows) depend on the caret,
 * so their bindings carry a `when` predicate; the resolver returns the first
 * binding whose combo *and* predicate match, letting several Enter behaviours
 * share the one key.
 */

type Predicate = (input: CommandInput) => boolean

interface Binding {
  mode: Mode
  combo: string
  command: CommandName
  /** Optional guard; when present the binding only applies if it returns true. */
  when?: Predicate
}

function contentOf(input: CommandInput): string {
  return input.doc.blocks[input.id]?.content ?? ""
}

const isEmptyListItem: Predicate = (input) => {
  const content = contentOf(input)
  const kind = getBlockType(content).kind
  const isList = kind === "bullet" || kind === "todo" || kind === "ordered"
  return isList && stripMarker(content).trim() === ""
}

const caretAtEnd: Predicate = ({ caret }) =>
  !!caret && caret.start === caret.end && caret.end === caret.value.length

const caretAtStart: Predicate = ({ caret }) => !!caret && caret.start === 0 && caret.end === 0

const hasMarker: Predicate = (input) => getBlockType(contentOf(input)).kind !== "paragraph"

const atStartWithMarker: Predicate = (input) => caretAtStart(input) && hasMarker(input)

/** Caret at the very start of an unmarked, empty block (Backspace merges up). */
const atStartEmpty: Predicate = (input) =>
  caretAtStart(input) && !hasMarker(input) && contentOf(input) === ""

const atFirstLine: Predicate = ({ caret }) => !!caret && caret.atFirstLine
const atLastLine: Predicate = ({ caret }) => !!caret && caret.atLastLine

/**
 * The binding table. Order matters only among bindings that share a mode+combo:
 * the first whose predicate passes wins (so the guarded Enter / Backspace
 * variants are listed before their unguarded fallback).
 */
export const KEYMAP: Binding[] = [
  // ── Select mode ────────────────────────────────────────────────────────
  { mode: "select", combo: "Enter", command: "enterEdit" },
  // Cmd/Ctrl+Enter (or Shift+Enter) inserts a same-type block below and edits it.
  { mode: "select", combo: "Mod+Enter", command: "insertSiblingBelow" },
  { mode: "select", combo: "Shift+Enter", command: "insertSiblingBelow" },
  { mode: "select", combo: "Tab", command: "indent" },
  { mode: "select", combo: "Shift+Tab", command: "outdent" },
  { mode: "select", combo: "ArrowUp", command: "moveSelectionUp" },
  { mode: "select", combo: "ArrowDown", command: "moveSelectionDown" },
  // Escape drops the highlight entirely (arrows pick it back up).
  { mode: "select", combo: "Escape", command: "deselect" },
  // Option/Alt+Arrow moves the block itself (alias of Mod+Shift+Arrow).
  { mode: "select", combo: "Alt+ArrowUp", command: "moveBlockUp" },
  { mode: "select", combo: "Alt+ArrowDown", command: "moveBlockDown" },
  // Cmd/Ctrl+Alt+Arrow jumps across siblings at the same level (skipping children).
  { mode: "select", combo: "Mod+Alt+ArrowUp", command: "prevSibling" },
  { mode: "select", combo: "Mod+Alt+ArrowDown", command: "nextSibling" },
  // Cmd/Ctrl+Arrow jumps to the top / bottom of the current level (walking up
  // levels, not to the page top).
  { mode: "select", combo: "Mod+ArrowUp", command: "jumpLevelTop" },
  { mode: "select", combo: "Mod+ArrowDown", command: "jumpLevelBottom" },
  // Cmd/Ctrl+Shift+Arrow reorders the block itself (Notion convention).
  { mode: "select", combo: "Mod+Shift+ArrowUp", command: "moveBlockUp" },
  { mode: "select", combo: "Mod+Shift+ArrowDown", command: "moveBlockDown" },
  // Shift+Alt+Arrow duplicates the block above / below (VS Code convention).
  { mode: "select", combo: "Alt+Shift+ArrowUp", command: "duplicateAbove" },
  { mode: "select", combo: "Alt+Shift+ArrowDown", command: "duplicateBelow" },
  { mode: "select", combo: "Backspace", command: "deleteBlock" },
  { mode: "select", combo: "Delete", command: "deleteBlock" },
  { mode: "select", combo: "x", command: "toggleTodo" },
  { mode: "select", combo: " ", command: "toggleCollapse" },
  // WASD tree navigation: w/s traverse siblings, breaking out of the level at
  // its ends (w: first sibling → parent; s: last sibling → the nearest
  // ancestor's next sibling) — unlike Mod+Alt+Arrow, which stops at the ends.
  // a/d walk depth — parent / first child (d auto-expands a collapsed block).
  { mode: "select", combo: "w", command: "treePrev" },
  { mode: "select", combo: "s", command: "treeNext" },
  { mode: "select", combo: "a", command: "selectParent" },
  { mode: "select", combo: "d", command: "selectFirstChild" },
  // "Turn into": marker keys are STRUCTURAL in select mode (select mode never
  // types text) — they toggle the block's type: same type strips back to a
  // paragraph, anything else swaps the leading marker. `#` and `>` need Shift
  // on many layouts, so both spellings are bound (like Mod+Shift+> above).
  { mode: "select", combo: "#", command: "turnIntoHeading" },
  { mode: "select", combo: "Shift+#", command: "turnIntoHeading" },
  // Alt spellings: on many non-US Mac layouts the symbol itself requires
  // Option (UK: # is Alt+3), so the event carries altKey with the same key.
  { mode: "select", combo: "Alt+#", command: "turnIntoHeading" },
  { mode: "select", combo: "Alt+Shift+#", command: "turnIntoHeading" },
  { mode: "select", combo: "-", command: "turnIntoBullet" },
  { mode: "select", combo: "[", command: "turnIntoTodo" },
  { mode: "select", combo: "Alt+[", command: "turnIntoTodo" },
  { mode: "select", combo: ">", command: "turnIntoQuote" },
  { mode: "select", combo: "Shift+>", command: "turnIntoQuote" },
  { mode: "select", combo: "Alt+>", command: "turnIntoQuote" },
  { mode: "select", combo: "Alt+Shift+>", command: "turnIntoQuote" },
  { mode: "select", combo: "1", command: "turnIntoOrdered" },
  // Zoom ("focus mode"): f dives into the block, Shift+F surfaces one level.
  { mode: "select", combo: "f", command: "zoomIn" },
  { mode: "select", combo: "Shift+F", command: "zoomOut" },
  // Mod+. / Mod+Shift+. are the both-modes aliases (family convention). With
  // Shift held, some layouts report the key as ">" — bind both spellings.
  { mode: "select", combo: "Mod+.", command: "zoomIn" },
  { mode: "select", combo: "Mod+Shift+.", command: "zoomExit" },
  { mode: "select", combo: "Mod+Shift+>", command: "zoomExit" },

  // ── Edit mode ──────────────────────────────────────────────────────────
  { mode: "edit", combo: "Escape", command: "exitEdit" },
  { mode: "edit", combo: "Tab", command: "indent" },
  { mode: "edit", combo: "Shift+Tab", command: "outdent" },
  { mode: "edit", combo: "Alt+ArrowUp", command: "moveBlockUp" },
  { mode: "edit", combo: "Alt+ArrowDown", command: "moveBlockDown" },
  { mode: "edit", combo: "Mod+Alt+ArrowUp", command: "prevSibling" },
  { mode: "edit", combo: "Mod+Alt+ArrowDown", command: "nextSibling" },
  { mode: "edit", combo: "Mod+ArrowUp", command: "jumpLevelTop" },
  { mode: "edit", combo: "Mod+ArrowDown", command: "jumpLevelBottom" },
  { mode: "edit", combo: "Mod+Shift+ArrowUp", command: "moveBlockUp" },
  { mode: "edit", combo: "Mod+Shift+ArrowDown", command: "moveBlockDown" },
  { mode: "edit", combo: "Alt+Shift+ArrowUp", command: "duplicateAbove" },
  { mode: "edit", combo: "Alt+Shift+ArrowDown", command: "duplicateBelow" },
  // Shift-Enter splits at the caret into a new block of the same type.
  { mode: "edit", combo: "Shift+Enter", command: "splitPlain" },
  // Cmd/Ctrl+Enter forces a same-type block below, ignoring the caret.
  { mode: "edit", combo: "Mod+Enter", command: "insertSiblingBelow" },
  // Enter: empty list item exits the list; caret-at-end appends a fresh block;
  // otherwise split the line at the caret (carrying the list style).
  { mode: "edit", combo: "Enter", when: isEmptyListItem, command: "exitList" },
  { mode: "edit", combo: "Enter", when: caretAtEnd, command: "insertBelow" },
  { mode: "edit", combo: "Enter", command: "splitContinuingList" },
  // Backspace only leaves the textarea's control at the very start of a block.
  { mode: "edit", combo: "Backspace", when: atStartWithMarker, command: "stripMarker" },
  { mode: "edit", combo: "Backspace", when: atStartEmpty, command: "backspaceEmpty" },
  // Arrows leave the block only from its first / last visual line.
  { mode: "edit", combo: "ArrowUp", when: atFirstLine, command: "moveEditFocusUp" },
  { mode: "edit", combo: "ArrowDown", when: atLastLine, command: "moveEditFocusDown" },
  // Zoom aliases work while typing too.
  { mode: "edit", combo: "Mod+.", command: "zoomIn" },
  { mode: "edit", combo: "Mod+Shift+.", command: "zoomExit" },
  { mode: "edit", combo: "Mod+Shift+>", command: "zoomExit" },
]

/** Minimal shape of a keyboard event needed to build a combo. */
export interface KeyLike {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

/** Normalise a key event to a combo string, e.g. `Shift+Tab`, `Mod+z`, `Enter`. */
export function comboFromEvent(event: KeyLike): string {
  const parts: string[] = []
  if (event.metaKey || event.ctrlKey) parts.push("Mod")
  if (event.altKey) parts.push("Alt")
  if (event.shiftKey) parts.push("Shift")
  parts.push(event.key)
  return parts.join("+")
}

/**
 * Resolve a mode + event to a command name, honouring `when` guards. Returns
 * `null` when nothing is bound (the caller then lets the event do its default,
 * e.g. ordinary typing).
 */
export function resolveKey(mode: Mode, event: KeyLike, input: CommandInput): CommandName | null {
  const combo = comboFromEvent(event)
  for (const binding of KEYMAP) {
    if (binding.mode !== mode) continue
    if (binding.combo !== combo) continue
    if (binding.when && !binding.when(input)) continue
    return binding.command
  }
  return null
}
