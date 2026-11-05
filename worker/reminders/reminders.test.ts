// tenant-guard: exempt — this suite reads query PLANS and seeds control-plane
// rows by hand.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import migration0033 from "../../migrations/0033_push_subscriptions.sql?raw"
import type { SqlDriver, SqlValue } from "../../src/data/sql-driver"
import { corpusPut } from "../handlers/replica-corpus"
import type { LinkRow, NodeRow } from "../handlers/replica-payload"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { forSubscriber, type TenantDb } from "../tenancy-db"
import type { Env } from "../types"
import { runReminders } from "./cron"
import { checkHabits, missingHabits, readDayEntries, readHabits, type Habit } from "./habits"
import { reminderMessage } from "./message"
import { reminders } from "../handlers/reminders"
import { pushResultOf, sendPush, vapidKeys } from "./push"
import { dueSubscriptions, saveSubscription, subscriptionOf } from "./store"

const USER = 31
const OTHER = 32
const TODAY = "2026-11-02"
const LONDON = "Europe/London"
/** 2026-11-02 20:05 in London (GMT). */
const EVENING = Date.parse("2026-11-02T20:05:00Z")
/** 2026-11-02 09:00 in London. */
const MORNING = Date.parse("2026-11-02T09:00:00Z")

let harness: McpTestEnv

const node = (id: string, type: string, text: string, extra: Partial<NodeRow> = {}): NodeRow => ({
  id,
  type,
  text,
  props: null,
  updated_at: 1_700_000_000_000,
  ...extra,
})

const child = (source: string, destination: string, sortKey: string): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: "child",
  sort_key: sortKey,
  updated_at: 1_700_000_000_000,
})

/** A tracker with its series and entries, written through the production
 * push path, so the cache holds what the app's own writes leave. */
async function seedTracker(
  userId: number,
  tracker: { id: string; title: string },
  series: {
    id: string
    name: string
    kind: "check" | "number"
    goal?: "avoid"
    entries: [string, string][]
  }[],
  extra: { nodes?: NodeRow[]; links?: LinkRow[] } = {},
): Promise<void> {
  const nodes: NodeRow[] = [node(tracker.id, "tracker", tracker.title)]
  const links: LinkRow[] = []
  series.forEach((one, at) => {
    nodes.push(
      node(one.id, "ul", one.name, {
        props: JSON.stringify(one.goal ? { kind: one.kind, goal: one.goal } : { kind: one.kind }),
        notes_id: tracker.id,
      }),
    )
    links.push(child(tracker.id, one.id, `a${at}`))
    one.entries.forEach(([type, text], index) => {
      const id = `${one.id}_e${index}`
      nodes.push(node(id, type, text, { notes_id: tracker.id }))
      links.push(child(one.id, id, `a${index}`))
    })
  })
  await corpusPut(
    harness.tenant(userId),
    { nodes: [...nodes, ...(extra.nodes ?? [])], links: [...links, ...(extra.links ?? [])] },
    1_700_000_000_000,
  )
}

beforeAll(async () => {
  harness = await createMcpTestEnv()
  await harness.control.execScript(migration0033)
  await harness.addUser(USER)
  await harness.addUser(OTHER)
  await seedTracker(
    USER,
    { id: "trk_habits", title: "Habits" },
    [
      {
        id: "ser_read",
        name: "Read",
        kind: "check",
        entries: [
          ["done", "2026-11-01"],
          ["todo", TODAY],
        ],
      },
      { id: "ser_run", name: "Run", kind: "number", entries: [["text", `${TODAY} · 5 km`]] },
      { id: "ser_stretch", name: "Stretch", kind: "number", entries: [["text", `${TODAY} · 0`]] },
      { id: "ser_water", name: "Water", kind: "check", entries: [] },
      // A habit to avoid, nothing logged today: a clean day, not a missing one.
      { id: "ser_smoke", name: "Smoke", kind: "check", goal: "avoid", entries: [] },
    ],
    {
      // A child of the tracker that is not a series, and a day-titled row
      // in an ordinary note: neither is a habit.
      nodes: [
        node("trk_note_row", "text", "Notes"),
        node("blk_journal", "text", `${TODAY} meeting`),
      ],
      links: [child("trk_habits", "trk_note_row", "z0")],
    },
  )
  await seedTracker(USER, { id: "trk_mind", title: "Mind" }, [
    { id: "ser_meditate", name: "Meditate", kind: "check", entries: [["done", TODAY]] },
  ])
  // Another reader's habit, all missing: never in USER's answer.
  await seedTracker(OTHER, { id: "trk_other", title: "Theirs" }, [
    { id: "ser_other", name: "Other", kind: "check", entries: [] },
  ])
})

