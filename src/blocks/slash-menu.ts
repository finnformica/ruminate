import { parse as chronoParse } from "chrono-node"
import { addDays, addWeeks, startOfISOWeek } from "date-fns"
import { formatDate, formatDateDistance, toDateString } from "../utils/date"
import type { BlockType } from "./types"

/**
 * The block editor's **slash menu**: typing `/` at the start of a word opens
 * a picker over the caret with two groups — **dates** (Today, Tomorrow, … or
 * anything the phrase after the `/` resolves to, "friday next week") and
 * **turn into** (the block types). Picking a date replaces the `/phrase` with
 * the date; picking a type swaps the block's marker and drops the `/phrase`.
 *
 * Everything here is pure and DOM-free — the textarea's text and caret come
 * in, a menu model or a new content string comes out — so the grammar and the
 * filtering are unit-tested without the editor. `block-item.tsx` owns the
 * transient state (which item is highlighted) and the rendering.
 */

export interface SlashTrigger {
  /** Index of the `/` in the visible (marker-stripped) body text. */
  start: number
  /** The text between the `/` and the caret. */
  query: string
}

/** A phrase longer than this is prose, not a command — the menu closes. */
const MAX_QUERY = 40

/**
 * Whether the caret sits inside an open `/…` command: a `/` at the start of
 * the text or after whitespace (so `and/or` and `https://` never trigger),
 * with the caret on the same line after it. A space typed directly after the
 * `/` closes it — that is the way to type a literal slash.
 */
export function findSlashTrigger(value: string, caret: number): SlashTrigger | null {
  const before = value.slice(0, caret)
  const start = before.lastIndexOf("/")
  if (start === -1) return null
  if (start > 0 && !/\s/.test(before[start - 1])) return null
  const query = before.slice(start + 1)
  if (query.length > MAX_QUERY || /^\s/.test(query) || query.includes("\n")) return null
  return { start, query }
}

// ── Dates ───────────────────────────────────────────────────────────────────

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

/** `friday` / `fri` → 5; anything else → -1. */
function weekdayIndex(name: string): number {
  if (name.length < 3) return -1
  return WEEKDAYS.findIndex((day) => day.startsWith(name))
}

/** The given weekday of the ISO week after `now`'s (Monday-first). */
function weekdayOfNextWeek(now: Date, weekday: number): Date {
  const monday = startOfISOWeek(addWeeks(now, 1))
  return addDays(monday, (weekday + 6) % 7)
}

/** `next week on friday`, `next week friday`, `friday next week`, `friday of
 * next week` — the one family chrono gets wrong (it reads "next week" and
 * drops the day), so it is resolved here first. */
const NEXT_WEEK_ON_RE = /^(?:next week (?:on )?([a-z]+)|([a-z]+) (?:of )?next week)$/

/**
 * Resolve a natural-language phrase ("tomorrow", "friday next week", "in 2
 * weeks", "1 oct") to a date, or null when it isn't one. Deliberately strict:
 * chrono is only trusted when it consumed the *whole* phrase and pinned it to
 * a day, so `march notes` and a bare `may` stay text rather than becoming a
 * surprise date.
 */
export function parseDateShortcut(query: string, now: Date): Date | null {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ")
  if (phrase === "") return null

  const nextWeekOn = NEXT_WEEK_ON_RE.exec(phrase)
  if (nextWeekOn) {
    const weekday = weekdayIndex(nextWeekOn[1] ?? nextWeekOn[2])
    if (weekday !== -1) return weekdayOfNextWeek(now, weekday)
  }

  const results = chronoParse(phrase, now)
  if (results.length !== 1) return null
  const [result] = results
  if (result.text.toLowerCase() !== phrase) return null
  const anchored =
    result.start.isCertain("day") ||
    result.start.isCertain("weekday") ||
    /\b(next|last|this|in|ago)\b/.test(phrase)
  if (!anchored) return null
  return result.start.date()
}

interface DateOption {
  label: string
  resolve: (today: Date) => Date
}

/** The fixed date rows, shown (filtered) whenever the menu is open. */
const DATE_OPTIONS: DateOption[] = [
  { label: "Today", resolve: (today) => today },
  { label: "Tomorrow", resolve: (today) => addDays(today, 1) },
  { label: "Yesterday", resolve: (today) => addDays(today, -1) },
  { label: "Next week", resolve: (today) => addDays(today, 7) },
  { label: "Last week", resolve: (today) => addDays(today, -7) },
]

