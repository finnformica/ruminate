// What a habit reminder says (docs/reminders.md): the payload the service
// worker shows (src/sw.ts) — the app's name as the title (docs/reminders.md,
// The title on each platform), a body that names the habits not yet
// logged in one of four templates, and the page a tap opens.

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

const TITLE = "Ruminate"
const TAG = "habit-reminder"
/** Habits named before the rest are counted. */
const NAMED = 5

/** The bodies a reminder picks from at random; `{habits}` is the list. */
export const TEMPLATES: readonly string[] = [
  "Have you done {habits} today?",
  "Don't forget {habits} today.",
  "Still to log today: {habits}.",
  "Time to log {habits}.",
]

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
 * The reminder for `missing` of `habits`, in a template picked with `random`.
 * A test (the settings button) says it is one, and is sent even when nothing
 * is missing, saying so.
 */
export function reminderMessage(
  habits: readonly Habit[],
  missing: readonly Habit[],
  options: { test?: boolean; random?: () => number } = {},
): ReminderPayload {
  const first = missing[0] ?? habits[0]
  const url = first ? `/trackers/${encodeURIComponent(first.trackerId)}` : "/"
  let body: string
  if (missing.length > 0) {
    const pick = Math.floor((options.random ?? Math.random)() * TEMPLATES.length)
    const template = TEMPLATES[Math.min(pick, TEMPLATES.length - 1)]
    body = template.replace("{habits}", listOf(missing))
  } else if (habits.length > 0) body = "All your habits are logged today."
  else body = "No habits yet. Add a series to a tracker to start."
  if (options.test) body = `Test reminder. ${body}`
  return { title: TITLE, body, url, tag: TAG }
}