describe("the missing habits", () => {
  it("are the series to keep with nothing logged today: an open to-do, a zero, or no entry", async () => {
    const { habits, missing } = await checkHabits(harness.tenant(USER), TODAY)
    expect(habits.map((habit) => habit.name)).toEqual([
      "Read",
      "Run",
      "Stretch",
      "Water",
      "Meditate",
    ])
    expect(missing.map((habit) => habit.name)).toEqual(["Read", "Stretch", "Water"])
  })

  it("read only the reader's own trackers", async () => {
    const habits = await readHabits(harness.tenant(OTHER))
    expect(habits.map((habit) => habit.name)).toEqual(["Other"])
  })

  it("read only the day's entries, not the history", async () => {
    const rows = await readDayEntries(harness.tenant(USER), TODAY)
    expect(rows.map((row) => row.text).sort()).toEqual(
      [TODAY, `${TODAY} · 0`, `${TODAY} · 5 km`, TODAY].sort(),
    )
    expect(rows.some((row) => row.text === "2026-11-01")).toBe(false)
    // The journal row has no parent, so the hop up drops it.
    expect(rows.some((row) => row.id === "blk_journal")).toBe(false)
  })

  it("count a day logged when either of two entries of it is (two devices offline)", () => {
    const habit: Habit = {
      id: "s",
      name: "Read",
      kind: "check",
      trackerId: "t",
      trackerName: "T",
      sortKey: "a0",
    }
    const rows = [
      { parentId: "s", id: "e1", type: "todo", text: TODAY },
      { parentId: "s", id: "e2", type: "done", text: TODAY },
    ]
    expect(missingHabits([habit], rows, TODAY)).toEqual([])
    expect(missingHabits([habit], rows.slice(0, 1), TODAY)).toEqual([habit])
  })
})

describe("the message", () => {
  const habit = (name: string, trackerId = "trk_a"): Habit => ({
    id: name,
    name,
    kind: "check",
    trackerId,
    trackerName: "A",
    sortKey: "a0",
  })

  it("names the missing habits and opens the first one's tracker", () => {
    const habits = [habit("Read"), habit("Run", "trk_b")]
    expect(reminderMessage(habits, habits.slice(1))).toEqual({
      title: "Today's habits",
      body: "Not logged yet: Run.",
      url: "/trackers/trk_b",
      tag: "habit-reminder",
    })
    expect(reminderMessage(habits, habits).body).toBe("Not logged yet: Read and Run.")
  })

  it("counts the rest after five", () => {
    const habits = ["A", "B", "C", "D", "E", "F", "G"].map((name) => habit(name))
    expect(reminderMessage(habits, habits).body).toBe("Not logged yet: A, B, C, D, E and 2 more.")
  })

  it("says a test is one, and says so when nothing is missing", () => {
    expect(reminderMessage([habit("Read")], [], { test: true }).body).toBe(
      "Test reminder. All habits for today are logged.",
    )
  })
})

// -----------------------------------------------------------------------------
// The plans: every read seeks; none scans the tenant's partition
// -----------------------------------------------------------------------------

/** Plan steps that read a table without narrowing past the tenant (or at
 * all): a full SCAN, or a SEARCH on `user_id` alone. */
async function badSteps(driver: SqlDriver, sql: string, params: SqlValue[]): Promise<string[]> {
  const plan = await driver.exec(`EXPLAIN QUERY PLAN ${sql}`, params)
  return plan
    .map((row) => String(row.detail))
    .filter(
      (detail) =>
        /^SCAN (?!json_each)/.test(detail) ||
        /USING (?:COVERING )?INDEX \w+ \(user_id=\?\)$/.test(detail),
    )
}

function recordingTenant(
  userId: number,
  recorded: { sql: string; params: SqlValue[] }[],
): TenantDb {
  const driver = harness.control
  return forSubscriber(
    {
      exec: (sql, params = []) => {
        recorded.push({ sql, params })
        return driver.exec(sql, params)
      },
      batch: driver.batch,
      execScript: driver.execScript,
      close: driver.close,
    },
    userId,
  )
}

