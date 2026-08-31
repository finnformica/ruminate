// D1 replica API — schema v2 (docs/graph-schema-v2.md, docs/graph-storage.md).
//
// The client pushes row-level diffs of its node/link graph (produced by the
// local store's ingest in `src/data/sql-note-store.ts`, batched by
// `src/data/replica-sync.ts`) into the D1 database behind this Worker, and
// pulls rows back out (full or since-cursor). Rows are applied with per-row
// last-writer-wins on `updated_at`.
//
// Routes (wired in worker/index.ts under /api/replica/*):
//   PUT /api/replica/notes  — batch row upserts + deletes, one atomic D1 batch
//   GET /api/replica/notes  — row pull (full, or ?since=<cursor> incremental)
//   GET /api/replica/status — row counts + schema_version + replica_cursor
//
// The wire format, validation, and SQL planning live in `replica-payload.ts`,
// shared with the client so the two sides cannot drift.
//
// AUTH: Ruminate is a single-user app, so "any valid GitHub session" suffices
// (the database only ever holds that one user's notes). We reuse the two
// session mechanisms the Worker already has:
//   1. the `gh_refresh` HttpOnly cookie set by /github-auth and rotated by
//      /github-refresh (its presence proves the browser holds a session this
//      Worker created; SameSite=Lax blocks cross-site sends), and
//   2. the GitHub access token the client keeps, sent here as
//      `Authorization: Bearer <token>` and verified against the GitHub API —
//      the same `GET /user` check /github-auth performs when minting a session.
// Requests failing either check are rejected with 401.

import { readRefreshCookie } from "../github-cookie"
import type { Env } from "../types"
import {
  parseReplicaPayload,
  parseSinceCursor,
  planReplicaPut,
  type LinkKey,
  type LinkRow,
  type NodeRow,
  type ReplicaChangesBody,
  type ReplicaCorpusBody,
  type ReplicaStatusBody,
} from "./replica-payload"

/** Reject bodies larger than this (the whole row corpus is a few MB today). */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/**
 * Session guard (see the AUTH note at the top of this file). Returns null when
 * the request is authenticated, or the 401 response to send. `fetchImpl` is
 * injectable for tests; production uses global fetch.
 */
export async function requireSession(
  request: Request,
  allowedGithubId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  if (!readRefreshCookie(request)) return jsonResponse({ error: "unauthenticated" }, 401)

  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")
  if (!match) return jsonResponse({ error: "missing_token" }, 401)

  const response = await fetchImpl("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${match[1]}`, "User-Agent": "ruminate" },
  })
  if (!response.ok) {
    await response.body?.cancel()
    return jsonResponse({ error: "invalid_token" }, 401)
  }

  // The token must belong to THE owner, not merely any valid GitHub account —
  // the replica holds the owner's notes. Fail closed when unconfigured.
  if (!allowedGithubId) return jsonResponse({ error: "owner_not_configured" }, 403)
  const user = (await response.json().catch(() => null)) as { id?: number } | null
  if (!user || String(user.id) !== allowedGithubId) {
    return jsonResponse({ error: "forbidden" }, 403)
  }

  return null
}

/** Route /api/replica/* requests. Every route is session-guarded. */
export async function replica(request: Request, env: Env): Promise<Response> {
  const unauthorized = await requireSession(request, env.ALLOWED_GITHUB_ID)
  if (unauthorized) return unauthorized

  const { pathname } = new URL(request.url)
  if (pathname === "/api/replica/notes" && request.method === "PUT") {
    return replicaPut(request, env.DB)
  }
  if (pathname === "/api/replica/notes" && request.method === "GET") {
    return replicaPull(request, env.DB)
  }
  if (pathname === "/api/replica/status" && request.method === "GET") {
    return replicaStatus(env.DB)
  }
  return jsonResponse({ error: "not_found" }, 404)
}

