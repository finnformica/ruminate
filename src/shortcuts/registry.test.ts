import { describe, expect, it } from "vitest"
import { KEYMAP } from "../blocks/keymap"
import type { CommandName } from "../blocks/commands"
import {
  APP_SHORTCUTS,
  EDITOR_COMMAND_DESCRIPTIONS,
  GROUP_ORDER,
  SHORTCUTS,
  formatCombo,
  groupedShortcuts,
} from "./registry"

/** Combos bound in the keymap purely as alternate spellings (hidden from display). */
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

const MODIFIERS = new Set(["mod", "ctrl", "alt", "shift"])
const NAMED_KEYS = new Set([
  "enter",
  "escape",
  "tab",
  "backspace",
  "delete",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
])

function isValidCombo(combo: string): boolean {
  if (combo === "") return false
  // Chords: space-separated single letters, pressed in sequence.
  if (combo.length > 1 && combo.includes(" ")) {
    return combo.split(" ").every((key) => /^[a-z]$/.test(key))
  }
  const parts = combo.split("+")
  const key = parts.pop() ?? ""
  if (!parts.every((part) => MODIFIERS.has(part.toLowerCase()))) return false
  return key.length === 1 || NAMED_KEYS.has(key.toLowerCase())
}

describe("shortcut registry ↔ keymap completeness", () => {
  const keymapCommands = new Set<CommandName>(KEYMAP.map((binding) => binding.command))

  it("every KEYMAP binding has a non-empty description", () => {
    for (const binding of KEYMAP) {
      expect(
        EDITOR_COMMAND_DESCRIPTIONS[binding.command],
        `command "${binding.command}" has no description`,
      ).toBeTruthy()
    }
  })

  it("every described editor command exists in KEYMAP (no stale descriptions)", () => {
    for (const command of Object.keys(EDITOR_COMMAND_DESCRIPTIONS)) {
      expect(keymapCommands.has(command as CommandName), `"${command}" is not bound`).toBe(true)
    }
  })

  it("every KEYMAP combo appears in the registry under its scope", () => {
    for (const binding of KEYMAP) {
      if (HIDDEN_COMBOS.has(binding.combo)) continue
      const found = SHORTCUTS.some(
        (shortcut) =>
          (shortcut.scope === binding.mode || shortcut.scope === "zoom") &&
          shortcut.combos.includes(binding.combo) &&
          shortcut.description === EDITOR_COMMAND_DESCRIPTIONS[binding.command],
      )
      expect(found, `${binding.mode} ${binding.combo} (${binding.command}) missing`).toBe(true)
    }
  })
})

describe("shortcut registry entries", () => {
  it("every entry has a description, a known group, and at least one combo", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.description.trim()).not.toBe("")
      expect(GROUP_ORDER).toContain(shortcut.group)
      expect(shortcut.combos.length).toBeGreaterThan(0)
    }
  })

  it("every combo is well-formed", () => {
    for (const shortcut of SHORTCUTS) {
      for (const combo of shortcut.combos) {
        expect(isValidCombo(combo), `bad combo "${combo}" (${shortcut.description})`).toBe(true)
      }
    }
  })

  it("contains the navigation vocabulary and app-level bindings", () => {
    const combos = new Set(SHORTCUTS.flatMap((shortcut) => shortcut.combos))
    for (const expected of [
      "g d",
      "g n",
      "g t",
      "g s",
      "?",
      APP_SHORTCUTS.focusSearch,
      APP_SHORTCUTS.historyBack,
      APP_SHORTCUTS.historyForward,
      APP_SHORTCUTS.commandMenu,
      APP_SHORTCUTS.outlinePalette,
      APP_SHORTCUTS.newNote,
      APP_SHORTCUTS.save,
      APP_SHORTCUTS.toggleSidebar,
      APP_SHORTCUTS.helpPanel,
    ]) {
      expect(combos.has(expected), `registry is missing "${expected}"`).toBe(true)
    }
  })

  it("does not list the DEV-only dev bar toggle", () => {
    expect(SHORTCUTS.some((shortcut) => shortcut.combos.includes(APP_SHORTCUTS.devBar))).toBe(false)
  })
})

describe("formatCombo", () => {
  it("renders mac symbols on mac", () => {
    expect(formatCombo("Mod+Shift+ArrowUp", true)).toEqual(["⌘", "⇧", "↑"])
    expect(formatCombo("mod+shift+o", true)).toEqual(["⌘", "⇧", "O"])
    expect(formatCombo("mod+/", true)).toEqual(["⌘", "/"])
    expect(formatCombo("Mod+.", true)).toEqual(["⌘", "."])
  })

  it("renders Ctrl/Alt off mac", () => {
    expect(formatCombo("Mod+Enter", false)).toEqual(["Ctrl", "↵"])
    expect(formatCombo("Alt+ArrowDown", false)).toEqual(["Alt", "↓"])
  })

  it("renders chords, single keys, and Space", () => {
    expect(formatCombo("g d", true)).toEqual(["G", "D"])
    expect(formatCombo(" ", true)).toEqual(["Space"])
    expect(formatCombo("?", true)).toEqual(["?"])
    expect(formatCombo("Escape", true)).toEqual(["Esc"])
  })
})

describe("groupedShortcuts", () => {
  it("returns every group, in order, when unfiltered", () => {
    const groups = groupedShortcuts("", true)
    expect(groups.map((group) => group.title)).toEqual([...GROUP_ORDER])
    for (const group of groups) {
      expect(group.shortcuts.length).toBeGreaterThan(0)
    }
  })

  it("filters by description", () => {
    const groups = groupedShortcuts("sidebar", true)
    expect(groups).toHaveLength(1)
    expect(groups[0].title).toBe("Global")
    expect(groups[0].shortcuts[0].description).toBe("Toggle the sidebar")
  })

  it("filters by formatted combo", () => {
    const groups = groupedShortcuts("⌘ K", true)
    expect(groups.some((group) => group.title === "Global")).toBe(true)
    const global = groups.find((group) => group.title === "Global")
    expect(global?.shortcuts.some((s) => s.description === "Toggle the command menu")).toBe(true)
  })
})