describe("the plans", () => {
  it("seek the trackers by type and today's entries on the day-text index", async () => {
    const recorded: { sql: string; params: SqlValue[] }[] = []
    await checkHabits(recordingTenant(USER, recorded), TODAY)
    expect(recorded).toHaveLength(2)
    for (const { sql, params } of recorded) {
      expect(await badSteps(harness.control, sql, params), sql).toEqual([])
    }
    const entriesPlan = await harness.control.exec(
      `EXPLAIN QUERY PLAN ${recorded[1].sql}`,
      recorded[1].params,
    )
    expect(entriesPlan.map((row) => String(row.detail)).join("\n")).toContain(
      "events_log_cache_day_text",
    )
  })

  it("select the due subscriptions on the due index", async () => {
    const plan = await harness.control.exec(
      "EXPLAIN QUERY PLAN SELECT p.endpoint FROM push_subscriptions p WHERE p.next_due_at <= ?1 " +
        "AND NOT EXISTS (SELECT 1 FROM users u WHERE u.github_id = p.user_id AND u.status = 'blocked') " +
        "ORDER BY p.next_due_at LIMIT ?2",
      [EVENING, 200],
    )
    const details = plan.map((row) => String(row.detail)).join("\n")
    expect(details).toContain("push_subscriptions_due")
    expect(details).not.toMatch(/SCAN p\b/)
  })
})

// -----------------------------------------------------------------------------
// The due selection and the cron
// -----------------------------------------------------------------------------

/** A browser's subscription keys: a P-256 public key and a 16-byte secret. */
async function browserKeys(): Promise<{ p256dh: string; auth: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)
  const b64 = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  return { p256dh: b64(raw), auth: b64(crypto.getRandomValues(new Uint8Array(16))) }
}

/** A VAPID pair in the Worker's format: the public point and the raw `d`,
 * base64url (the format of web-push's `generateVAPIDKeys`). */
async function vapidPair(): Promise<{ VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)
  const b64 = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  return { VAPID_PUBLIC_KEY: b64(raw), VAPID_PRIVATE_KEY: jwk.d as string }
}

/** The public key committed in wrangler.jsonc. */
const COMMITTED_PUBLIC_KEY =
  "BJi3MWqzpp5H-6v6jBS3GDRXm0aMccdEyi4QpMbTSIHXaeKd3ci2fc-WyY_G5E17j_hq65i-LfKqNS3n2bVOmG4"

let vapidEnv: Env

beforeAll(async () => {
  vapidEnv = { ...harness.env, ...(await vapidPair()) }
})

beforeEach(async () => {
  await harness.control.exec("DELETE FROM push_subscriptions")
})

async function subscribe(
  userId: number,
  endpoint: string,
  reminderTime = "20:00",
  now = MORNING,
  timeZone = LONDON,
) {
  const keys = await browserKeys()
  return saveSubscription(
    harness.control,
    { endpoint, userId, ...keys, reminderTime, timeZone },
    now,
  )
}

