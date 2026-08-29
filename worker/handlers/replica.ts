// D1 replica API (graph storage, phase 3 skeleton — see docs/graph-storage.md).
//
// The client pushes its parsed note graph (note + blocks + links + view state
// rows, produced by `src/data/doc-to-rows.ts`) into the D1 database behind
// this Worker. Git/markdown remains the source of truth: the replica is
// derived, rebuildable, and never written back to the repo.
//
// Routes (wired in worker/index.ts under /api/replica/*):
//   PUT /api/replica/notes  — batch upsert, one atomic D1 batch
//   GET /api/replica/status — row counts + schema_version + replica_cursor
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

/** Reject bodies larger than this (the whole note corpus is ~4 MB today). */
const MAX_BODY_BYTES = 16 * 1024 * 1024

const LINK_KINDS = ["wikilink", "transclusion", "tag"] as const

interface NoteRow {
  id: string
  content: string
  updated_at: number | null
}

interface BlockRow {
  id: string
  note_id: string
  parent_id: string | null
  position: number
  content: string
}

interface LinkRow {
  from_block: string
  to_note: string | null
  to_block: string | null
  kind: (typeof LINK_KINDS)[number]
}

/** One note's full replica record, as produced by `src/data/doc-to-rows.ts`. */
interface ReplicaNoteEntry {
  note: NoteRow
  blocks: BlockRow[]
  links: LinkRow[]
  /** Collapsed block ids (canonical view state); empty clears the row. */
  view_state: string[]
}

export interface ReplicaPutPayload {
  notes: ReplicaNoteEntry[]
  /** Note ids to remove from the replica (deleted or renamed away). */
  deletes?: string[]
  /** Opaque client marker of the replicated repo state (e.g. git HEAD sha). */
  cursor?: string
}

/** A planned SQL statement: the pure, D1-free representation of the write. */
export interface SqlStatement {
  sql: string
  params: (string | number | null)[]
}

const isString = (x: unknown): x is string => typeof x === "string"
const isStringOrNull = (x: unknown): x is string | null => x === null || typeof x === "string"

function parseNoteEntry(x: unknown): ReplicaNoteEntry | null {
  if (typeof x !== "object" || x === null) return null
  const entry = x as Record<string, unknown>
  const note = entry.note as Record<string, unknown> | null | undefined
  if (
    typeof note !== "object" ||
    note === null ||
    !isString(note.id) ||
    note.id.length === 0 ||
    !isString(note.content) ||
    !(note.updated_at === null || typeof note.updated_at === "number")
  ) {
    return null
  }
  if (!Array.isArray(entry.blocks) || !Array.isArray(entry.links)) return null
  for (const b of entry.blocks as Record<string, unknown>[]) {
    if (
      typeof b !== "object" ||
      b === null ||
      !isString(b.id) ||
      b.note_id !== note.id ||
      !isStringOrNull(b.parent_id) ||
      typeof b.position !== "number" ||
      !isString(b.content)
    ) {
      return null
    }
  }
  for (const l of entry.links as Record<string, unknown>[]) {
    if (
      typeof l !== "object" ||
      l === null ||
      !isString(l.from_block) ||
      !isStringOrNull(l.to_note) ||
      !isStringOrNull(l.to_block) ||
      !LINK_KINDS.includes(l.kind as LinkRow["kind"])
    ) {
      return null
    }
  }
  if (!Array.isArray(entry.view_state) || !(entry.view_state as unknown[]).every(isString)) {
    return null
  }
  return {
    note: { id: note.id, content: note.content, updated_at: note.updated_at as number | null },
    blocks: (entry.blocks as BlockRow[]).map((b) => ({
      id: b.id,
      note_id: b.note_id,
      parent_id: b.parent_id,
      position: b.position,
      content: b.content,
    })),
    links: (entry.links as LinkRow[]).map((l) => ({
      from_block: l.from_block,
      to_note: l.to_note,
      to_block: l.to_block,
      kind: l.kind,
    })),
    view_state: entry.view_state as string[],
  }
}