// ── Block types ─────────────────────────────────────────────────────────────

interface BlockOption {
  type: BlockType
  label: string
  /** Extra words the row answers to (`/task` finds To-do). */
  keywords: string[]
}

const BLOCK_OPTIONS: BlockOption[] = [
  { type: "text", label: "Text", keywords: ["paragraph", "plain"] },
  { type: "ul", label: "Bullet list", keywords: ["unordered", "ul", "bullet"] },
  { type: "ol", label: "Numbered list", keywords: ["ordered", "ol", "numbered"] },
  { type: "todo", label: "To-do", keywords: ["todo", "task", "checkbox"] },
  { type: "h1", label: "Heading", keywords: ["header", "h1", "heading"] },
  { type: "quote", label: "Quote", keywords: ["blockquote", "callout"] },
]

// ── The menu model ──────────────────────────────────────────────────────────

export type SlashItem =
  | {
      kind: "date"
      /** Stable per row, for React keys and tests. */
      id: string
      label: string
      /** The resolved date, formatted — so the row says which day you'll get. */
      detail: string
      /** The resolved day as `YYYY-MM-DD` (the app's canonical form). */
      date: string
    }
  | { kind: "block"; id: string; label: string; type: BlockType }

export type SlashGroup = "Dates" | "Turn into"

export function slashGroupOf(item: SlashItem): SlashGroup {
  return item.kind === "date" ? "Dates" : "Turn into"
}

/** Word-prefix match: `/tom` finds Tomorrow, `/list` finds both lists. */
function matches(query: string, label: string, keywords: string[] = []): boolean {
  if (query === "") return true
  const candidates = [label, label.replace(/-/g, ""), ...label.split(/\s+/), ...keywords]
  return candidates.some((candidate) => candidate.toLowerCase().startsWith(query))
}

/**
 * The rows for a query: the fixed dates it matches, then the date its phrase
 * resolves to (when that isn't already listed), then the block types. Empty
 * when nothing matches — the caller closes the menu and the text stays as
 * typed.
 */
export function slashMenuItems(query: string, now: Date): SlashItem[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ")
  const items: SlashItem[] = []

  for (const option of DATE_OPTIONS) {
    if (!matches(q, option.label)) continue
    const date = toDateString(option.resolve(now))
    items.push({
      kind: "date",
      id: `date:${option.label}`,
      label: option.label,
      detail: formatDate(date),
      date,
    })
  }

  const parsed = q === "" ? null : parseDateShortcut(q, now)
  if (parsed) {
    const date = toDateString(parsed)
    if (!items.some((item) => item.kind === "date" && item.date === date)) {
      items.push({
        kind: "date",
        id: "date:parsed",
        label: formatDate(date),
        detail: formatDateDistance(date, now),
        date,
      })
    }
  }

  for (const option of BLOCK_OPTIONS) {
    if (!matches(q, option.label, option.keywords)) continue
    items.push({
      kind: "block",
      id: `block:${option.type}`,
      label: option.label,
      type: option.type,
    })
  }

  return items
}

// ── Applying a pick ─────────────────────────────────────────────────────────

/** The form a picked date is written into the note: `dd-mm-yyyy`. */
export function toInsertedDate(date: string): string {
  const [year, month, day] = date.split("-")
  return `${day}-${month}-${year}`
}

export interface SlashApplyResult {
  /** The block's new text. */
  text: string
  /** The block's new type, when the pick was a "turn into". */
  type?: BlockType
  /** Where the caret lands, as an offset into the new text. */
  caret: number
}

/**
 * Apply a picked row to the block. `text` is the block's text the trigger was
 * found in; the `/phrase` is the span from the trigger's `/` to the caret.
 *
 * - A date replaces the `/phrase` with the date as `dd-mm-yyyy`, caret after it.
 * - A block type removes the `/phrase` and sets the type, caret where the `/`
 *   was.
 */
export function applySlashItem(
  text: string,
  trigger: SlashTrigger,
  item: SlashItem,
): SlashApplyResult {
  const before = text.slice(0, trigger.start)
  const after = text.slice(trigger.start + 1 + trigger.query.length)
  if (item.kind === "date") {
    const inserted = toInsertedDate(item.date)
    return { text: before + inserted + after, caret: trigger.start + inserted.length }
  }
  return { text: before + after, type: item.type, caret: trigger.start }
}
