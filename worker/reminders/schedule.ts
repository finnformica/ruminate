// When a habit reminder is due (docs/reminders.md): pure functions of a
// subscription's reminder time, its time zone and the clock.
//
// SQLite has no time zones, so the Worker works out each subscription's next
// due instant here (`nextDueAt`) and stores it in `next_due_at`. The cron
// then selects the due rows with one seek, and asks `isDue` once more for
// each, against the local clock, before it reads any notes.
//
// The cron runs every 15 minutes, on the quarter hour. A reminder time is
// rounded down to its quarter (`dueMinutes`): a reminder at 23:50 is due at
// 23:45, the last run of its day, and not at 00:00, a run of the next day.

import { addDays, type DayString } from "../../src/data/tracker"

/** The reminder a reader gets when they choose no time (Finn, 2026-11-02). */
export const DEFAULT_REMINDER_TIME = "20:00"

/** How often the cron runs, in minutes (wrangler.jsonc, `triggers`). */
const CRON_STEP_MINUTES = 15

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** A reminder time, `HH:MM` on a 24-hour clock, as minutes after midnight;
 * null when it is not one. */
export function reminderMinutes(time: string): number | null {
  const match = TIME_RE.exec(time)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

/** The minute of the day the cron sends a reminder set for `time`: the
 * quarter hour at or before it. */
export function dueMinutes(time: string): number {
  const minutes = reminderMinutes(time) ?? (reminderMinutes(DEFAULT_REMINDER_TIME) as number)
  return minutes - (minutes % CRON_STEP_MINUTES)
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** Whether the runtime knows the time zone (an IANA name, `Europe/London`). */
export function isTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 64) return false
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClock(at: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // Some engines write midnight as 24 even with `h23`.
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0")

/** The local day and the minute of that day at the instant `at`. */
export function localClock(at: number, timeZone: string): { day: DayString; minutes: number } {
  const wall = wallClock(at, timeZone)
  return {
    day: `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`,
    minutes: wall.hour * 60 + wall.minute,
  }
}

/** How far the zone's wall clock is ahead of UTC at the instant `at`, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const wall = wallClock(at, timeZone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return asUtc - Math.floor(at / 1000) * 1000
}

/**
 * The instant the zone's clock reads `minutes` after midnight on `day`. Two
 * passes settle the offset across a daylight-saving change; a time that the
 * change skips (01:30 on a spring-forward night in London) lands an hour
 * later, which is the first moment it has passed.
 */
export function zonedInstant(day: DayString, minutes: number, timeZone: string): number {
  const [year, month, date] = day.split("-").map(Number)
  const wall = Date.UTC(year, month - 1, date) + minutes * 60_000
  const first = wall - offsetAt(wall, timeZone)
  return wall - offsetAt(first, timeZone)
}

/** What the schedule reads of a subscription. */
export interface ReminderSchedule {
  reminderTime: string
  timeZone: string
  /** The local day the reminder was last dealt with: sent, or checked with
   * nothing missing. Null before the first. */
  lastSentDay: string | null
}

/** Whether the reminder is due at `now`: its time has passed on the local
 * clock, and today's has not been dealt with. */
export function isDue(schedule: ReminderSchedule, now: number): boolean {
  const { day, minutes } = localClock(now, schedule.timeZone)
  const done = schedule.lastSentDay !== null && schedule.lastSentDay >= day
  return !done && minutes >= dueMinutes(schedule.reminderTime)
}

/**
 * The instant the next reminder is due: today's when today's has not been
 * dealt with (in the past when its time has passed, so the next run picks
 * it up), else tomorrow's.
 */
export function nextDueAt(schedule: ReminderSchedule, now: number): number {
  const { day } = localClock(now, schedule.timeZone)
  const done = schedule.lastSentDay !== null && schedule.lastSentDay >= day
  return zonedInstant(
    done ? addDays(day, 1) : day,
    dueMinutes(schedule.reminderTime),
    schedule.timeZone,
  )
}
