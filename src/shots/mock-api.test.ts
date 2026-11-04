import { describe, expect, it } from "vitest"
import type { LoggedKeyEvent } from "../data/key-events"
import type { ShotsFixtures } from "./fixtures"
import { createMockApi, daysBetween, isMockedPath, shiftEvents } from "./mock-api"

const event = (seq: number, entityId: string, key: string, value: unknown): LoggedKeyEvent => ({
  id: `evt_${seq}`,
  seq,
  entity: "block",
  entity_id: entityId,
  action: key === "" ? "create" : "set",
  key,
  value,
  batch: "bat_1",
  device: "test",
  at: Date.parse("2026-11-01T12:00:00Z") + seq,
  v: 2,
})

const fixtures = (events: LoggedKeyEvent[], anchorDay: string | null = null): ShotsFixtures => ({
  kind: "demo",
  anchorDay,
  user: { id: 1, login: "sam", name: "Sam", email: "sam@example.com" },
  events,
  features: { admin: false, features: { mcp: true, cloudflareAi: false } },
  preferences: { preferences: { whatsNewCard: false, useCloudflareAi: false } },
  shares: { me: { email: "sam@example.com" }, given: [], received: [] },
  slices: {},
  mcpTokens: [],
  anthropicKey: { set: false, last4: null },
  reminders: { publicKey: null, reminder: null },
})

const EVENTS = [
  event(1, "blk_a", "", null),
  event(2, "blk_a", "text", "2026-11-01"),
  event(3, "blk_b", "", null),
  event(4, "blk_b", "text", "plain"),
]
const url = (path: string) => new URL(path, "http://127.0.0.1:4791")

describe("the shots mock API", () => {
  it("pages the cache folded from the log", () => {
    const api = createMockApi(fixtures(EVENTS), "2026-11-01")
    const first = api.answer("GET", url("/api/replica/cache?limit=3"), null)?.body as {
      rows: { entity_id: string; key: string }[]
      cursor: unknown
    }
    expect(first.rows.map((row) => `${row.entity_id}.${row.key}`)).toEqual([
      "blk_a.deleted",
      "blk_a.text",
      "blk_b.deleted",
    ])
    const after = encodeURIComponent(JSON.stringify(first.cursor))
    const next = api.answer("GET", url(`/api/replica/cache?after=${after}&limit=3`), null)
      ?.body as { rows: { entity_id: string; key: string }[]; cursor: unknown }
    expect(next.rows.map((row) => `${row.entity_id}.${row.key}`)).toEqual(["blk_b.text"])
    expect(next.cursor).toBeNull()
  })

  it("pages the log past a seq", () => {
    const api = createMockApi(fixtures(EVENTS), "2026-11-01")
    const page = api.answer("GET", url("/api/replica/events-log?since=1&limit=2"), null)
      ?.body as { events: LoggedKeyEvent[]; cursor: number }
    expect(page.events.map((e) => e.seq)).toEqual([2, 3])
    expect(page.cursor).toBe(3)
  })

  it("answers a push with success and keeps nothing", () => {
    const api = createMockApi(fixtures(EVENTS), "2026-11-01")
    const pushed = api.answer("PUT", url("/api/replica/events"), {
      events: [{ id: "evt_new" }],
      cursor: "c1",
    })
    expect(pushed?.body).toEqual({
      ok: true,
      appended: 1,
      stale: 0,
      seqs: [["evt_new", 5]],
      cursor: "c1",
    })
    const log = api.answer("GET", url("/api/replica/events-log?since=4&limit=10"), null)
    expect((log?.body as { events: unknown[] }).events).toEqual([])
  })

  it("moves the dates to today from the anchor", () => {
    expect(daysBetween("2026-11-01", "2026-11-04")).toBe(3)
    const [, text, , plain] = shiftEvents(EVENTS, 3)
    expect(text.value).toBe("2026-11-04")
    expect(text.at - EVENTS[1].at).toBe(3 * 86_400_000)
    expect(plain.value).toBe("plain")
  })

  it("has no answer for a route it does not know", () => {
    const api = createMockApi(fixtures(EVENTS), "2026-11-01")
    expect(api.answer("GET", url("/api/nothing-here"), null)).toBeNull()
    expect(isMockedPath(url("/api/nothing-here"), "http://127.0.0.1:4791")).toBe(true)
    expect(isMockedPath(url("/src/index.tsx"), "http://127.0.0.1:4791")).toBe(false)
  })
})
