import { KEYMAP } from "../blocks/keymap"
import { WRAP_PAIRS, type CommandName } from "../blocks/commands"

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

type ShortcutScope = "global" | "select" | "edit" | "palette" | "focus" | "title"

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
  searchHeadings: "mod+p",
  newNote: "mod+shift+o",
  save: "mod+s",
  focusEditor: "i",
  toggleSidebar: "mod+b",
  helpPanel: "mod+/",
  applyUpdate: "mod+shift+u",
  focusSearch: "/",
  /** The `g` chords, which `GChordMachine` binds and the sidebar labels its
   * rows with — so a destination's key is written once, here. */
  goCalendar: "g d",
  goNotes: "g n",
  goSettings: "g s",
  goAdmin: "g a",
  goChangelog: "g c",
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
  selectParent: "Select the parent block (on the focused title: step back)",
  selectFirstChild: "Select the first child (auto-expands a collapsed block)",
  expandOrFirstChild: "Expand the block (already open: select its first child)",
  collapseOrParent: "Collapse the block (already closed, or a leaf: select the parent)",
  turnIntoHeading: "Turn into a heading (again: back to a paragraph)",
  turnIntoBullet: "Turn into a bullet (again: back to a paragraph)",
  turnIntoTodo: "Turn into a todo (again: back to a paragraph)",
  turnIntoQuote: "Turn into a quote (again: back to a paragraph)",
  turnIntoOrdered: "Turn into a numbered item (again: back to a paragraph)",
  turnIntoCode: "Turn into a code block (again: back to a paragraph)",
  openFence: "Open a code block of the language typed after ``` (then Enter)",
  jumpLevelTop: "Jump to the top of the current level",
  jumpLevelBottom: "Jump to the bottom of the current level",
  moveBlockUp: "Move the block up (with its subtree)",
  moveBlockDown: "Move the block down (with its subtree)",
  duplicateAbove: "Duplicate the block above",
  duplicateBelow: "Duplicate the block below",
  wrapBold: "Bold the selection (** around it; again to take it off)",
  wrapItalic: "Italicise the selection (_ around it; again to take it off)",
  wrapStrike: "Strike the selection through (~~ around it; again to take it off)",
  wrapCode: "Make the selection inline code (backticks; again to take them off)",
  wrapMath: "Set the selection as maths ($$ around it; again to take it off)",
  wrapLink: "Make the selection a link ([text](url), caret in the parentheses)",
  wrapTyped: "Wrap the selection in the character typed (a bracket closes with its partner)",
  deleteBlock: "Remove the block from here (it keeps its place elsewhere, or goes to Unassigned)",
  toggleTodo: "Toggle the checkbox (todo blocks)",
  toggleCollapse: "Collapse / expand children",
  insertBelow: "New block below (caret at end of block)",
  insertSiblingBelow: "New block below, same type (ignores the caret)",
  splitContinuingList: "Split the line at the caret (continuing the list)",
  splitPlain: "Split at the caret into a same-type block",
  exitList: "Exit the list (on an empty list item)",
  stripMarker: "Strip the block's marker (at line start)",
  backspaceEmpty: "Merge into the block above (empty block, at line start)",
  focusBlock: "Focus on the block",
  focusBack: "Step back one level",
  leaveFocus: "Leave focus entirely",
}

/**
 * Commands the resolver reaches without a row in `KEYMAP`, because *which*
 * key runs them is a property of the character typed rather than of a fixed
 * combo (`resolveKey`, and the layout problem its comment describes). They
 * are described above like any other command and listed by hand below; the
 * completeness test knows not to look for a binding.
 */
export const COMMANDS_WITHOUT_BINDINGS = new Set<CommandName>(["wrapTyped"])

