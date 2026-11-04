import type { CachePageCursor } from "../../worker/handlers/replica-payload"
import { foldEventsToCache, type CacheRow } from "../data/cache-rows"
import type { LoggedKeyEvent } from "../data/key-events"
import type { ShotsFixtures } from "./fixtures"

/**
 * The Worker, as screenshots need it (docs/screenshots.md): every API route
 * the signed-in pages call, answered from one set of fixtures. Reads answer
 * from the fixtures; writes answer success and change nothing, so a shot
 * never depends on what an earlier shot did. A route not listed here is a
 * gap: `answer` returns null and the caller says so loudly.
 *
 * Pure: no `window`, no `fetch`. `install.ts` is the browser half.
 */

interface MockAnswer {
  status: number
  body: unknown
}

/** The paths the mock layer owns: the app's API, the auth routes, and
 * GitHub's user API (only the sign-in button asks it). */
export function isMockedPath(url: URL, origin: string): boolean {
  if (url.origin === "https://api.github.com") return true
  if (url.origin !== origin) return false
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/github-auth" ||
    url.pathname === "/github-refresh" ||
    url.pathname === "/mcp"
  )
}

const DAY_MS = 86_400_000
const DATE_AT_START = /^(\d{4})-(\d{2})-(\d{2})/

/** Whole days from `from` to `to` (both `YYYY-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/** `day` (`YYYY-MM-DD`) moved by `days`. */
function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The log with every date moved forward by `days`: each event's clock, and
 * a string value that opens with a date (a tracker entry, `2026-11-04 · 5
 * km`; a note's `updated_at`). Stamps are derived from the clock, so they
 * move with it and keep their order.
 */
export function shiftEvents(events: readonly LoggedKeyEvent[], days: number): LoggedKeyEvent[] {
  if (days === 0) return [...events]
  return events.map((event) => {
    const value =
      typeof event.value === "string" && DATE_AT_START.test(event.value)
        ? shiftDay(event.value.slice(0, 10), days) + event.value.slice(10)
        : event.value
    return { ...event, at: event.at + days * DAY_MS, value }
  })
}

const byCacheKey = (a: CacheRow, b: CacheRow): number =>
  a.entity < b.entity
    ? -1
    : a.entity > b.entity
      ? 1
      : a.entity_id < b.entity_id
        ? -1
        : a.entity_id > b.entity_id
          ? 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0

const afterCursor = (row: CacheRow, [entity, entityId, key]: CachePageCursor): boolean =>
  byCacheKey(row, { entity, entity_id: entityId, key } as CacheRow) > 0

const intParam = (url: URL, name: string, fallback: number): number => {
  const raw = Number(url.searchParams.get(name))
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

export interface MockApi {
  /** The answer to a request, or null when the mock layer has no route for it. */
  answer(method: string, url: URL, body: unknown): MockAnswer | null
}

export function createMockApi(fixtures: ShotsFixtures, today: string): MockApi {
  const days = fixtures.anchorDay === null ? 0 : daysBetween(fixtures.anchorDay, today)
  const events = shiftEvents(fixtures.events, days)
  const cache = [...foldEventsToCache(events).values()].sort(byCacheKey)
  const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0)
  /** A database of its own per set, so a browser that pulled one set
   * discards it before it takes the other (`adoptReplica`). */
  const replicaId = `shots-${fixtures.kind}`
  const ok = (body: unknown): MockAnswer => ({ status: 200, body })
  const { user } = fixtures

  const routes: Record<string, (url: URL, body: unknown) => MockAnswer> = {
    "GET /api/replica/first-screen": () => ok({ rows: cache, seq: maxSeq, replica_id: replicaId }),
    "GET /api/replica/cache": (url) => {
      const raw = url.searchParams.get("after")
      const after = raw === null ? null : (JSON.parse(raw) as CachePageCursor)
      const limit = intParam(url, "limit", 20_000)
      const from = after === null ? cache : cache.filter((row) => afterCursor(row, after))
      const rows = from.slice(0, limit)
      const last = rows.length === limit ? rows[rows.length - 1] : undefined
      return ok({
        rows,
        seq: maxSeq,
        cursor: last === undefined ? null : [last.entity, last.entity_id, last.key],
        replica_id: replicaId,
      })
    },
    "GET /api/replica/events-log": (url) => {
      const since = intParam(url, "since", 0)
      const limit = intParam(url, "limit", 2_000)
      const page = events.filter((event) => event.seq > since).slice(0, limit)
      return ok({ events: page, cursor: page.at(-1)?.seq ?? null, replica_id: replicaId })
    },
    "PUT /api/replica/events": (_url, body) => {
      const pushed = (body as { events?: { id: string }[]; cursor?: string } | null) ?? {}
      const ids = (pushed.events ?? []).map((event) => event.id)
      return ok({
        ok: true,
        appended: ids.length,
        stale: 0,
        seqs: ids.map((id, at) => [id, maxSeq + 1 + at]),
        cursor: pushed.cursor ?? null,
      })
    },
    "GET /api/replica/status": () => {
      const nodes = new Set(cache.filter((row) => row.entity === "block").map((r) => r.entity_id))
      const links = new Set(cache.filter((row) => row.entity === "link").map((r) => r.entity_id))
      return ok({
        counts: { nodes: nodes.size, links: links.size, pages: 0 },
        schema_version: null,
        replica_id: replicaId,
      })
    },
    "GET /api/features": () => ok(fixtures.features),
    "GET /api/preferences": () => ok(fixtures.preferences),
    "PUT /api/preferences": (_url, body) =>
      ok({
        preferences: {
          ...fixtures.preferences.preferences,
          ...((body as { preferences?: object } | null)?.preferences ?? {}),
        },
      }),
    "GET /api/shares": () => ok(fixtures.shares),
    "GET /api/mcp/tokens": () => ok({ tokens: fixtures.mcpTokens }),
    "GET /api/anthropic-key": () => ok(fixtures.anthropicKey),
    "GET /api/reminders": () => ok(fixtures.reminders),
    "PUT /api/reminders": () => ok(fixtures.reminders),
    "DELETE /api/reminders": () => ok({ ok: true }),
    "POST /api/reminders/test": () => ok({ outcome: "sent", status: 201, body: "" }),
    "POST /github-refresh": () =>
      ok({ token: "shots-token", accessTokenExpiresAt: null, refreshTokenExpiresAt: null }),
    "GET https://api.github.com/user": () =>
      ok({ id: user.id, login: user.login, name: user.name, email: user.email }),
    "GET https://api.github.com/user/emails": () =>
      ok([{ email: user.email, primary: true, verified: true }]),
  }

  return {
    answer(method, url, body) {
      const where = url.origin === "https://api.github.com" ? url.href.split("?")[0] : url.pathname
      const route = routes[`${method} ${where}`]
      if (route) return route(url, body)
      const share = /^\/api\/shares\/([^/]+)\/notes$/.exec(url.pathname)
      if (share && method === "GET") {
        const slice = fixtures.slices[decodeURIComponent(share[1])]
        return slice ? ok(slice) : { status: 404, body: { error: "not_found" } }
      }
      // Every other write to a route the app owns (a share given or ended,
      // a token minted, a board tagged): success, and nothing changes.
      if (method !== "GET" && url.pathname.startsWith("/api/shares")) return ok({ ok: true })
      return null
    },
  }
}
