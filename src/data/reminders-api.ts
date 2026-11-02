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

/** `POST /test`: what the push service said, and the body that was sent. */
export interface ReminderTestResult {
  outcome: "sent" | "gone" | "failed"
  status: number
  body: string
}
