// Replica API — schema v2 rows, one corpus per user (docs/graph-schema-v2.md,
// docs/graph-storage.md, docs/multi-tenant-design.md).
//
// The client pushes row-level diffs of its node/link graph (produced by the
// local store's ingest in `src/data/sql-note-store.ts`, batched by
// `src/data/replica-sync.ts`) and pulls rows back out (full or since-cursor),
// with per-row last-writer-wins on `updated_at`. Each user's corpus lives in
// the private SQLite database of their `UserCorpus` Durable Object
// (`worker/corpus-do.ts`); this handler is auth + dispatch.
//
// Routes (wired in worker/index.ts under /api/replica/*):
//   PUT /api/replica/notes  — batch row upserts + deletes, one atomic batch
//   GET /api/replica/notes  — row pull (full, or ?since=<cursor> incremental)
//   GET /api/replica/status — row counts + schema_version + replica_cursor
//
// The wire format, validation, and SQL planning live in `replica-payload.ts`
// (shared with the client); the queries themselves run inside the DO via the
// engine-agnostic `replica-corpus.ts`.
//
// AUTH & TENANCY: `requireSession` verifies identity exactly as it always has
// — the `gh_refresh` HttpOnly cookie set by /github-auth (SameSite=Lax blocks
// cross-site sends) plus the GitHub access token as `Authorization: Bearer`,
// verified against `GET https://api.github.com/user`. The *verified* numeric
// id is then resolved against the control plane (`tenancy.ts`: users /
// allowlist tables per SIGNUP_MODE, with ALLOWED_GITHUB_ID as the fail-closed
// bootstrap), and names the tenant.
//
// TENANT-ADDRESSING INVARIANT: the corpus Durable Object is addressed ONLY by
// the server-verified GitHub id — `env.CORPUS.getByName(String(verified.id))`
// below is the single place a tenant address is minted, and its input comes
// exclusively from GitHub's response to OUR token check. No path segment,
// query param, header, or body field ever reaches it, so a client cannot name
// a tenant; it can only *be* one. (Pinned by tests in replica.test.ts.)

import type { UserCorpus } from "../corpus-do"
import { createD1SqlDriver } from "../d1-sql-driver"
import { readRefreshCookie } from "../github-cookie"
import type { Env } from "../types"
import { migrateCorpusFromD1 } from "./corpus-migration"
import { parseReplicaPayload, parseSinceCursor } from "./replica-payload"
import { resolveTenancy, type VerifiedIdentity } from "./tenancy"

/** Reject bodies larger than this (the whole row corpus is a few MB today). */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/**
 * Session guard (see the AUTH note at the top of this file). Returns the
 * verified identity, or the 401/403 response to send. `fetchImpl` is
 * injectable for tests; production uses global fetch.
 */
export async function requireSession(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedIdentity | Response> {
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

  const user = (await response.json().catch(() => null)) as {
    id?: number
    login?: string
    name?: string | null
  } | null
  if (!user || typeof user.id !== "number" || !Number.isFinite(user.id)) {
    return jsonResponse({ error: "invalid_token" }, 401)
  }

  const identity: VerifiedIdentity = {
    id: user.id,
    login: typeof user.login === "string" && user.login.length > 0 ? user.login : String(user.id),
    name: typeof user.name === "string" ? user.name : null,
  }

  const decision = await resolveTenancy(createD1SqlDriver(env.DB), identity, {
    signupMode: env.SIGNUP_MODE,
    bootstrapGithubId: env.ALLOWED_GITHUB_ID,
  })
  if (!decision.allowed) return jsonResponse({ error: decision.error }, decision.status)

  return identity
}

type CorpusStub = DurableObjectStub<UserCorpus>

/** One tenant-#1 lazy-migration check per isolate (see `ensureOwnerCorpus`). */
let ownerCorpusChecked = false

/**
 * Lazy half of the tenant-#1 migration (docs/multi-tenant-design.md §6): if
 * the signed-in user is the bootstrap owner and their DO corpus is empty
 * while the legacy D1 corpus is not, import it before serving — otherwise the
 * owner's first post-deploy since-pull would report every note absent and the
 * client would delete them locally. One status check per isolate; the
 * explicit `POST /api/admin/migrate-corpus` endpoint remains the deliberate,
 * observable way to run the same import.
 */
async function ensureOwnerCorpus(
  identity: VerifiedIdentity,
  env: Env,
  corpus: CorpusStub,
): Promise<void> {
  if (ownerCorpusChecked) return
  if (!env.ALLOWED_GITHUB_ID || String(identity.id) !== env.ALLOWED_GITHUB_ID) return
  await migrateCorpusFromD1(createD1SqlDriver(env.DB), corpus)
  ownerCorpusChecked = true
}

/** Route /api/replica/* requests. Every route is session-guarded. */
export async function replica(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  // THE tenant-addressing invariant (see the header comment): the only input
  // to the corpus address is the server-verified GitHub id.
  const corpus = env.CORPUS.getByName(String(session.id))
  await ensureOwnerCorpus(session, env, corpus)

  const { pathname } = new URL(request.url)
  if (pathname === "/api/replica/notes" && request.method === "PUT") {
    return replicaPut(request, corpus)
  }
  if (pathname === "/api/replica/notes" && request.method === "GET") {
    return replicaPull(request, corpus)
  }
  if (pathname === "/api/replica/status" && request.method === "GET") {
    return jsonResponse(await corpus.status())
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
async function replicaPull(request: Request, corpus: CorpusStub): Promise<Response> {
  const sinceRaw = new URL(request.url).searchParams.get("since")
  const since = sinceRaw === null ? null : parseSinceCursor(sinceRaw)
  if (sinceRaw !== null && since === null) return jsonResponse({ error: "invalid_since" }, 400)

  return jsonResponse(since === null ? await corpus.pullFull() : await corpus.pullSince(since))
}

async function replicaPut(request: Request, corpus: CorpusStub): Promise<Response> {
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

  return jsonResponse(await corpus.put(payload))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