/** A push service that answers each endpoint as told (201 by default). */
function pushService(answers: Record<string, number> = {}) {
  const calls: { endpoint: string; headers: Headers }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input)
    calls.push({ endpoint, headers: new Headers(init?.headers) })
    return new Response(null, { status: answers[endpoint] ?? 201 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe("the VAPID keys", () => {
  it("take the public point from the var and the raw d from the secret", async () => {
    expect(await vapidKeys(vapidEnv)).toEqual({
      publicKey: vapidEnv.VAPID_PUBLIC_KEY,
      privateKey: vapidEnv.VAPID_PRIVATE_KEY,
    })
  })

  it("refuse a missing or malformed key, and a pair that does not match", async () => {
    expect(await vapidKeys(harness.env)).toBeNull()
    expect(await vapidKeys({ ...vapidEnv, VAPID_PRIVATE_KEY: undefined })).toBeNull()
    expect(await vapidKeys({ ...vapidEnv, VAPID_PUBLIC_KEY: "Bnope" })).toBeNull()
    expect(await vapidKeys({ ...vapidEnv, VAPID_PRIVATE_KEY: "not base64url!" })).toBeNull()
    const other = await vapidPair()
    expect(await vapidKeys({ ...vapidEnv, VAPID_PRIVATE_KEY: other.VAPID_PRIVATE_KEY })).toBeNull()
    // The committed public key with a secret that is not its pair.
    expect(await vapidKeys({ ...vapidEnv, VAPID_PUBLIC_KEY: COMMITTED_PUBLIC_KEY })).toBeNull()
  })
})

describe("the due selection", () => {
  it("selects only the subscriptions whose local time has passed", async () => {
    await subscribe(USER, "https://push.test/evening", "20:00")
    await subscribe(USER, "https://push.test/late", "22:00")
    // 15:00 in New York is 20:00 in London: not due there yet.
    await subscribe(OTHER, "https://push.test/ny", "20:00", MORNING, "America/New_York")
    const due = await dueSubscriptions(harness.control, EVENING, 200)
    expect(due.map((row) => row.endpoint)).toEqual(["https://push.test/evening"])
  })

  it("leaves out a day already dealt with, and a blocked account", async () => {
    await subscribe(USER, "https://push.test/evening")
    await runReminders(vapidEnv, EVENING, pushService().fetchImpl)
    expect(await dueSubscriptions(harness.control, EVENING + 60 * 60_000, 200)).toEqual([])

    await subscribe(OTHER, "https://push.test/blocked")
    await harness.addUser(OTHER, "blocked")
    expect(await dueSubscriptions(harness.control, EVENING, 200)).toEqual([])
    await harness.addUser(OTHER, "active")
  })
})

describe("the cron", () => {
  it("sends one push per due subscription with a habit missing, and marks the day", async () => {
    await subscribe(USER, "https://push.test/phone")
    await subscribe(USER, "https://push.test/laptop")
    await subscribe(USER, "https://push.test/late", "22:00")
    const service = pushService()
    const run = await runReminders(vapidEnv, EVENING, service.fetchImpl)
    expect(run).toMatchObject({ due: 2, checked: 1, sent: 2, gone: 0, failed: 0 })
    expect(service.calls.map((call) => call.endpoint).sort()).toEqual([
      "https://push.test/laptop",
      "https://push.test/phone",
    ])
    // VAPID and aes128gcm: the push services' headers.
    const headers = service.calls[0].headers
    expect(headers.get("content-encoding")).toBe("aes128gcm")
    const authorization = headers.get("authorization") ?? ""
    expect(authorization).toMatch(/^vapid t=.+, k=.+$/)
    expect(authorization.endsWith(`k=${vapidEnv.VAPID_PUBLIC_KEY}`)).toBe(true)
    // The JWT's subject is the app's production address, not a person.
    const claims = JSON.parse(
      atob(authorization.split("t=")[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { sub: string; aud: string }
    expect(claims).toMatchObject({
      sub: "https://ruminate.finnformica.workers.dev",
      aud: "https://push.test",
    })

    const phone = await subscriptionOf(harness.control, USER, "https://push.test/phone")
    expect(phone?.lastSentDay).toBe(TODAY)
    expect(phone?.nextDueAt).toBe(Date.parse("2026-11-03T20:00:00Z"))

    // The next run, a quarter later: nothing is due again today.
    const again = pushService()
    expect(await runReminders(vapidEnv, EVENING + 15 * 60_000, again.fetchImpl)).toMatchObject({
      due: 0,
      sent: 0,
    })
    expect(again.calls).toEqual([])
  })

  it("sends nothing to a reader with every habit logged, and still marks the day", async () => {
    await subscribe(OTHER, "https://push.test/other")
    // OTHER's one habit is missing; log it.
    await seedTracker(OTHER, { id: "trk_other", title: "Theirs" }, [
      { id: "ser_other", name: "Other", kind: "check", entries: [["done", TODAY]] },
    ])
    const service = pushService()
    expect(await runReminders(vapidEnv, EVENING, service.fetchImpl)).toMatchObject({
      due: 1,
      sent: 0,
    })
    expect(service.calls).toEqual([])
    const row = await subscriptionOf(harness.control, OTHER, "https://push.test/other")
    expect(row?.lastSentDay).toBe(TODAY)
  })

  it("deletes a subscription the push service says is gone", async () => {
    await subscribe(USER, "https://push.test/gone")
    await subscribe(USER, "https://push.test/missing")
    const service = pushService({ "https://push.test/gone": 410, "https://push.test/missing": 404 })
    expect(await runReminders(vapidEnv, EVENING, service.fetchImpl)).toMatchObject({ gone: 2 })
    expect(await subscriptionOf(harness.control, USER, "https://push.test/gone")).toBeNull()
    expect(await subscriptionOf(harness.control, USER, "https://push.test/missing")).toBeNull()
  })

  it("does nothing without the VAPID secret", async () => {
    await subscribe(USER, "https://push.test/phone")
    const service = pushService()
    expect(await runReminders(harness.env, EVENING, service.fetchImpl)).toMatchObject({ due: 0 })
    expect(service.calls).toEqual([])
  })
})

// -----------------------------------------------------------------------------
// One push, as a push service reads it
// -----------------------------------------------------------------------------

const fromBase64Url = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0))

const hmac = async (key: Uint8Array, data: Uint8Array) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      data,
    ),
  )

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const text = (value: string) => new TextEncoder().encode(value)

/** Decrypt an aes128gcm push body (RFC 8188, RFC 8291 §3.4) with the
 * browser's private key, as the browser does. */
async function decrypt(
  body: Uint8Array,
  browser: CryptoKeyPair,
  authSecret: Uint8Array,
): Promise<string> {
  const salt = body.slice(0, 16)
  const keyLength = body[20]
  const serverPublic = body.slice(21, 21 + keyLength)
  const record = body.slice(21 + keyLength)
  const browserPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", browser.publicKey)) as ArrayBuffer,
  )
  const serverKey = await crypto.subtle.importKey(
    "raw",
    serverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const shared = new Uint8Array(
    // The Workers types spell ECDH's `public` as `$public`; Node reads `public`.
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      browser.privateKey,
      256,
    ),
  )
  const one = new Uint8Array([1])
  const ikm = await hmac(
    await hmac(authSecret, shared),
    concat(text("WebPush: info\0"), browserPublic, serverPublic, one),
  )
  const prk = await hmac(salt, ikm)
  const cek = (await hmac(prk, concat(text("Content-Encoding: aes128gcm\0"), one))).slice(0, 16)
  const nonce = (await hmac(prk, concat(text("Content-Encoding: nonce\0"), one))).slice(0, 12)
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
      record,
    ),
  )
  // The last record ends at its 0x02 delimiter; zeroes pad after it.
  return new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2)))
}