/**
 * Validate an untrusted request body into a `ReplicaPutPayload`, or null.
 * Hand-rolled (no schema library) to keep the Worker bundle lean.
 */
export function parseReplicaPayload(body: unknown): ReplicaPutPayload | null {
  if (typeof body !== "object" || body === null) return null
  const raw = body as Record<string, unknown>
  if (!Array.isArray(raw.notes)) return null
  const notes: ReplicaNoteEntry[] = []
  for (const entry of raw.notes) {
    const parsed = parseNoteEntry(entry)
    if (!parsed) return null
    notes.push(parsed)
  }
  if (raw.deletes !== undefined && !(Array.isArray(raw.deletes) && raw.deletes.every(isString))) {
    return null
  }
  if (raw.cursor !== undefined && !isString(raw.cursor)) return null
  return { notes, deletes: raw.deletes as string[] | undefined, cursor: raw.cursor as string }
}

/**
 * Plan the SQL for one replica push. Pure: returns statements + bind params;
 * the wiring below turns them into a single `db.batch()` (one transaction).
 *
 * Per note the write is a replace: upsert the note row first (blocks FK on
 * it), drop its old links (via its old blocks) and blocks, then insert the
 * new rows. Link inserts use OR IGNORE so the unique edge index makes replays
 * idempotent. View state mirrors the sidecar: a row when anything is
 * collapsed, no row otherwise.
 */
export function planReplicaPut(payload: ReplicaPutPayload): SqlStatement[] {
  const statements: SqlStatement[] = []
  const dropNoteGraph = (noteId: string) => {
    statements.push({
      sql: "DELETE FROM links WHERE from_block IN (SELECT id FROM blocks WHERE note_id = ?1)",
      params: [noteId],
    })
    statements.push({ sql: "DELETE FROM blocks WHERE note_id = ?1", params: [noteId] })
  }

  for (const { note, blocks, links, view_state } of payload.notes) {
    statements.push({
      sql:
        "INSERT INTO notes (id, content, updated_at) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT (id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
      params: [note.id, note.content, note.updated_at],
    })
    dropNoteGraph(note.id)
    for (const b of blocks) {
      statements.push({
        sql: "INSERT INTO blocks (id, note_id, parent_id, position, content) VALUES (?1, ?2, ?3, ?4, ?5)",
        params: [b.id, b.note_id, b.parent_id, b.position, b.content],
      })
    }
    for (const l of links) {
      statements.push({
        sql: "INSERT OR IGNORE INTO links (from_block, to_note, to_block, kind) VALUES (?1, ?2, ?3, ?4)",
        params: [l.from_block, l.to_note, l.to_block, l.kind],
      })
    }
    if (view_state.length > 0) {
      statements.push({
        sql:
          "INSERT INTO view_state (note_id, collapsed) VALUES (?1, ?2) " +
          "ON CONFLICT (note_id) DO UPDATE SET collapsed = excluded.collapsed",
        params: [note.id, JSON.stringify([...new Set(view_state)].sort())],
      })
    } else {
      statements.push({ sql: "DELETE FROM view_state WHERE note_id = ?1", params: [note.id] })
    }
  }

  for (const noteId of payload.deletes ?? []) {
    dropNoteGraph(noteId)
    statements.push({ sql: "DELETE FROM notes WHERE id = ?1", params: [noteId] })
    statements.push({ sql: "DELETE FROM view_state WHERE note_id = ?1", params: [noteId] })
  }

  if (payload.cursor !== undefined) {
    statements.push({
      sql: "UPDATE meta SET value = ?1 WHERE key = 'replica_cursor'",
      params: [payload.cursor],
    })
  }

  return statements
}

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
  if (pathname === "/api/replica/status" && request.method === "GET") {
    return replicaStatus(env.DB)
  }
  return jsonResponse({ error: "not_found" }, 404)
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

  return jsonResponse({
    counts: {
      notes: row?.notes ?? 0,
      blocks: row?.blocks ?? 0,
      links: row?.links ?? 0,
      view_state: row?.view_state ?? 0,
    },
    schema_version: row?.schema_version ?? null,
    replica_cursor: row?.replica_cursor ?? null,
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
