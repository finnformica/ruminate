import { searchTypeOptions } from "../blocks/registry"
import { dateShortcuts } from "../blocks/slash-menu"
/**
 * **Value suggestions for qualifiers.** Typing `type:`, `in:`, `has:` — any
 * key whose values come from a known set — opens a picker over the search
 * box listing what can go there (`src/components/qualifier-suggestions.tsx`).
 * This module is the DOM-free half: read the qualifier under the caret, list
 * and filter the static vocabularies, and splice a picked value back into
 * the query. The corpus-backed set (notes for `in:`) is supplied by the
 * hook, which has the atoms.
 */

/** The qualifier being typed at the caret. */
export interface QualifierTrigger {
  /** The key, lowercased (`type`, `in`, …). */
  key: string
  /** Whether the qualifier is negated (`-type:`). */
  exclude: boolean
  /** Values already typed before the last comma (kept when a pick lands). */
  prefixValues: string[]
  /** The text of the value being typed, unquoted — what filters the options. */
  partial: string
  /** The whole qualifier token's range in the input (replaced on pick). */
  start: number
  end: number
}

/**
 * The `-?key:value` token the caret sits in — at its end, after typing, or
 * anywhere inside it. A token starts at the beginning of the text or after
 * whitespace (so `https://` never triggers); an open quote lets the value run
 * over spaces (`in:"reading li`). A `sort:` value's direction suffix
 * (`title:desc`) is part of the value: the partial `title:` narrows to it.
 */
