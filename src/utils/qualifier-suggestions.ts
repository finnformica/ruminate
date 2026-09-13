import { searchTypeOptions } from "../blocks/registry"
import { formatDate } from "./date"
import { resolveRelativeDate } from "./search"
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
  /** A short gloss, in the row's trailing slot. */
  description?: string
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
 * types; `has:`/`no:` the countable things; `sort:` the sortable keys, each
 * with the direction it does not default to as a second row (`sort:title`
 * is A→Z, so `title:desc` is offered beside it). `date:` is supplied by
 * `dateQualifierOptions` — its rows carry today's date, so they are built
 * when asked for, not when the module loads.
 */
export const STATIC_QUALIFIER_OPTIONS: Readonly<Record<string, readonly QualifierOption[]>> = {
  type: [
    ...searchTypeOptions(),
    { value: "note", description: "notes: plain notes" },
    { value: "daily", description: "notes: daily" },
    { value: "weekly", description: "notes: weekly" },
    { value: "template", description: "notes: templates" },
  ],
  has: [
    { value: "dates", description: "with any date" },
    { value: "tasks", description: "with an open task" },
    { value: "title", description: "with a title" },
  ],
  no: [
    { value: "dates", description: "without a date" },
    { value: "tasks", description: "without an open task" },
    { value: "title", description: "without a title" },
  ],
  sort: [
    { value: "title", description: "title, A to Z" },
    { value: "title:desc", description: "title, Z to A" },
    { value: "updated_at", description: "most recently updated first" },
    { value: "updated_at:asc", description: "least recently updated first" },
    { value: "id", description: "oldest first" },
    { value: "id:desc", description: "newest first" },
  ],
}

/** The relative dates `date:` offers — the words the query language reads
 * (`resolveRelativeDate`), kept as words so a saved query stays relative. A
 * phrase is spelled with `+` (`next+week`), as the grammar wants it. */
const DATE_SHORTCUTS: readonly string[] = [
  "today",
  "yesterday",
  "tomorrow",
  "last+week",
  "next+week",
]

/** The `date:` rows: each shortcut with the date it means right now. */
export function dateQualifierOptions(): QualifierOption[] {
  return DATE_SHORTCUTS.map((value) => ({
    value,
    description: formatDate(resolveRelativeDate(value)),
  }))
}

/** The keys the picker opens for: the static sets above, the one built on
 * demand (`date:` — today's dates) and the one the corpus supplies (`in:` —
 * notes). */
export const SUGGESTED_QUALIFIER_KEYS: readonly string[] = [
  ...Object.keys(STATIC_QUALIFIER_OPTIONS),
  "date",
  "in",
]
