// What a habit reminder says (docs/reminders.md): the payload the service
// worker shows (src/sw.ts) — a title, a body that names the habits not yet
// logged, and the page a tap opens.

import type { Habit } from "./habits"

/** The payload the push carries, read by the service worker's `push`. */
export interface ReminderPayload {
  title: string
  body: string
  /** The page a tap on the notification opens. */
  url: string
  /** One reminder replaces the one before it on the device. */
  tag: string
}

const TITLE = "Today's habits"
const TAG = "habit-reminder"
/** Habits named before the rest are counted. */
const NAMED = 5

const nameOf = (habit: Habit): string => habit.name.trim() || "Untitled"

/** The habits as a list: "Read, Run and Walk", or "Read, Run, … and 3 more". */
function listOf(habits: readonly Habit[]): string {
  const names = habits.slice(0, NAMED).map(nameOf)
  const rest = habits.length - names.length
  if (rest > 0) return `${names.join(", ")} and ${rest} more`
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/**
 * The reminder for `missing` of `habits`. A test (the settings button) says
 * it is one, and is sent even when nothing is missing, saying so.
 */
export function reminderMessage(
  habits: readonly Habit[],
  missing: readonly Habit[],
  options: { test?: boolean } = {},
): ReminderPayload {
  const first = missing[0] ?? habits[0]
  const url = first ? `/trackers/${encodeURIComponent(first.trackerId)}` : "/"
  let body: string
  if (missing.length > 0) body = `Not logged yet: ${listOf(missing)}.`
  else if (habits.length > 0) body = "All habits for today are logged."
  else body = "You have no habits to log. Add a series to a tracker."
  if (options.test) body = `Test reminder. ${body}`
  return { title: TITLE, body, url, tag: TAG }
}