describe("one push", () => {
  it("is a request FCM takes: headers, VAPID claims for its origin, and a body Brave decrypts", async () => {
    const browser = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair
    const authSecret = crypto.getRandomValues(new Uint8Array(16))
    const b64 = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
    const target = {
      endpoint: "https://fcm.googleapis.com/fcm/send/dxyz:APA91bH",
      p256dh: b64(
        new Uint8Array((await crypto.subtle.exportKey("raw", browser.publicKey)) as ArrayBuffer),
      ),
      auth: b64(authSecret),
    }
    let sent: { url: string; headers: Headers; body: Uint8Array } | null = null
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: new Uint8Array(init?.body as Uint8Array),
      }
      return new Response(null, { status: 201 })
    }) as typeof fetch
    const keys = (await vapidKeys(vapidEnv))!
    const payload = reminderMessage([], [], { test: true })
    expect(await sendPush(keys, target, payload, fetchImpl)).toEqual({
      outcome: "sent",
      status: 201,
      reason: "sent",
    })
    const request = sent as unknown as { url: string; headers: Headers; body: Uint8Array }
    expect(request.url).toBe(target.endpoint)
    const { headers } = request
    expect(headers.get("content-encoding")).toBe("aes128gcm")
    expect(headers.get("content-type")).toBe("application/octet-stream")
    expect(headers.get("ttl")).toBe(String(4 * 60 * 60))
    expect(headers.get("urgency")).toBe("normal")
    // RFC 8030 §5.4: a topic is at most 32 base64url characters.
    expect(headers.get("topic")).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    // FCM takes at most 4096 bytes of body.
    expect(request.body.byteLength).toBeLessThanOrEqual(4096)
    expect(headers.get("content-length")).toBe(String(request.body.byteLength))

    const [, jwt, key] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.get("authorization") ?? "")!
    expect(key).toBe(vapidEnv.VAPID_PUBLIC_KEY)
    const [header, claims, signature] = jwt.split(".")
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(claims))) as {
      aud: string
      exp: number
      sub: string
    }
    // RFC 8292 §2: `aud` is the push service's origin; `exp` is within 24 hours.
    expect(parsed.aud).toBe("https://fcm.googleapis.com")
    expect(parsed.exp - Date.now() / 1000).toBeLessThanOrEqual(24 * 60 * 60)
    expect(parsed.sub).toBe("https://ruminate.finnformica.workers.dev")
    const point = fromBase64Url(vapidEnv.VAPID_PUBLIC_KEY!)
    const verifier = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: b64(point.slice(1, 33)), y: b64(point.slice(33, 65)) },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        fromBase64Url(signature),
        text(`${header}.${claims}`),
      ),
    ).toBe(true)

    expect(JSON.parse(await decrypt(request.body, browser, authSecret))).toEqual(payload)
  })

  it("names each answer of a push service", () => {
    expect(pushResultOf(201)).toEqual({ outcome: "sent", status: 201, reason: "sent" })
    expect(pushResultOf(410).outcome).toBe("gone")
    expect(pushResultOf(404).outcome).toBe("gone")
    expect(pushResultOf(403)).toEqual({
      outcome: "vapid",
      status: 403,
      reason: "VAPID key refused",
    })
    expect(pushResultOf(413)).toEqual({
      outcome: "failed",
      status: 413,
      reason: "payload too large",
    })
    expect(pushResultOf(0).reason).toBe("no answer")
    expect(pushResultOf(500).reason).toBe("push service error")
  })
})

