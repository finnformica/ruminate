import { KEYMAP } from "../blocks/keymap"
import type { CommandName } from "../blocks/commands"

/**
 * The app's **shortcut registry**: one declarative table of every keyboard
 * binding, app-wide. It has three sources:
 *
 * 1. **The block editor's keymap** (`src/blocks/keymap.ts`) — entries are
 *    *generated* from the live `KEYMAP`, so the reference can never drift from
 *    the editor's real behaviour (a test enforces the mapping both ways).
 * 2. **Imperative editor bindings** — undo/redo, the ⌘A ladder, multi-select
 *    group ops, copy/cut/paste — declared here as literals, with each list
 *    pointing at the handler that owns it.
 * 3. **App-level hotkeys** — the `react-hotkeys-hook` call sites read their
 *    combo strings from `APP_SHORTCUTS` below, so this file is the source of
 *    truth for those too.
 *
 * The `?` shortcut reference (help panel) and `docs/keyboard-shortcuts.md`
 * both render from this table.
 */

type ShortcutScope = "global" | "select" | "edit" | "palette" | "zoom" | "title"

export interface Shortcut {
  /**
   * Normalised combos, primary first. Editor combos use the keymap's spelling
   * (`Mod+Shift+ArrowUp`); app-level combos use react-hotkeys-hook's
   * (`mod+shift+o`) — `formatCombo` displays both. A two-key chord is written
   * with a space (`"g d"` = press g, then d).
   */
  combos: string[]
  scope: ShortcutScope
  description: string
  /** The heading the entry renders under in the `?` reference. */
  group: string
}

// ── App-level hotkeys ───────────────────────────────────────────────────────

/**
 * Combo strings for every `useHotkeys` call site, in react-hotkeys-hook
 * syntax. The call sites import these (never a string literal), so changing a
 * binding here changes the app *and* the `?` reference together.
 */
export const APP_SHORTCUTS = {
  commandMenu: "mod+k",
  outlinePalette: "mod+p",
  newNote: "mod+shift+o",
  save: "mod+s",
  focusEditor: "i",
  toggleSidebar: "mod+b",
  helpPanel: "mod+/",
  focusSearch: "/",
  historyBack: "mod+[",
  historyForward: "mod+]",
  /** DEV builds only — deliberately not listed in the `?` reference. */
  devBar: "ctrl+`",
} as const

/** The options object every global `useHotkeys` call site shares. */
export const GLOBAL_HOTKEY_OPTIONS = {
  preventDefault: true,
  enableOnFormTags: true,
  enableOnContentEditable: true,
} as const

// ── Editor entries, generated from the keymap ───────────────────────────────

/**
 * A human description for every command name the keymap binds. A test asserts
 * this table and `KEYMAP` cover each other exactly (both directions), so a new
 * binding without a description — or a stale description — fails CI.
 */
export const EDITOR_COMMAND_DESCRIPTIONS: Record<CommandName, string> = {
  enterEdit: "Edit the highlighted block",
  exitEdit: "Stop editing (back to highlight)",
  deselect: "Deselect (nothing highlighted)",
  indent: "Indent the block",
  outdent: "Outdent the block",
  moveSelectionUp: "Move the highlight up",
  moveSelectionDown: "Move the highlight down",
  moveEditFocusUp: "Exit edit upward (at the first line)",
  moveEditFocusDown: "Exit edit downward (at the last line)",
  prevSibling: "Jump to the previous sibling (skipping children)",
  nextSibling: "Jump to the next sibling (skipping children)",
  treePrev: "Previous sibling (or the parent at the top of a level)",
  treeNext: "Next sibling (or the next block one level out at the end)",
  selectParent: "Select the parent block (on the zoomed title: zoom out)",
  selectFirstChild: "Select the first child (auto-expands a collapsed block)",
  turnIntoHeading: "Turn into a heading (again: back to a paragraph)",
  turnIntoBullet: "Turn into a bullet (again: back to a paragraph)",
  turnIntoTodo: "Turn into a todo (again: back to a paragraph)",
  turnIntoQuote: "Turn into a quote (again: back to a paragraph)",
  turnIntoOrdered: "Turn into a numbered item (again: back to a paragraph)",
  jumpLevelTop: "Jump to the top of the current level",
  jumpLevelBottom: "Jump to the bottom of the current level",
  moveBlockUp: "Move the block up (with its subtree)",
  moveBlockDown: "Move the block down (with its subtree)",
  duplicateAbove: "Duplicate the block above",
  duplicateBelow: "Duplicate the block below",
  deleteBlock: "Delete the block",
  toggleTodo: "Toggle the checkbox (todo blocks)",
  toggleCollapse: "Collapse / expand children",
  insertBelow: "New block below (caret at end of block)",
  insertSiblingBelow: "New block below, same type (ignores the caret)",
  splitContinuingList: "Split the line at the caret (continuing the list)",
  splitPlain: "Split at the caret into a same-type block",
  exitList: "Exit the list (on an empty list item)",
  stripMarker: "Strip the block's marker (at line start)",
  backspaceEmpty: "Merge into the block above (empty block, at line start)",
  zoomIn: "Zoom into the block",
  zoomOut: "Zoom out one level",
  zoomExit: "Exit zoom entirely",
}

