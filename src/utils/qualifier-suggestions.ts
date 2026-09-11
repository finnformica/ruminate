import { searchTypeOptions } from "../blocks/registry"
/**
 * **Value suggestions for qualifiers.** Typing `type:`, `in:`, `tag:` — any
 * key whose values come from a known set — opens a picker over the search
 * box listing what can go there (`src/components/qualifier-suggestions.tsx`).
 * This module is the DOM-free half: read the qualifier under the caret, list
 * and filter the static vocabularies, and splice a picked value back into
 * the query. The corpus-backed sets (notes for `in:`, tags for `tag:`) are
 * supplied by the hook, which has the atoms.
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
 * over spaces (`in:"reading li`). `sort:` is not offered: its values carry a
 * direction suffix the picker doesn't model.
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
 * types; `has:`/`no:` the countable things; `sort:` is left to the typed
 * form (`sort:title:desc`).
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
    { value: "tags", description: "with any tag" },
    { value: "dates", description: "with any date" },
    { value: "tasks", description: "with an open task" },
    { value: "title", description: "with a title" },
  ],
  no: [
    { value: "tags", description: "without a tag" },
    { value: "dates", description: "without a date" },
    { value: "tasks", description: "without an open task" },
    { value: "title", description: "without a title" },
  ],
}

/** The keys the picker opens for: the static sets above plus the two the
 * corpus supplies (`in:` — notes; `tag:` — tags). */
export const SUGGESTED_QUALIFIER_KEYS: readonly string[] = [
  ...Object.keys(STATIC_QUALIFIER_OPTIONS),
  "in",
  "tag",
]
