// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** Turning reminders on (docs/reminders.md): each way a step can fail comes
 * back as its own ReminderError, with the browser's error as the cause.
 * jsdom has no push service: permission, the service worker, the push
 * manager and fetch are stood in for. */

vi.mock("../utils/github-session", () => ({
  ensureFreshToken: async () => {},
  getAccessToken: () => "token",
  withAuthRetry: <T>(operation: () => Promise<T>) => operation(),
}))

const { ReminderError, enableReminders, reminderErrorOf } = await import("./reminders")

const PUBLIC_KEY =
  "BJi3MWqzpp5H-6v6jBS3GDRXm0aMccdEyi4QpMbTSIHXaeKd3ci2fc-WyY_G5E17j_hq65i-LfKqNS3n2bVOmG4"

const SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  options: { applicationServerKey: null },
  toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: {} }),
  unsubscribe: async () => true,
}

const browser = vi.hoisted(() => ({
  permission: "granted" as NotificationPermission,
  subscribe: vi.fn(),
  waiting: null as object | null,
  put: { status: 200, body: {} as unknown },
}))

beforeEach(() => {
  browser.permission = "granted"
  browser.subscribe.mockReset().mockResolvedValue(SUBSCRIPTION)
  browser.waiting = null
  browser.put = {
    status: 200,
    body: {
      publicKey: PUBLIC_KEY,
      reminder: { reminderTime: "20:00", timeZone: "Europe/London", lastSentDay: null },
    },
  }
  vi.stubGlobal("PushManager", class {})
  vi.stubGlobal("Notification", { requestPermission: async () => browser.permission })
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve({
        get waiting() {
          return browser.waiting
        },
        pushManager: { getSubscription: async () => null, subscribe: browser.subscribe },
      }),
    },
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init: RequestInit) =>
      init.method === "PUT"
        ? new Response(JSON.stringify(browser.put.body), { status: browser.put.status })
        : new Response(JSON.stringify({ publicKey: PUBLIC_KEY, reminder: null })),
    ),
  )
})

afterEach(() => vi.unstubAllGlobals())

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => {
      expect(error).toBeInstanceOf(ReminderError)
      const { reason, detail } = error as InstanceType<typeof ReminderError>
      return { reason, detail }
    },
  )

describe("turning reminders on", () => {
  it("saves the subscription", async () => {
    expect(await enableReminders("20:00")).toMatchObject({ reminderTime: "20:00" })
  })

  it("tells a dismissed prompt from blocked notifications", async () => {
    browser.permission = "default"
    expect(await failureOf(enableReminders("20:00"))).toEqual({ reason: "dismissed" })
    browser.permission = "denied"
    expect(await failureOf(enableReminders("20:00"))).toEqual({ reason: "denied" })
  })

  it("says the push service refused on an AbortError (Brave with Google push off)", async () => {
    const cause = new DOMException("Registration failed - push service error", "AbortError")
    browser.subscribe.mockRejectedValue(cause)
    const error = await enableReminders("20:00").catch((caught: unknown) => caught)
    expect(error).toMatchObject({ reason: "push-blocked", detail: undefined, cause })
  })

  it("says Brave when Brave's push service refused", async () => {
    Object.defineProperty(navigator, "brave", { configurable: true, value: {} })
    browser.subscribe.mockRejectedValue(new DOMException("push service error", "AbortError"))
    expect(await failureOf(enableReminders("20:00"))).toEqual({
      reason: "push-blocked",
      detail: "brave",
    })
    delete (navigator as { brave?: unknown }).brave
  })

  it("asks for an update when the worker cannot subscribe and a newer one waits", async () => {
    browser.subscribe.mockRejectedValue(new DOMException("No active worker", "InvalidStateError"))
    expect(await failureOf(enableReminders("20:00"))).toEqual({ reason: "worker-outdated" })
    browser.waiting = {}
    browser.subscribe.mockRejectedValue(new DOMException("?", "UnknownError"))
    expect(await failureOf(enableReminders("20:00"))).toEqual({ reason: "worker-outdated" })
  })

  it("names an unknown subscribe error, and a refused permission at subscribe", async () => {
    browser.subscribe.mockRejectedValue(new DOMException("?", "UnknownError"))
    expect(await failureOf(enableReminders("20:00"))).toEqual({
      reason: "failed",
      detail: "UnknownError",
    })
    browser.subscribe.mockRejectedValue(new DOMException("?", "NotAllowedError"))
    expect(await failureOf(enableReminders("20:00"))).toEqual({ reason: "denied" })
  })

  it("keeps the server's status and code when it refuses the save", async () => {
    browser.put = { status: 400, body: { error: "invalid_subscription" } }
    expect(await failureOf(enableReminders("20:00"))).toEqual({
      reason: "rejected",
      detail: "400 invalid_subscription",
    })
    browser.put = { status: 501, body: { error: "push_not_configured" } }
    expect(await failureOf(enableReminders("20:00"))).toEqual({ reason: "not-configured" })
  })
})

describe("any other error", () => {
  it("is offline for a failed fetch, signed-out for a 401, and named otherwise", () => {
    expect(reminderErrorOf(new TypeError("Failed to fetch")).reason).toBe("offline")
    expect(reminderErrorOf(Object.assign(new Error("x"), { status: 401 })).reason).toBe(
      "signed-out",
    )
    const expired = Object.assign(new Error("x"), { name: "SessionExpiredError" })
    expect(reminderErrorOf(expired).reason).toBe("signed-out")
    expect(reminderErrorOf(Object.assign(new Error("x"), { status: 500 }))).toMatchObject({
      reason: "rejected",
      detail: "500",
    })
    expect(reminderErrorOf(new RangeError("x"))).toMatchObject({
      reason: "failed",
      detail: "RangeError",
    })
  })
})