/** Focus commands render under their own group, whichever mode binds them. */
const FOCUS_COMMANDS = new Set<CommandName>(["focusBlock", "focusBack", "leaveFocus"])

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
    const focus = FOCUS_COMMANDS.has(binding.command)
    const scope: ShortcutScope = focus ? "focus" : binding.mode
    const key = `${scope}:${binding.command}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        combos: [],
        scope,
        description: EDITOR_COMMAND_DESCRIPTIONS[binding.command],
        group: focus ? "Focus" : binding.mode === "select" ? "Select mode" : "Edit mode",
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
    description: "Paste blocks into the selection (rich text converts to markdown)",
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

/** The wrapping characters, listed as the keys they are (`WRAP_PAIRS`). */
const TYPED_WRAP_ENTRIES: Shortcut[] = [
  {
    combos: Object.keys(WRAP_PAIRS),
    scope: "edit",
    description: EDITOR_COMMAND_DESCRIPTIONS.wrapTyped,
    group: "Edit mode",
  },
]

const SLASH_MENU_ENTRIES: Shortcut[] = [
  {
    combos: ["/"],
    scope: "edit",
    description:
      "Open the slash menu at the start of a word: insert a date (today, tomorrow, “friday next week”…) or turn the block into another type",
    group: "Edit mode",
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
    description: "Remove the selected blocks from here",
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
    combos: [APP_SHORTCUTS.searchHeadings],
    scope: "global",
    description: "Search the open note's headings (⌘K with type:heading and in: set)",
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
    description: "Save the note now (changes autosave)",
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
    combos: [APP_SHORTCUTS.applyUpdate],
    scope: "global",
    description:
      'Apply a waiting update (the sidebar\'s "Update Ruminate"); nothing if none is waiting',
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
    combos: [APP_SHORTCUTS.goCalendar],
    scope: "global",
    description: "Go to today's daily note (press g, then d)",
    group: "Navigation",
  },
  {
    combos: [APP_SHORTCUTS.goNotes],
    scope: "global",
    description: "Go to the notes list (press g, then n)",
    group: "Navigation",
  },
  {
    combos: [APP_SHORTCUTS.goSettings],
    scope: "global",
    description: "Go to settings (press g, then s)",
    group: "Navigation",
  },
  {
    combos: [APP_SHORTCUTS.goChangelog],
    scope: "global",
    description: "Go to the changelog (press g, then c)",
    group: "Navigation",
  },
  {
    combos: [APP_SHORTCUTS.goAdmin],
    scope: "global",
    description: "Go to the admin page (press g, then a; the admin only)",
    group: "Navigation",
  },
  {
    combos: [APP_SHORTCUTS.focusSearch],
    scope: "global",
    description: "Jump to the search input (notes list)",
    group: "Navigation",
  },
  {
    combos: [APP_SHORTCUTS.focusEditor],
    scope: "global",
    description: "Return to the editor, restoring the last selected block",
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

// Search results — the rows in ⌘K, on the notes list and on the results view
// (`/?query=`) are the block editor (src/components/results-editor.tsx), so
// their keys are the editor's. These are the hand-offs around them.
const SEARCH_RESULT_ENTRIES: Shortcut[] = [
  {
    combos: ["ArrowDown"],
    scope: "global",
    description: "In the search box (past the last palette item): into the result rows",
    group: "Search results",
  },
  {
    combos: ["ArrowUp"],
    scope: "global",
    description: "From the first row: back to the search box",
    group: "Search results",
  },
  {
    combos: [" ", "ArrowRight", "ArrowLeft"],
    scope: "global",
    description: "Fold and unfold the highlighted result — the blocks inside it",
    group: "Search results",
  },
  {
    combos: ["Enter"],
    scope: "global",
    description: "Open the highlighted result (its note, focused on a block)",
    group: "Search results",
  },
  {
    combos: ["Enter"],
    scope: "palette",
    description: "On the query itself: see all results (a bookmarkable ?query= view)",
    group: "Search results",
  },
]

// Bindings inside the open command palette (see src/components/command-menu.tsx).
const PALETTE_ENTRIES: Shortcut[] = [
  {
    combos: ["Mod+Enter"],
    scope: "palette",
    description: "Create a note titled with the query's text (untitled with none)",
    group: "Palette",
  },
  {
    combos: ["Backspace"],
    scope: "palette",
    description: "On an empty query: take the last filter pill back into the line to edit",
    group: "Palette",
  },
  {
    combos: ["Escape"],
    scope: "palette",
    description: "Clear the query (filters and text); again to close",
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
  "Search results",
  "Select mode",
  "Edit mode",
  "Multi-select",
  "Selection ladder",
  "History",
  "Focus",
  "Palette",
  "Note title",
] as const

/** Every shortcut in the app, in display order within each group. */
export const SHORTCUTS: Shortcut[] = [
  ...GLOBAL_ENTRIES,
  ...NAVIGATION_ENTRIES,
  ...SEARCH_RESULT_ENTRIES,
  ...editorEntries(),
  ...CLIPBOARD_HISTORY_ENTRIES,
  ...TYPED_WRAP_ENTRIES,
  ...SLASH_MENU_ENTRIES,
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