/**
 * Row pull — the read half of the replica API (database-authoritative mode's
 * boot + sync source).
 *
 * - `GET /api/replica/notes` → `{ nodes, links, cursor }`, every row of both
 *   tables.
 * - `GET /api/replica/notes?since=<cursor>` → `{ nodes, links, nodeIds,
 *   linkKeys, cursor }`. Changed rows are `updated_at > since`; because the
 *   comparison can miss (clock skew) the client pulls with an overlap window,
 *   and because there are no tombstones the response ALWAYS carries the full
 *   key list of each table, so the client can delete local rows absent from
 *   them.
 */
export async function replicaPull(request: Request, db: D1Database): Promise<Response> {
  const sinceRaw = new URL(request.url).searchParams.get("since")
  const since = sinceRaw === null ? null : parseSinceCursor(sinceRaw)
  if (sinceRaw !== null && since === null) return jsonResponse({ error: "invalid_since" }, 400)

  const cursorRow = await db
    .prepare("SELECT value FROM meta WHERE key = 'replica_cursor'")
    .first<{ value: string | null }>()
  const cursor = cursorRow?.value ?? null

  if (since === null) {
    const nodes = (
      await db.prepare("SELECT id, type, text, props, updated_at FROM nodes").all<NodeRow>()
    ).results
    const links = (
      await db
        .prepare("SELECT source_id, destination_id, kind, sort_key, updated_at FROM link")
        .all<LinkRow>()
    ).results
    const body: ReplicaCorpusBody = { nodes, links, cursor }
    return jsonResponse(body)
  }

  const nodes = (
    await db
      .prepare("SELECT id, type, text, props, updated_at FROM nodes WHERE updated_at > ?1")
      .bind(since)
      .all<NodeRow>()
  ).results
  const links = (
    await db
      .prepare(
        "SELECT source_id, destination_id, kind, sort_key, updated_at FROM link WHERE updated_at > ?1",
      )
      .bind(since)
      .all<LinkRow>()
  ).results
  const nodeIds = (await db.prepare("SELECT id FROM nodes").all<{ id: string }>()).results
  const linkKeyRows = (
    await db
      .prepare("SELECT source_id, destination_id, kind FROM link")
      .all<{ source_id: string; destination_id: string; kind: string }>()
  ).results
  const body: ReplicaChangesBody = {
    nodes,
    links,
    nodeIds: nodeIds.map((row) => row.id),
    linkKeys: linkKeyRows.map((row): LinkKey => [row.source_id, row.destination_id, row.kind]),
    cursor,
  }
  return jsonResponse(body)
}

async function replicaPut(request: Request, db: D1Database): Promise<Response> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0")
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "payload_too_large" }, 413)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400)
  }

  const payload = parseReplicaPayload(body)
  if (!payload) return jsonResponse({ error: "invalid_payload" }, 400)

  const statements = planReplicaPut(payload)
  if (statements.length > 0) {
    // D1 runs a batch as a single implicit transaction: all or nothing.
    await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)))
  }

  return jsonResponse({
    ok: true,
    nodes: payload.nodes.length,
    links: payload.links.length,
    deletes: (payload.deleteNodes?.length ?? 0) + (payload.deleteLinks?.length ?? 0),
  })
}

async function replicaStatus(db: D1Database): Promise<Response> {
  const row = await db
    .prepare(
      "SELECT " +
        "(SELECT COUNT(*) FROM nodes) AS nodes, " +
        "(SELECT COUNT(*) FROM link) AS links, " +
        "(SELECT COUNT(*) FROM nodes WHERE type = 'page') AS pages, " +
        "(SELECT value FROM meta WHERE key = 'schema_version') AS schema_version, " +
        "(SELECT value FROM meta WHERE key = 'replica_cursor') AS replica_cursor",
    )
    .first<{
      nodes: number
      links: number
      pages: number
      schema_version: string | null
      replica_cursor: string | null
    }>()

  const body: ReplicaStatusBody = {
    counts: {
      nodes: row?.nodes ?? 0,
      links: row?.links ?? 0,
      pages: row?.pages ?? 0,
    },
    schema_version: row?.schema_version ?? null,
    replica_cursor: row?.replica_cursor ?? null,
  }
  return jsonResponse(body)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
