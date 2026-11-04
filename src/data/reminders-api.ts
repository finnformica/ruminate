/**
 * The wire shapes of `/api/reminders` (worker/handlers/reminders.ts,
 * docs/reminders.md), shared by the Worker and the settings card.
 */

/** This device's reminder as the server holds it. */
export interface ReminderSettings {
  /** `HH:MM`, local, 24-hour. */
  reminderTime: string
  /** The IANA time zone the time is in, from the browser that saved it. */
  timeZone: string
  /** The local day the reminder was last dealt with, or null. */
  lastSentDay: string | null
}

/** `GET` and `PUT`: whether push is set up on the server (`publicKey`, the
 * VAPID key to subscribe with, null when not), and this device's reminder. */
export interface ReminderBody {
  publicKey: string | null
  reminder: ReminderSettings | null
}

/** One device's answer to a test reminder: the push service's host, whether
 * it is the browser that asked, and what the push service said
 * (worker/reminders/push.ts, `pushResultOf`). A gone device's subscription
 * is deleted. */
export interface ReminderDeviceResult {
  host: string
  self: boolean
  outcome: "sent" | "gone" | "vapid" | "failed"
  status: number
  reason: string
}

/** `POST /test`: one result per device of the reader, and the body that was
 * sent. */
export interface ReminderTestResult {
  devices: ReminderDeviceResult[]
  body: string
}
