// tenant-guard: exempt — this suite reads query PLANS and seeds control-plane
// rows by hand.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
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
import { vapidKeys } from "./push"
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
  series: { id: string; name: string; kind: "check" | "number"; entries: [string, string][] }[],
  extra: { nodes?: NodeRow[]; links?: LinkRow[] } = {},
): Promise<void> {
  const nodes: NodeRow[] = [node(tracker.id, "tracker", tracker.title)]
  const links: LinkRow[] = []
  series.forEach((one, at) => {
    nodes.push(
      node(one.id, "ul", one.name, {
        props: JSON.stringify({ kind: one.kind }),
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
  it("are the series with nothing logged today: an open to-do, a zero, or no entry", async () => {
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