export function findQualifierTrigger(value: string, caret: number): QualifierTrigger | null {
  const before = value.slice(0, caret)
  const match = /(?:^|\s)(-?)([-\w]+):("[^"]*|[^"\s]*)$/.exec(before)
  if (!match) return null
  const [, dash, rawKey, rawValue] = match
  const exclude = dash === "-"
  const key = rawKey.toLowerCase()
  // The match may have consumed the whitespace before the token.
  const start =
    match.index + (match[0].length - (dash.length + rawKey.length + 1 + rawValue.length))
  const quoted = rawValue.startsWith('"')
  // Past the caret, the rest of an unquoted token belongs to it too.
  const rest = quoted ? "" : (/^[^\s]*/.exec(value.slice(caret))?.[0] ?? "")
  const end = caret + rest.length

  let prefixValues: string[] = []
  let partial = rawValue
  if (quoted) {
    partial = rawValue.slice(1)
  } else if (rawValue.includes(",")) {
    const parts = rawValue.split(",")
    partial = parts[parts.length - 1]
    prefixValues = parts.slice(0, -1).filter(Boolean)
  }
  return { key, exclude, prefixValues, partial, start, end }
}

/** One thing that can go after the key. */
export interface QualifierOption {
  /** What lands in the query. */
  value: string
  /** How the row reads (defaults to the value). */
  label?: string
  /** A markdown glyph for the row's leading slot (`type:` rows). */
  glyph?: string
  /** A pick writes the value with a colon after it and keeps the picker
   * open for what follows — a sort key, before its direction. */
  partial?: boolean
}

/**
 * Splice a picked value into the query in place of the token being typed.
 * Comma lists keep their earlier values; a value with spaces (a note name)
 * is quoted; a space follows so typing carries straight on. Returns the new
 * text and where the caret should go.
 */
export function applyQualifierOption(
  value: string,
  trigger: QualifierTrigger,
  option: QualifierOption,
): { value: string; caret: number } {
  const picked = /[\s"[\]|]/.test(option.value)
    ? `"${option.value.replace(/"/g, "")}"`
    : option.value
  const values = [...trigger.prefixValues, picked].join(",")
  const token = `${trigger.exclude ? "-" : ""}${trigger.key}:${values}`
  const after = value.slice(trigger.end)
  if (option.partial) {
    // Half a value: the colon opens the second step, the caret stays put.
    const next = value.slice(0, trigger.start) + token + ":" + after
    return { value: next, caret: trigger.start + token.length + 1 }
  }
  const next = value.slice(0, trigger.start) + token + " " + after.replace(/^\s+/, "")
  return { value: next, caret: trigger.start + token.length + 1 }
}

/**
 * Narrow options to a partial: prefix matches first (on the value, then the
 * label), then anything containing it. Case-insensitive. An empty partial
 * keeps the list as given.
 */
export function filterQualifierOptions(
  options: readonly QualifierOption[],
  partial: string,
): QualifierOption[] {
  const needle = partial.trim().toLowerCase()
  if (needle === "") return [...options]
  const rank = (option: QualifierOption): number => {
    const value = option.value.toLowerCase()
    const label = (option.label ?? "").toLowerCase()
    if (value.startsWith(needle)) return 0
    if (label.startsWith(needle)) return 1
    if (value.includes(needle) || label.includes(needle)) return 2
    return -1
  }
  return options
    .map((option, index) => ({ option, index, rank: rank(option) }))
    .filter((entry) => entry.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.option)
}

/**
 * The fixed vocabularies. `type:` lists the block types (docs/query-language.md,
 * "Block types" — the registry's, `src/blocks/types.ts`) and then the note
 * types; `has:`/`no:` the countable things. `sort:` is built from the
 * partial (`sortQualifierOptions`: the key, then its direction) and `date:`
 * from today's date (`dateQualifierOptions`), so both are made when asked
 * for, not when the module loads. A row is its label — the value
 * capitalised — and, for a block type, its glyph: nothing is glossed.
 */
export const STATIC_QUALIFIER_OPTIONS: Readonly<Record<string, readonly QualifierOption[]>> = {
  // The block types, each with its markdown glyph, then the note types.
  type: [...searchTypeOptions(), named("note"), named("daily"), named("weekly"), named("template")],
  has: [named("dates"), named("tasks"), named("title")],
  no: [named("dates"), named("tasks"), named("title")],
}

/** A row that reads as its value, capitalised, an underscore a space. */
function named(value: string): QualifierOption {
  const words = value.replace(/_/g, " ")
  return { value, label: words.charAt(0).toUpperCase() + words.slice(1) }
}

/** The keys a query can sort by, as the picker offers them. `id` still
 * works typed; it is not offered, an id being opaque (docs/graph-storage.md). */
const SORT_KEYS = ["title", "updated_at"]

/**
 * The `sort:` rows, in two steps. Before a colon in the partial, the keys
 * (Title, Updated at): a pick writes the key and a colon and keeps the
 * picker open. After one (`title:`), the directions for that key, spelt
 * out and written in full (`title:asc`, `title:desc`) — the arrows say
 * which. An unknown key has no directions to offer.
 */
export function sortQualifierOptions(partial: string): QualifierOption[] {
  const colon = partial.indexOf(":")
  if (colon === -1) return SORT_KEYS.map((key) => ({ ...named(key), partial: true }))
  const key = partial.slice(0, colon).toLowerCase()
  if (!SORT_KEYS.includes(key)) return []
  return [
    { value: `${key}:asc`, label: "Ascending", glyph: "↑" },
    { value: `${key}:desc`, label: "Descending", glyph: "↓" },
  ]
}

/** The `date:` rows: the slash menu's date shortcuts (Today, Tomorrow, …
 * — `dateShortcuts`, the one source for both), each resolved to the day it
 * means right now. The day is what lands in the query, as the slash menu
 * writes a day into a note; the row reads as the word. */
export function dateQualifierOptions(now: Date = new Date()): QualifierOption[] {
  return dateShortcuts(now).map((shortcut) => ({ value: shortcut.date, label: shortcut.label }))
}

/** The keys the picker opens for: the static sets above, the one built on
 * demand (`date:` — today's dates) and the one the corpus supplies (`in:` —
 * notes). */
export const SUGGESTED_QUALIFIER_KEYS: readonly string[] = [
  ...Object.keys(STATIC_QUALIFIER_OPTIONS),
  "sort",
  "date",
  "in",
]
