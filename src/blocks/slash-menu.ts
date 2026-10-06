import { parse as chronoParse } from "chrono-node"
import { addDays, addWeeks, startOfISOWeek } from "date-fns"
import { formatDate, formatDateDistance, toDateString } from "../utils/date"
import { BLOCK_TYPE_DEFS, type BlockTypeDef } from "./registry"
import type { BlockType } from "./types"

/**
 * The block editor's **slash menu**: typing `/` at the start of a word opens
 * a picker over the caret with three groups — **dates** (Today, Tomorrow, …
 * or anything the phrase after the `/` resolves to, "friday next week"),
 * **turn into** (the block types) and **insert** (the actions that put
 * something at the row rather than retyping it: a board, docs/boards.md).
 * Picking a date replaces the `/phrase` with the date; picking a type swaps
 * the block's marker and drops the `/phrase`; picking an action drops the
 * `/phrase` and hands the editor the action to carry out.
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

/** A fixed date row, resolved for `now`: its label, the day it means as
 * `YYYY-MM-DD`, and that day formatted for the row's detail. */
export interface DateShortcut {
  label: string
  date: string
  detail: string
}

/**
 * The fixed date shortcuts, resolved for `now` — the ONE source for every
 * picker that offers them: the slash menu's date rows and the query box's
 * `date:` suggestions (src/utils/qualifier-suggestions.ts), so the two
 * never drift in wording or in which day "Next week" means.
 */
export function dateShortcuts(now: Date): DateShortcut[] {
  return DATE_OPTIONS.map((option) => {
    const date = toDateString(option.resolve(now))
    return { label: option.label, date, detail: formatDate(date) }
  })
}

// ── Block types ─────────────────────────────────────────────────────────────

/** The rows under "Turn into": every type the registry offers, in its
 * order — the type changes, plus the ones that ask for something (an image
 * asks for a file) where their context allows. */
const BLOCK_OPTIONS: readonly BlockTypeDef[] = BLOCK_TYPE_DEFS.filter(
  (def) => def.turnInto || def.slash,
)

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * What an action row asks the editor to do at the row (docs/boards.md, "A
 * board in a note"): `board` makes a new board and links it where the row
 * is; `linkBoard` links a board that already exists there. Neither is a
 * type change — the row's `/phrase` goes and the editor opens the dialog
 * that finishes the job, as the image row asks for a file.
 */
type SlashAction = "board" | "linkBoard"

interface ActionOption {
  action: SlashAction
  label: string
  keywords: string[]
}

/** The rows under "Insert", offered where the editor has a note of the
 * reader's own behind it (`options.boards`). */
const ACTION_OPTIONS: readonly ActionOption[] = [
  { action: "board", label: "Board", keywords: ["board", "new board"] },
  {
    action: "linkBoard",
    label: "Link board",
    keywords: ["link board", "existing board", "add board"],
  },
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
  | { kind: "action"; id: string; label: string; action: SlashAction }

export type SlashGroup = "Dates" | "Turn into" | "Insert"

export function slashGroupOf(item: SlashItem): SlashGroup {
  switch (item.kind) {
    case "date":
      return "Dates"
    case "block":
      return "Turn into"
    case "action":
      return "Insert"
  }
}

/** Word-prefix match: `/tom` finds Tomorrow, `/list` finds both lists. */
function matches(query: string, label: string, keywords: string[] = []): boolean {
  if (query === "") return true
  const candidates = [label, label.replace(/-/g, ""), ...label.split(/\s+/), ...keywords]
  return candidates.some((candidate) => candidate.toLowerCase().startsWith(query))
}

/**
 * The rows for a query: the fixed dates it matches, then the date its phrase
 * resolves to (when that isn't already listed), then the block types, then
 * the actions (where `boards` allows them). Empty when nothing matches —
 * the caller closes the menu and the text stays as typed.
 */
export function slashMenuItems(
  query: string,
  now: Date,
  options: { images?: boolean; boards?: boolean } = {},
): SlashItem[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ")
  const items: SlashItem[] = []

  for (const shortcut of dateShortcuts(now)) {
    if (!matches(q, shortcut.label)) continue
    items.push({
      kind: "date",
      id: `date:${shortcut.label}`,
      label: shortcut.label,
      detail: shortcut.detail,
      date: shortcut.date,
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

  const context = { images: options.images ?? false }
  for (const def of BLOCK_OPTIONS) {
    if (!def.turnInto && def.slash && !def.slash(context)) continue
    if (!matches(q, def.label, [...def.keywords])) continue
    items.push({ kind: "block", id: `block:${def.id}`, label: def.label, type: def.id })
  }

  if (options.boards) {
    for (const option of ACTION_OPTIONS) {
      if (!matches(q, option.label, option.keywords)) continue
      items.push({
        kind: "action",
        id: `action:${option.action}`,
        label: option.label,
        action: option.action,
      })
    }
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
  /** What the editor is to do at the row, when the pick was an action. */
  action?: SlashAction
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
 * - An action removes the `/phrase` and names the action, caret where the
 *   `/` was; the editor carries it out.
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
  if (item.kind === "action") {
    return { text: before + after, action: item.action, caret: trigger.start }
  }
  return { text: before + after, type: item.type, caret: trigger.start }
}
