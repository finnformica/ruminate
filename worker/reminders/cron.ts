// The reminders cron (docs/reminders.md): every 15 minutes (wrangler.jsonc,
// `triggers`), send one push to each subscription whose reminder is due and
// whose reader has a habit not yet logged today.
//
// The cost scales with the subscriptions due, not with the data:
//
// 1. one seek on `push_subscriptions_due` for the rows due now;
// 2. for each (user, local day) among them, the two indexed reads of
//    `checkHabits` (worker/reminders/habits.ts) through that user's tenant
//    handle;
// 3. one write per row: the day dealt with and the next due instant.
//
// Each run logs one line with what it did and the D1 `rows_read` it cost.

import type { DayString } from "../../src/data/tracker"
import { forSubscriber, meteredDriver } from "../tenancy-db"
import type { Env } from "../types"
import { checkHabits } from "./habits"
import { reminderMessage } from "./message"
import { sendPush, vapidKeys } from "./push"
import { isDue, localClock } from "./schedule"
import {
  deleteSubscription,
  dueSubscriptions,
  markDealtWith,
  reschedule,
  type Subscription,
} from "./store"

/** Rows due in one run, at most; the rest wait for the next. */
const RUN_LIMIT = 200

/** What one run did. */
export interface ReminderRun {
  due: number
  checked: number
  sent: number
  gone: number
  failed: number
  rowsRead: number
}

export async function runReminders(
  env: Env,
  now: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<ReminderRun> {
  const run: ReminderRun = { due: 0, checked: 0, sent: 0, gone: 0, failed: 0, rowsRead: 0 }
  const keys = await vapidKeys(env)
  if (keys === null) return run
  const driver = meteredDriver(env, (rowsRead) => {
    run.rowsRead += rowsRead
  })

  const rows = await dueSubscriptions(driver, now, RUN_LIMIT)
  run.due = rows.length

  // One check per reader and local day: two devices of one reader in one
  // time zone share it.
  const groups = new Map<string, { userId: number; day: DayString; rows: Subscription[] }>()
  for (const row of rows) {
    if (!isDue(row, now)) {
      await reschedule(driver, row, now)
      continue
    }
    const day = localClock(now, row.timeZone).day
    const key = `${row.userId}\x1f${day}`
    const group = groups.get(key) ?? { userId: row.userId, day, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }

  for (const { userId, day, rows: due } of groups.values()) {
    run.checked += 1
    const { habits, missing } = await checkHabits(forSubscriber(driver, userId), day)
    for (const row of due) {
      if (missing.length > 0) {
        const { outcome } = await sendPush(keys, row, reminderMessage(habits, missing), fetchImpl)
        if (outcome === "gone") {
          run.gone += 1
          await deleteSubscription(driver, row.endpoint)
          continue
        }
        if (outcome === "sent") run.sent += 1
        else run.failed += 1
      }
      // Dealt with for the day, sent or not: a failure is not retried every
      // 15 minutes until midnight.
      await markDealtWith(driver, row, day, now)
    }
  }

  console.log(JSON.stringify({ event: "habit_reminders", ...run }))
  return run
}
