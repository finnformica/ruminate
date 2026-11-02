// `/api/reminders` — the settings card's half of habit reminders
// (docs/reminders.md). Session-guarded, like every browser route.
//
// - `GET ?endpoint=<url>`: whether push is set up here (`publicKey`, null
//   when not), and this device's reminder, when it has one.
// - `PUT { subscription, reminderTime, timeZone }`: save this device's
//   subscription and its reminder.
// - `DELETE { endpoint }`: turn this device's reminders off.
// - `POST /test { endpoint }`: run the cron's check for the caller now and
//   send the result to this device, even when every habit is logged (the
//   body says so). Cron does not run on preview versions; this does.

import {
  DEFAULT_REMINDER_TIME,
  isTimeZone,
  localClock,
  reminderMinutes,
} from "../reminders/schedule"
import { checkHabits } from "../reminders/habits"
import { reminderMessage } from "../reminders/message"
import { sendPush, vapidKeys } from "../reminders/push"
import {
  deleteSubscription,
  saveSubscription,
  subscriptionOf,
  type Subscription,
} from "../reminders/store"
import { controlPlaneDriver, corpusDriver, forTenant } from "../tenancy-db"
import type { Env } from "../types"
import { requireSession } from "./replica"
import type {
  ReminderBody,
  ReminderSettings,
  ReminderTestResult,
} from "../../src/data/reminders-api"

export const REMINDERS_PATH = "/api/reminders"
const TEST_PATH = `${REMINDERS_PATH}/test`

/** Push service endpoints are URLs well under this. */
const MAX_ENDPOINT_LENGTH = 1024
const MAX_KEY_LENGTH = 256

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const isEndpoint = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > MAX_ENDPOINT_LENGTH) return false
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

const isKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_KEY_LENGTH

const settingsOf = (subscription: Subscription | null): ReminderSettings | null =>
  subscription && {
    reminderTime: subscription.reminderTime,
    timeZone: subscription.timeZone,
    lastSentDay: subscription.lastSentDay,
  }

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const raw = (await request.json().catch(() => null)) as unknown
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null
}

export async function reminders(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session
  const { pathname, searchParams } = new URL(request.url)
  const control = controlPlaneDriver(env)
  const keys = vapidKeys(env)

  if (pathname === REMINDERS_PATH && request.method === "GET") {
    const endpoint = searchParams.get("endpoint")
    const held = isEndpoint(endpoint) ? await subscriptionOf(control, session.id, endpoint) : null
    const body: ReminderBody = { publicKey: keys?.publicKey ?? null, reminder: settingsOf(held) }
    return json(body)
  }

  if (pathname === REMINDERS_PATH && request.method === "PUT") {
    if (keys === null) return json({ error: "push_not_configured" }, 501)
    const raw = await readBody(request)
    const subscription = raw?.subscription as
      { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined
    const endpoint = subscription?.endpoint
    const p256dh = subscription?.keys?.p256dh
    const auth = subscription?.keys?.auth
    const reminderTime = raw?.reminderTime ?? DEFAULT_REMINDER_TIME
    const timeZone = raw?.timeZone
    if (!isEndpoint(endpoint) || !isKey(p256dh) || !isKey(auth)) {
      return json({ error: "invalid_subscription" }, 400)
    }
    if (typeof reminderTime !== "string" || reminderMinutes(reminderTime) === null) {
      return json({ error: "invalid_time" }, 400)
    }
    if (typeof timeZone !== "string" || !isTimeZone(timeZone)) {
      return json({ error: "invalid_time_zone" }, 400)
    }
    const saved = await saveSubscription(
      control,
      { endpoint, userId: session.id, p256dh, auth, reminderTime, timeZone },
      now,
    )
    const body: ReminderBody = { publicKey: keys.publicKey, reminder: settingsOf(saved) }
    return json(body)
  }

  if (pathname === REMINDERS_PATH && request.method === "DELETE") {
    const endpoint = (await readBody(request))?.endpoint
    if (!isEndpoint(endpoint)) return json({ error: "invalid_subscription" }, 400)
    await deleteSubscription(control, endpoint, session.id)
    return new Response(null, { status: 204 })
  }

  if (pathname === TEST_PATH && request.method === "POST") {
    if (keys === null) return json({ error: "push_not_configured" }, 501)
    const endpoint = (await readBody(request))?.endpoint
    if (!isEndpoint(endpoint)) return json({ error: "invalid_subscription" }, 400)
    const held = await subscriptionOf(control, session.id, endpoint)
    if (held === null) return json({ error: "not_subscribed" }, 404)
    const day = localClock(now, held.timeZone).day
    const tenant = forTenant(corpusDriver(env), session)
    const { habits, missing } = await checkHabits(tenant, day)
    const message = reminderMessage(habits, missing, { test: true })
    const { outcome, status } = await sendPush(keys, held, message, fetchImpl)
    // A gone subscription is deleted, as the cron does; the card turns off.
    if (outcome === "gone") await deleteSubscription(control, endpoint, session.id)
    const body: ReminderTestResult = { outcome, status, body: message.body }
    return json(body, outcome === "sent" ? 200 : outcome === "gone" ? 410 : 502)
  }

  return json({ error: "method_not_allowed" }, 405)
}
