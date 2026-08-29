// D1 replica API (graph storage, phase 3 — see docs/graph-storage.md).
//
// The client pushes its parsed note graph (note + blocks + links + view state
// rows, produced by `src/data/doc-to-rows.ts` and batched by
// `src/data/replica-sync.ts`) into the D1 database behind this Worker.
// Git/markdown remains the source of truth: the replica is derived,
// rebuildable, and never written back to the repo.
//
// Routes (wired in worker/index.ts under /api/replica/*):
//   PUT /api/replica/notes  — batch upsert, one atomic D1 batch
//   GET /api/replica/notes  — corpus pull (full, or ?since=<cursor> incremental)
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
//   2. the GitHub access token the client keeps for git sync, sent here as
//      `Authorization: Bearer <token>` and verified against the GitHub API —
//      the same `GET /user` check /github-auth performs when minting a session.
// Requests failing either check are rejected with 401.

import { readRefreshCookie } from "../github-cookie"
import type { Env } from "../types"
import {
  buildPullNotes,
  parseReplicaPayload,
  parseSinceCursor,
  planReplicaPut,
  type NoteRow,
  type ReplicaChangesBody,
  type ReplicaCorpusBody,
  type ReplicaStatusBody,
  type ViewStateRow,
} from "./replica-payload"

/** Reject bodies larger than this (the whole note corpus is ~4 MB today). */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/**
 * Session guard (see the AUTH note at the top of this file). Returns null when
 * the request is authenticated, or the 401 response to send. `fetchImpl` is
 * injectable for tests; production uses global fetch.
 */
export async function requireSession(
  request: Request,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  if (!readRefreshCookie(request)) return jsonResponse({ error: "unauthenticated" }, 401)

  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")
  if (!match) return jsonResponse({ error: "missing_token" }, 401)

  const response = await fetchImpl("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${match[1]}`, "User-Agent": "ruminate" },
  })
  // Drain the body so the connection can be reused; the content is irrelevant.
  await response.body?.cancel()
  if (!response.ok) return jsonResponse({ error: "invalid_token" }, 401)

  return null
}

/** Route /api/replica/* requests. Every route is session-guarded. */
export async function replica(request: Request, env: Env): Promise<Response> {
  const unauthorized = await requireSession(request)
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
 * Corpus pull — the read half of the replica API (database-authoritative
 * mode's boot + sync source).
 *
 * - `GET /api/replica/notes` → `{ notes: [{note, view_state}], cursor }`,
 *   the full corpus. Note rows + view state only: blocks/links are derivable
 *   client-side from `notes.content` (see `ReplicaPullNote`).
 * - `GET /api/replica/notes?since=<cursor>` → `{ changed, ids, cursor }`.
 *   The replica tracks no per-note change time beyond `notes.updated_at`
 *   (the frontmatter save timestamp), so "changed" is
 *   `updated_at > since-timestamp`. Because that comparison can miss edits
 *   (null `updated_at`, clock skew) the client pulls with an overlap window,
 *   and because there are no tombstones the response ALWAYS carries `ids` —
 *   every note id in the replica — so the client can delete local notes
 *   absent from it.
 */
export async function replicaPull(request: Request, db: D1Database): Promise<Response> {
  const sinceRaw = new URL(request.url).searchParams.get("since")
  const since = sinceRaw === null ? null : parseSinceCursor(sinceRaw)
  if (sinceRaw !== null && since === null) return jsonResponse({ error: "invalid_since" }, 400)

  const cursorRow = await db
    .prepare("SELECT value FROM meta WHERE key = 'replica_cursor'")
    .first<{ value: string | null }>()
  const cursor = cursorRow?.value ?? null
  const viewRows = (
    await db.prepare("SELECT note_id, collapsed FROM view_state").all<ViewStateRow>()
  ).results

  if (since === null) {
    const noteRows = (await db.prepare("SELECT id, content, updated_at FROM notes").all<NoteRow>())
      .results
    const body: ReplicaCorpusBody = { notes: buildPullNotes(noteRows, viewRows), cursor }
    return jsonResponse(body)
  }

  const changedRows = (
    await db
      .prepare(
        "SELECT id, content, updated_at FROM notes WHERE updated_at IS NOT NULL AND updated_at > ?1",
      )
      .bind(since)
      .all<NoteRow>()
  ).results
  const idRows = (await db.prepare("SELECT id FROM notes").all<{ id: string }>()).results
  const body: ReplicaChangesBody = {
    changed: buildPullNotes(changedRows, viewRows),
    ids: idRows.map((row) => row.id),
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
    notes: payload.notes.length,
    deletes: payload.deletes?.length ?? 0,
  })
}

async function replicaStatus(db: D1Database): Promise<Response> {
  const row = await db
    .prepare(
      "SELECT " +
        "(SELECT COUNT(*) FROM notes) AS notes, " +
        "(SELECT COUNT(*) FROM blocks) AS blocks, " +
        "(SELECT COUNT(*) FROM links) AS links, " +
        "(SELECT COUNT(*) FROM view_state) AS view_state, " +
        "(SELECT value FROM meta WHERE key = 'schema_version') AS schema_version, " +
        "(SELECT value FROM meta WHERE key = 'replica_cursor') AS replica_cursor",
    )
    .first<{
      notes: number
      blocks: number
      links: number
      view_state: number
      schema_version: string | null
      replica_cursor: string | null
    }>()

  const body: ReplicaStatusBody = {
    counts: {
      notes: row?.notes ?? 0,
      blocks: row?.blocks ?? 0,
      links: row?.links ?? 0,
      view_state: row?.view_state ?? 0,
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
