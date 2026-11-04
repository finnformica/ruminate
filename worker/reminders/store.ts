// The push subscriptions (migrations/0033, docs/reminders.md): control
// plane, reached through `controlPlaneDriver`. Every statement a handler
// runs names the signed-in user; the cron's selection is the one that reads
// across users, and it reads only the rows that are due.

import type { SqlDriver, SqlValue } from "../../src/data/sql-driver"
import { nextDueAt, type ReminderSchedule } from "./schedule"

/** A push subscription and its reminder. */
export interface Subscription extends ReminderSchedule {
  endpoint: string
  userId: number
  p256dh: string
  auth: string
  nextDueAt: number
}

const COLUMNS =
  "endpoint, user_id, p256dh, auth, reminder_time, time_zone, last_sent_day, next_due_at"

const toSubscription = (row: Record<string, SqlValue>): Subscription => ({
  endpoint: String(row.endpoint),
  userId: Number(row.user_id),
  p256dh: String(row.p256dh),
  auth: String(row.auth),
  reminderTime: String(row.reminder_time),
  timeZone: String(row.time_zone),
  lastSentDay: typeof row.last_sent_day === "string" ? row.last_sent_day : null,
  nextDueAt: Number(row.next_due_at),
})

/** The user's subscription at `endpoint`, or null. */
export async function subscriptionOf(
  driver: SqlDriver,
  userId: number,
  endpoint: string,
): Promise<Subscription | null> {
  const [row] = await driver.exec(
    `SELECT ${COLUMNS} FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2`,
    [endpoint, userId],
  )
  return row ? toSubscription(row) : null
}

/** Every subscription of the user, oldest first: the devices a test
 * reminder goes to. */
export async function subscriptionsOf(driver: SqlDriver, userId: number): Promise<Subscription[]> {
  const rows = await driver.exec(
    `SELECT ${COLUMNS} FROM push_subscriptions WHERE user_id = ?1 ORDER BY created_at, endpoint`,
    [userId],
  )
  return rows.map(toSubscription)
}

/**
 * Save a subscription and its reminder for the user. A subscription saved
 * again keeps the day it last dealt with, so a change of time does not send
 * today's reminder twice; one another account held starts afresh.
 */
export async function saveSubscription(
  driver: SqlDriver,
  input: Omit<Subscription, "lastSentDay" | "nextDueAt">,
  now: number,
): Promise<Subscription> {
  const [held] = await driver.exec(
    "SELECT user_id, last_sent_day FROM push_subscriptions WHERE endpoint = ?1",
    [input.endpoint],
  )
  const lastSentDay =
    held && Number(held.user_id) === input.userId && typeof held.last_sent_day === "string"
      ? held.last_sent_day
      : null
  const saved: Subscription = { ...input, lastSentDay, nextDueAt: 0 }
  saved.nextDueAt = nextDueAt(saved, now)
  await driver.exec(
    `INSERT INTO push_subscriptions (${COLUMNS}, created_at, updated_at) ` +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9) " +
      "ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, " +
      "p256dh = excluded.p256dh, auth = excluded.auth, " +
      "reminder_time = excluded.reminder_time, time_zone = excluded.time_zone, " +
      "last_sent_day = excluded.last_sent_day, next_due_at = excluded.next_due_at, " +
      "updated_at = excluded.updated_at",
    [
      saved.endpoint,
      saved.userId,
      saved.p256dh,
      saved.auth,
      saved.reminderTime,
      saved.timeZone,
      saved.lastSentDay,
      saved.nextDueAt,
      now,
    ],
  )
  return saved
}

/** Delete a subscription: the reader turned reminders off, or the push
 * service said it is gone. `userId` scopes a handler's delete to the
 * caller; the cron's delete of a gone endpoint names none. */
export async function deleteSubscription(
  driver: SqlDriver,
  endpoint: string,
  userId?: number,
): Promise<void> {
  if (userId === undefined) {
    await driver.exec("DELETE FROM push_subscriptions WHERE endpoint = ?1", [endpoint])
  } else {
    await driver.exec("DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2", [
      endpoint,
      userId,
    ])
  }
}

/**
 * The subscriptions due at `now`, earliest first, at most `limit`: one seek
 * on `push_subscriptions_due`, so the rows read are the rows due. A blocked
 * account gets no reminder (one primary-key seek into `users` per row).
 */
export async function dueSubscriptions(
  driver: SqlDriver,
  now: number,
  limit: number,
): Promise<Subscription[]> {
  const rows = await driver.exec(
    `SELECT ${COLUMNS.split(", ")
      .map((column) => `p.${column}`)
      .join(", ")} FROM push_subscriptions p ` +
      "WHERE p.next_due_at <= ?1 AND NOT EXISTS (SELECT 1 FROM users u " +
      "WHERE u.github_id = p.user_id AND u.status = 'blocked') " +
      "ORDER BY p.next_due_at LIMIT ?2",
    [now, limit],
  )
  return rows.map(toSubscription)
}

/** Record that the reminder of `day` was dealt with, and when the next is
 * due. */
export async function markDealtWith(
  driver: SqlDriver,
  subscription: Subscription,
  day: string,
  now: number,
): Promise<void> {
  const next = nextDueAt({ ...subscription, lastSentDay: day }, now)
  await driver.exec(
    "UPDATE push_subscriptions SET last_sent_day = ?2, next_due_at = ?3 WHERE endpoint = ?1",
    [subscription.endpoint, day, next],
  )
}

/** Move a row that was selected but is not due (its day was dealt with, or
 * its time has not come on its own clock) to its next due instant. */
export async function reschedule(
  driver: SqlDriver,
  subscription: Subscription,
  now: number,
): Promise<void> {
  await driver.exec("UPDATE push_subscriptions SET next_due_at = ?2 WHERE endpoint = ?1", [
    subscription.endpoint,
    nextDueAt(subscription, now),
  ])
}
