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

/** Why a step did not work, for the card to say (FAILURE in
 * src/components/settings/reminders-section.tsx). */
export type ReminderFailure =
  /** No push in this browser. */
  | "unsupported"
  /** Notifications are blocked for the site. */
  | "denied"
  /** The permission prompt was closed with no answer. */
  | "dismissed"
  /** The Worker has no VAPID keys. */
  | "not-configured"
  /** `pushManager.subscribe` threw `AbortError`: the browser's push service
   * refused or is off (Brave without "Use Google services for push
   * messaging", a network that blocks the push service). */
  | "push-blocked"
  /** No service worker came within READY_TIMEOUT_MS. */
  | "worker-missing"
  /** The service worker could not subscribe and a newer one is waiting:
   * the build in control predates reminders. */
  | "worker-outdated"
  /** This browser holds no subscription, or the server has none for it. */
  | "unsubscribed"
  /** The GitHub session ended and could not be refreshed. */
  | "signed-out"
  /** The server answered with an error; `detail` is its status and code. */
  | "rejected"
  /** The request did not reach the server. */
  | "offline"
  /** Anything else; `detail` is the error's name. */
  | "failed"

export class ReminderError extends Error {
  constructor(
    readonly reason: ReminderFailure,
    readonly detail?: string,
    options?: { cause?: unknown },
  ) {
    super(detail ? `${reason}: ${detail}` : reason, options)
    this.name = "ReminderError"
  }
}

const errorName = (error: unknown): string =>
  error instanceof Error || error instanceof DOMException ? error.name : typeof error

/** Any error from the reminder calls as a ReminderError, with the original
 * as its `cause`. */
export function reminderErrorOf(error: unknown): ReminderError {
  if (error instanceof ReminderError) return error
  const status = (error as { status?: unknown } | null)?.status
  if (errorName(error) === "SessionExpiredError" || status === 401) {
    return new ReminderError("signed-out", undefined, { cause: error })
  }
  if (typeof status === "number") {
    return new ReminderError("rejected", String(status), { cause: error })
  }
  // fetch rejects with a TypeError when the request never reaches the server.
  if (error instanceof TypeError) return new ReminderError("offline", undefined, { cause: error })
  return new ReminderError("failed", errorName(error), { cause: error })
}

/** The error `pushManager.subscribe` threw, as a ReminderError. The names
 * are the Push API's (https://w3c.github.io/push-api/#subscribe-method). */
function subscribeErrorOf(error: unknown, registration: ServiceWorkerRegistration): ReminderError {
  const name = errorName(error)
  const reason: ReminderFailure | null =
    name === "AbortError"
      ? "push-blocked"
      : name === "NotAllowedError"
        ? "denied"
        : name === "InvalidStateError" || registration.waiting !== null
          ? "worker-outdated"
          : null
  return reason
    ? new ReminderError(reason, undefined, { cause: error })
    : new ReminderError("failed", name, { cause: error })
}

/** A response that is not ok, as a ReminderError: its status and the
 * error code in its body, when it has one. */
async function rejection(res: Response): Promise<ReminderError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  const code = typeof body?.error === "string" ? ` ${body.error}` : ""
  return new ReminderError("rejected", `${res.status}${code}`)
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
    window.setTimeout(() => reject(new ReminderError("worker-missing")), READY_TIMEOUT_MS),
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
  if (!res.ok) throw await rejection(res)
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
  if (!res.ok) throw await rejection(res)
  const body = (await res.json()) as ReminderBody
  if (body.reminder === null) throw new ReminderError("rejected", `${res.status} no reminder`)
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
  if (permission === "default") throw new ReminderError("dismissed")
  if (permission !== "granted") throw new ReminderError("denied")
  const { publicKey } = await readServer(null)
  if (publicKey === null) throw new ReminderError("not-configured")
  const applicationServerKey = keyBytes(publicKey)
  const worker = await registration()
  const { pushManager } = worker
  let subscription = await pushManager.getSubscription()
  if (subscription && !sameKey(subscription.options.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await pushManager
    .subscribe({ userVisibleOnly: true, applicationServerKey })
    .catch((error: unknown) => {
      throw subscribeErrorOf(error, worker)
    })
  return save(subscription, reminderTime)
}

/** Change this device's reminder time; the time zone is read again. */
export async function saveReminderTime(reminderTime: string): Promise<ReminderSettings> {
  const subscription = await currentSubscription()
  if (subscription === null) throw new ReminderError("unsubscribed")
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
  if (!res.ok) throw await rejection(res)
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
  if (subscription === null) throw new ReminderError("unsubscribed")
  const res = await request("/api/reminders/test", {
    method: "POST",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  })
  if (res.status === 501) throw new ReminderError("not-configured")
  if (res.status === 404) throw new ReminderError("unsubscribed")
  // A push service's answer comes back as 410 or 502, with a result.
  if (!res.ok && res.status !== 410 && res.status !== 502) throw await rejection(res)
  const result = (await res.json()) as ReminderTestResult
  if (result.outcome === "gone") await subscription.unsubscribe()
  return result
}