/** Zoom commands render under their own group, whichever mode binds them. */
const ZOOM_COMMANDS = new Set<CommandName>(["zoomIn", "zoomOut", "zoomExit"])

/**
 * Combos that exist only as alternate spellings of another binding (layouts
 * differ in whether #, > and Shift+. report the shifted character) — bound in
 * the keymap, hidden from display.
 */
const HIDDEN_COMBOS = new Set([
  "Mod+Shift+>",
  "Shift+#",
  "Shift+>",
  "Alt+#",
  "Alt+Shift+#",
  "Alt+[",
  "Alt+>",
  "Alt+Shift+>",
])

/** One entry per (scope, command): combos bound to the same command merge. */
function editorEntries(): Shortcut[] {
  const entries: Shortcut[] = []
  const byKey = new Map<string, Shortcut>()
  for (const binding of KEYMAP) {
    const zoom = ZOOM_COMMANDS.has(binding.command)
    const scope: ShortcutScope = zoom ? "zoom" : binding.mode
    const key = `${scope}:${binding.command}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        combos: [],
        scope,
        description: EDITOR_COMMAND_DESCRIPTIONS[binding.command],
        group: zoom ? "Zoom" : binding.mode === "select" ? "Select mode" : "Edit mode",
      }
      byKey.set(key, entry)
      entries.push(entry)
    }
    if (!HIDDEN_COMBOS.has(binding.combo) && !entry.combos.includes(binding.combo)) {
      entry.combos.push(binding.combo)
    }
  }
  return entries
}

// ── Imperative editor bindings ──────────────────────────────────────────────
// These are handled imperatively in `handleKeyDown` of
// `src/components/block-editor/block-editor.tsx` (not through the keymap
// table): undo/redo, Shift+Arrow extension, copy/cut/paste, the ⌘A ladder,
// and the multi-select group operations.

const CLIPBOARD_HISTORY_ENTRIES: Shortcut[] = [
  {
    combos: ["Mod+c"],
    scope: "select",
    description: "Copy the selection (markdown + rich text; pastes back into Ruminate exactly)",
    group: "Select mode",
  },
  {
    combos: ["Mod+x"],
    scope: "select",
    description: "Cut the selection (markdown + rich text)",
    group: "Select mode",
  },
  {
    combos: ["Mod+v"],
    scope: "select",
    description: "Paste blocks after the selection (rich text converts to markdown)",
    group: "Select mode",
  },
  {
    combos: ["Mod+Shift+v"],
    scope: "select",
    description: "Paste as one plain block (newlines → spaces)",
    group: "Select mode",
  },
  {
    combos: ["Mod+z"],
    scope: "select",
    description: "Undo (whole document, survives a save)",
    group: "History",
  },
  {
    combos: ["Mod+Shift+z", "Mod+y"],
    scope: "select",
    description: "Redo",
    group: "History",
  },
]

const LADDER_ENTRIES: Shortcut[] = [
  {
    combos: ["Mod+a"],
    scope: "select",
    description: "Grow the selection one structural rung (block → subtree → parent → page)",
    group: "Selection ladder",
  },
  {
    combos: ["Mod+Shift+a"],
    scope: "select",
    description: "Shrink the selection back one rung",
    group: "Selection ladder",
  },
]

const MULTI_SELECT_ENTRIES: Shortcut[] = [
  {
    combos: ["Shift+ArrowUp", "Shift+ArrowDown"],
    scope: "select",
    description: "Extend the selection to more blocks",
    group: "Multi-select",
  },
  {
    combos: ["Alt+ArrowUp", "Alt+ArrowDown"],
    scope: "select",
    description: "Move the selected blocks together (same parent)",
    group: "Multi-select",
  },
  {
    combos: ["Alt+Shift+ArrowUp", "Alt+Shift+ArrowDown"],
    scope: "select",
    description: "Duplicate the selection as a group",
    group: "Multi-select",
  },
  {
    combos: ["Tab", "Shift+Tab"],
    scope: "select",
    description: "Indent / outdent the whole selection",
    group: "Multi-select",
  },
  {
    combos: ["Backspace", "Delete"],
    scope: "select",
    description: "Delete the selected blocks",
    group: "Multi-select",
  },
  {
    combos: ["#", "-", "[", ">", "1"],
    scope: "select",
    description: "Turn the selected blocks into that type (toggle)",
    group: "Multi-select",
  },
  {
    combos: ["Escape"],
    scope: "select",
    description: "Collapse back to a single selection",
    group: "Multi-select",
  },
]

// ── App-level entries ───────────────────────────────────────────────────────

const GLOBAL_ENTRIES: Shortcut[] = [
  {
    combos: [APP_SHORTCUTS.commandMenu],
    scope: "global",
    description: "Toggle the command menu",
    group: "Global",
  },
  {
    combos: [APP_SHORTCUTS.outlinePalette],
    scope: "global",
    description: "Jump to a heading (or type @ in ⌘K)",
    group: "Global",
  },
  {
    combos: [APP_SHORTCUTS.newNote],
    scope: "global",
    description: "Create a new note",
    group: "Global",
  },
  {
    combos: [APP_SHORTCUTS.save],
    scope: "global",
    description: "Save the note",
    group: "Global",
  },
  {
    combos: [APP_SHORTCUTS.toggleSidebar],
    scope: "global",
    description: "Toggle the sidebar",
    group: "Global",
  },
  {
    combos: [APP_SHORTCUTS.helpPanel],
    scope: "global",
    description: "Toggle the help panel",
    group: "Global",
  },
  {
    // Handled by GlobalShortcuts (src/shortcuts/global-shortcuts.tsx), not
    // react-hotkeys-hook, so select mode and plain pages both reach it.
    combos: ["?"],
    scope: "global",
    description: "Open this shortcut reference",
    group: "Global",
  },
]

const NAVIGATION_ENTRIES: Shortcut[] = [
  {
    combos: ["g d"],
    scope: "global",
    description: "Go to today's daily note (press g, then d)",
    group: "Navigation",
  },
  {
    combos: ["g n"],
    scope: "global",
    description: "Go to the notes list (press g, then n)",
    group: "Navigation",
  },
  {
    combos: ["g t"],
    scope: "global",
    description: "Go to tags (press g, then t)",
    group: "Navigation",
  },
  {
    combos: ["g s"],
    scope: "global",
    description: "Go to settings (press g, then s)",
    group: "Navigation",
  },
  {
    combos: [APP_SHORTCUTS.focusSearch],
    scope: "global",
    description: "Focus the search input (notes list, tags)",
    group: "Navigation",
  },
  {
    combos: [APP_SHORTCUTS.focusEditor],
    scope: "global",
    description: "Focus the editor, restoring the last selected block",
    group: "Navigation",
  },
  {
    combos: [APP_SHORTCUTS.historyBack],
    scope: "global",
    description: "Back (browser history)",
    group: "Navigation",
  },
  {
    combos: [APP_SHORTCUTS.historyForward],
    scope: "global",
    description: "Forward (browser history)",
    group: "Navigation",
  },
]

// Linear-style keys on the filterable list pages — the notes index and the
// tags page (see src/hooks/list-keyboard-nav.ts).
const LIST_ENTRIES: Shortcut[] = [
  {
    combos: ["ArrowUp", "ArrowDown"],
    scope: "global",
    description: "Move the list highlight (notes list, tags)",
    group: "Lists",
  },
  {
    combos: ["ArrowDown"],
    scope: "global",
    description: "In the search input: highlight the first result",
    group: "Lists",
  },
  {
    combos: ["Enter"],
    scope: "global",
    description: "Open the highlighted note or tag",
    group: "Lists",
  },
  {
    combos: ["Escape"],
    scope: "global",
    description: "Clear the highlight, back to the search input",
    group: "Lists",
  },
  {
    combos: ["Home", "End"],
    scope: "global",
    description: "Jump to the first / last item",
    group: "Lists",
  },
]

// Bindings inside the open command palette (see src/components/command-menu.tsx).
const PALETTE_ENTRIES: Shortcut[] = [
  {
    combos: ["@"],
    scope: "palette",
    description: "Type @ first in ⌘K to jump to a heading",
    group: "Palette",
  },
  {
    combos: ["ArrowUp", "ArrowDown"],
    scope: "palette",
    description: "Preview the highlighted heading behind the dialog",
    group: "Palette",
  },
  {
    combos: ["Enter"],
    scope: "palette",
    description: "Jump to the highlighted heading",
    group: "Palette",
  },
  {
    combos: ["Escape"],
    scope: "palette",
    description: "Close, restoring the view exactly as it was",
    group: "Palette",
  },
  {
    combos: ["Backspace"],
    scope: "palette",
    description: "On an empty query: back to the commands palette (after @)",
    group: "Palette",
  },
]

// The editable note title above the block editor
// (src/components/block-editor/note-title.tsx).
const TITLE_ENTRIES: Shortcut[] = [
  {
    combos: ["ArrowUp"],
    scope: "title",
    description: "Select the title (from the first block)",
    group: "Note title",
  },
  {
    combos: ["Enter"],
    scope: "title",
    description: "Edit the title / commit a rename",
    group: "Note title",
  },
  {
    combos: ["Mod+Enter", "Shift+Enter"],
    scope: "title",
    description: "New root block below the title",
    group: "Note title",
  },
  {
    combos: ["ArrowDown"],
    scope: "title",
    description: "Drop back into the editor",
    group: "Note title",
  },
  {
    combos: ["Escape"],
    scope: "title",
    description: "Cancel the rename",
    group: "Note title",
  },
]

/** Render order of the `?` reference's groups. */
export const GROUP_ORDER = [
  "Global",
  "Navigation",
  "Lists",
  "Select mode",
  "Edit mode",
  "Multi-select",
  "Selection ladder",
  "History",
  "Zoom",
  "Palette",
  "Note title",
] as const

/** Every shortcut in the app, in display order within each group. */
export const SHORTCUTS: Shortcut[] = [
  ...GLOBAL_ENTRIES,
  ...NAVIGATION_ENTRIES,
  ...LIST_ENTRIES,
  ...editorEntries(),
  ...CLIPBOARD_HISTORY_ENTRIES,
  ...MULTI_SELECT_ENTRIES,
  ...LADDER_ENTRIES,
  ...PALETTE_ENTRIES,
  ...TITLE_ENTRIES,
]

// ── Display ─────────────────────────────────────────────────────────────────

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform ?? "")
}

const KEY_LABELS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "↵",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  escape: "Esc",
  " ": "Space",
  "`": "`",
}

function formatKey(key: string, isMac: boolean): string {
  const lower = key.toLowerCase()
  if (lower === "mod") return isMac ? "⌘" : "Ctrl"
  if (lower === "ctrl") return isMac ? "⌃" : "Ctrl"
  if (lower === "shift") return "⇧"
  if (lower === "alt") return isMac ? "⌥" : "Alt"
  if (lower in KEY_LABELS) return KEY_LABELS[lower]
  return key.length === 1 ? key.toUpperCase() : key
}

/**
 * A combo string as the key labels the `Keys` component renders: platform
 * modifiers (⌘/⌥ on mac, Ctrl/Alt elsewhere), arrows and Enter as symbols.
 * Chords (`"g d"`) render as their keys in press order.
 */
export function formatCombo(combo: string, isMac: boolean = isMacPlatform()): string[] {
  if (combo.length > 1 && combo.includes(" ")) {
    return combo.split(" ").map((key) => formatKey(key, isMac))
  }
  // No registry combo uses a literal "+" key, so a plain split is safe. The
  // single-key combo " " skips the chord branch (length 1) and maps to "Space".
  return combo.split("+").map((key) => formatKey(key, isMac))
}

/** The registry grouped for rendering, optionally filtered (description/combo). */
export function groupedShortcuts(
  filter = "",
  isMac: boolean = isMacPlatform(),
): { title: string; shortcuts: Shortcut[] }[] {
  const query = filter.trim().toLowerCase()
  const matches = (shortcut: Shortcut): boolean => {
    if (!query) return true
    if (shortcut.description.toLowerCase().includes(query)) return true
    return shortcut.combos.some(
      (combo) =>
        combo.toLowerCase().includes(query) ||
        formatCombo(combo, isMac).join(" ").toLowerCase().includes(query),
    )
  }
  return GROUP_ORDER.map((title) => ({
    title,
    shortcuts: SHORTCUTS.filter((s) => s.group === title && matches(s)),
  })).filter((group) => group.shortcuts.length > 0)
}
