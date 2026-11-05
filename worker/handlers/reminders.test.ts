import { describe, expect, it } from "vitest"
import { saveInputOf } from "./reminders"

/** The `PUT /api/reminders` body each browser sends: its
 * `PushSubscription.toJSON()`, the time and the zone (src/data/reminders.ts). */

const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
}

const token = (length: number) => "A".repeat(length)

const ENDPOINTS = {
  chrome: `https://fcm.googleapis.com/fcm/send/${token(152)}`,
  firefox: `https://updates.push.services.mozilla.com/wpush/v2/${token(360)}`,
  safari: `https://web.push.apple.com/${token(140)}`,
  edge: `https://wns2-par02p.notify.windows.com/w/?token=${token(1500)}`,
}

const body = (subscription: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  subscription,
  reminderTime: "20:00",
  timeZone: "Europe/London",
  ...extra,
})

describe("the PUT body", () => {
  it.each(Object.entries(ENDPOINTS))("takes a desktop %s subscription", (_, endpoint) => {
    expect(saveInputOf(body({ endpoint, expirationTime: null, keys: KEYS }))).toEqual({
      endpoint,
      ...KEYS,
      reminderTime: "20:00",
      timeZone: "Europe/London",
    })
  })

  it("takes a subscription with an expiration time, and no time (the default)", () => {
    const input = saveInputOf({
      subscription: { endpoint: ENDPOINTS.chrome, expirationTime: 1_800_000_000_000, keys: KEYS },
      timeZone: "UTC",
    })
    expect(input).toMatchObject({ endpoint: ENDPOINTS.chrome, reminderTime: "20:00" })
  })

  it("refuses an endpoint over 2048 characters, or not https, and missing keys", () => {
    const long = `https://push.test/${token(2048)}`
    expect(saveInputOf(body({ endpoint: long, keys: KEYS }))).toEqual({
      error: "invalid_subscription",
    })
    expect(saveInputOf(body({ endpoint: "http://push.test/a", keys: KEYS }))).toEqual({
      error: "invalid_subscription",
    })
    expect(saveInputOf(body({ endpoint: ENDPOINTS.chrome, keys: null }))).toEqual({
      error: "invalid_subscription",
    })
    expect(saveInputOf(null)).toEqual({ error: "invalid_subscription" })
  })

  it("refuses a time off the clock and a zone the runtime does not know", () => {
    const subscription = { endpoint: ENDPOINTS.chrome, keys: KEYS }
    expect(saveInputOf(body(subscription, { reminderTime: "24:00" }))).toEqual({
      error: "invalid_time",
    })
    expect(saveInputOf(body(subscription, { timeZone: "Mars/Olympus" }))).toEqual({
      error: "invalid_time_zone",
    })
  })
})