describe("the test reminder", () => {
  /** GitHub signs the caller in as USER; every other URL is a push service
   * that answers as told. */
  function services(answers: Record<string, number>) {
    const push = pushService(answers)
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === "https://api.github.com/user"
        ? new Response(JSON.stringify({ id: USER, login: "finn" }))
        : push.fetchImpl(input, init)) as typeof fetch
    return { calls: push.calls, fetchImpl }
  }

  const testRequest = (endpoint: string) =>
    new Request("https://ruminate.test/api/reminders/test", {
      method: "POST",
      headers: { Cookie: "gh_refresh=session", Authorization: "Bearer good" },
      body: JSON.stringify({ endpoint }),
    })

  it("goes to every device of the reader and says what each push service answered", async () => {
    await subscribe(USER, "https://web.push.apple.com/phone")
    await subscribe(USER, "https://fcm.googleapis.com/fcm/send/brave")
    await subscribe(USER, "https://updates.push.services.mozilla.com/wpush/v2/gone")
    await subscribe(OTHER, "https://push.test/theirs")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const { calls, fetchImpl } = services({
      "https://fcm.googleapis.com/fcm/send/brave": 403,
      "https://updates.push.services.mozilla.com/wpush/v2/gone": 410,
    })
    const response = await reminders(
      testRequest("https://fcm.googleapis.com/fcm/send/brave"),
      vapidEnv,
      fetchImpl,
      EVENING,
    )
    const logged = log.mock.calls.map(([line]) => JSON.parse(String(line)))
    log.mockRestore()
    expect(response.status).toBe(200)
    const body = (await response.json()) as { devices: unknown[] }
    // Saved at one instant, so in endpoint order.
    expect(body.devices).toEqual([
      {
        host: "fcm.googleapis.com",
        self: true,
        outcome: "vapid",
        status: 403,
        reason: "VAPID key refused",
      },
      {
        host: "updates.push.services.mozilla.com",
        self: false,
        outcome: "gone",
        status: 410,
        reason: "subscription gone",
      },
      { host: "web.push.apple.com", self: false, outcome: "sent", status: 201, reason: "sent" },
    ])
    expect(calls.map((call) => call.endpoint)).not.toContain("https://push.test/theirs")
    // A gone device is deleted; the others stay.
    expect(
      await subscriptionOf(
        harness.control,
        USER,
        "https://updates.push.services.mozilla.com/wpush/v2/gone",
      ),
    ).toBeNull()
    expect(
      await subscriptionOf(harness.control, USER, "https://fcm.googleapis.com/fcm/send/brave"),
    ).not.toBeNull()
    // Each failure is logged with the host, never the whole endpoint.
    expect(logged).toEqual([
      expect.objectContaining({ event: "push_failed", host: "fcm.googleapis.com", status: 403 }),
      expect.objectContaining({
        event: "push_failed",
        host: "updates.push.services.mozilla.com",
        status: 410,
      }),
    ])
    expect(JSON.stringify(logged)).not.toContain("/fcm/send/brave")
  })

  it("refuses a browser the server holds no subscription for", async () => {
    await subscribe(USER, "https://web.push.apple.com/phone")
    const { fetchImpl } = services({})
    const response = await reminders(
      testRequest("https://fcm.googleapis.com/fcm/send/unknown"),
      vapidEnv,
      fetchImpl,
      EVENING,
    )
    expect(response.status).toBe(404)
  })
})
