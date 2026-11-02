import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"
import type { ReminderBody, ReminderSettings, ReminderTestResult } from "./reminders-api"

/**
 * Habit reminders on this device (docs/reminders.md): a push when today's
 * habits are not all logged by a time the reader chose. The browser half —
 * the permission, the push subscription and the calls to `/api/reminders`;
 * the service worker shows the push (src/sw.ts) and the Worker's cron sends
 * it (worker/reminders/cron.ts).
 *
 * A reminder belongs to a subscription, and a subscription to one browser on
 * one device, so the setting is per device: the server holds it, keyed by
 * the subscription's endpoint.
 */

export const DEFAULT_REMINDER_TIME = "20:00"

/** Why turning reminders on did not work, for the card to say. */
export type ReminderFailure = "unsupported" | "denied" | "not-configured" | "failed"

export class ReminderError extends Error {
  constructor(readonly reason: ReminderFailure) {
    super(reason)
    this.name = "ReminderError"
  }
}

/** The time zone this browser is in, as an IANA name. */
export const deviceTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** Whether this browser can take a push at all. On an iPhone only a Home
 * Screen app can (iOS 16.4 and later). */
export const pushSupported = (): boolean =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window

/** How long to wait for the service worker before giving up: it never
 * comes where none is registered. */
const READY_TIMEOUT_MS = 10_000

async function registration(): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    window.setTimeout(() => reject(new ReminderError("unsupported")), READY_TIMEOUT_MS),
  )
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

/** This browser's push subscription, or null. */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  return (await registration()).pushManager.getSubscription()
}

async function request(path: string, init: RequestInit): Promise<Response> {
  await ensureFreshToken()
  return withAuthRetry(async () => {
    const token = getAccessToken()
    if (!token) throw Object.assign(new Error("Not signed in."), { status: 401 })
    const res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    })
    if (res.status === 401) {
      throw Object.assign(new Error("Reminders request rejected (401)"), { status: 401 })
    }
    return res
  })
}

async function readServer(endpoint: string | null): Promise<ReminderBody> {
  const query = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ""
  const res = await request(`/api/reminders${query}`, { method: "GET" })
  if (!res.ok) throw new ReminderError("failed")
  return (await res.json()) as ReminderBody
}

/** What the card shows: whether push is set up on the server, and this
 * device's reminder, when it has one. */
export async function loadReminder(): Promise<{
  configured: boolean
  reminder: ReminderSettings | null
}> {
  const subscription = await currentSubscription()
  const body = await readServer(subscription?.endpoint ?? null)
  return { configured: body.publicKey !== null, reminder: body.reminder }
}

const keyBytes = (base64Url: string): Uint8Array<ArrayBuffer> => {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

const sameKey = (key: ArrayBuffer | null, expected: Uint8Array): boolean => {
  if (key === null || key.byteLength !== expected.byteLength) return false
  const bytes = new Uint8Array(key)
  return bytes.every((byte, at) => byte === expected[at])
}

async function save(
  subscription: PushSubscription,
  reminderTime: string,
): Promise<ReminderSettings> {
  const res = await request("/api/reminders", {
    method: "PUT",
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      reminderTime,
      timeZone: deviceTimeZone(),
    }),
  })
  if (res.status === 501) throw new ReminderError("not-configured")
  if (!res.ok) throw new ReminderError("failed")
  const body = (await res.json()) as ReminderBody
  if (body.reminder === null) throw new ReminderError("failed")
  return body.reminder
}

/**
 * Turn reminders on for this device: ask for permission, subscribe with the
 * server's VAPID key (a subscription made with another key is replaced),
 * and save it with the reminder time and this browser's time zone.
 */
export async function enableReminders(reminderTime: string): Promise<ReminderSettings> {
  if (!pushSupported()) throw new ReminderError("unsupported")
  const permission = await Notification.requestPermission()
  if (permission !== "granted") throw new ReminderError("denied")
  const { publicKey } = await readServer(null)
  if (publicKey === null) throw new ReminderError("not-configured")
  const applicationServerKey = keyBytes(publicKey)
  const { pushManager } = await registration()
  let subscription = await pushManager.getSubscription()
  if (subscription && !sameKey(subscription.options.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
  return save(subscription, reminderTime)
}

/** Change this device's reminder time; the time zone is read again. */
export async function saveReminderTime(reminderTime: string): Promise<ReminderSettings> {
  const subscription = await currentSubscription()
  if (subscription === null) throw new ReminderError("failed")
  return save(subscription, reminderTime)
}

/** Turn reminders off for this device: delete the subscription on the
 * server, then in the browser. */
export async function disableReminders(): Promise<void> {
  const subscription = await currentSubscription()
  if (subscription === null) return
  const res = await request("/api/reminders", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  })
  if (!res.ok) throw new ReminderError("failed")
  await subscription.unsubscribe()
}

/**
 * Send a test reminder to this device now: the cron's check, run for the
 * reader at once, sent even when every habit is logged. When the push
 * service says the subscription is gone, the server has deleted it and the
 * browser's copy goes too.
 */
export async function sendTestReminder(): Promise<ReminderTestResult> {
  const subscription = await currentSubscription()
  if (subscription === null) throw new ReminderError("failed")
  const res = await request("/api/reminders/test", {
    method: "POST",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  })
  if (res.status === 501) throw new ReminderError("not-configured")
  if (res.status === 404) throw new ReminderError("failed")
  const result = (await res.json()) as ReminderTestResult
  if (result.outcome === "gone") await subscription.unsubscribe()
  return result
}
