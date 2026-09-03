// Replica API — schema v3 rows, one corpus per user (docs/graph-schema-v2.md,
// docs/graph-storage.md, docs/multi-tenant-design.md).
//
// The client pushes row-level diffs of its node/link graph (produced by the
// local store's ingest in `src/data/sql-note-store.ts`, batched by
// `src/data/replica-sync.ts`) and pulls rows back out (full or since-cursor),
// with per-row last-writer-wins on `updated_at`. Every user's corpus lives in
// one D1 database, in the rows whose `user_id` is theirs.
//
// Routes (wired in worker/index.ts under /api/replica/*):
//   PUT /api/replica/notes  — batch row upserts + deletes, one atomic batch
//   GET /api/replica/notes  — row pull (full, or ?since=<cursor> incremental)
//   GET /api/replica/status — row counts + schema_version + replica_cursor
//
// The wire format, validation, and SQL planning live in `replica-payload.ts`
// (shared with the client); the queries run through `replica-corpus.ts`
// against a `TenantDb`.
//
// AUTH & TENANCY: `requireSession` verifies identity exactly as it always has
// — the `gh_refresh` HttpOnly cookie set by /github-auth (SameSite=Lax blocks
// cross-site sends) plus the GitHub access token as `Authorization: Bearer`,
// verified against `GET https://api.github.com/user`. The *verified* numeric
// id is then resolved against the control plane (`tenancy.ts`: users /
// allowlist tables per SIGNUP_MODE, with ALLOWED_GITHUB_ID as the fail-closed
// bootstrap), and names the tenant.
//
// TENANT-SCOPING INVARIANT: the only handle this file hands to corpus code is
// `forTenant(corpusDriver(env), session)` — minted from the identity GitHub
// returned for OUR token check, and from nothing else. No path segment, query
// param, header, or body field reaches it, so a client cannot name a tenant;
// it can only *be* one. Under column-scoped tenancy that mint is backed by a
// runtime guard: `TenantDb` refuses any statement that does not carry
// `user_id` + `:tenant` (worker/tenancy-db.ts). Both halves are pinned by the
// adversarial tests in replica.test.ts.

import { readRefreshCookie } from "../github-cookie"
import {
  controlPlaneDriver,
  corpusDriver,
  ensureTenantMeta,
  forTenant,
  type TenantDb,
} from "../tenancy-db"
import type { Env } from "../types"
import { corpusPullFull, corpusPullSince, corpusPut, corpusStatus } from "./replica-corpus"
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

  const decision = await resolveTenancy(controlPlaneDriver(env), identity, {
    signupMode: env.SIGNUP_MODE,
    bootstrapGithubId: env.ALLOWED_GITHUB_ID,
  })
  if (!decision.allowed) return jsonResponse({ error: decision.error }, decision.status)

  return identity
}

/** The meta keys that, once both present, mean this tenant is ready — the
 * whole warm-path check, in one indexed read. */
const READY_KEYS = ["schema_version", "replica_cursor"]

/**
 * Per-tenant preparation: seed this tenant's `meta` rows, which migration
 * `0004` only stamped for the owner. That is all a tenant needs — data
 * migrations are one-shot operations run against D1 directly, never work the
 * request path does on the way past.
 *
 * The marker is the tenant's own `meta` rows rather than isolate memory, so a
 * second isolate reaches the same conclusion and the warm path costs one
 * SELECT. The seed is idempotent, so a half-finished one simply resumes.
 */
async function readyTenant(tenant: TenantDb): Promise<void> {
  const rows = await tenant.exec(
    "SELECT key FROM meta WHERE user_id = :tenant " +
      "AND key IN ('schema_version', 'replica_cursor')",
  )
  if (rows.length < READY_KEYS.length) await ensureTenantMeta(tenant)
}

/** Route /api/replica/* requests. Every route is session-guarded. */
export async function replica(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  const { pathname } = new URL(request.url)
  const method = request.method
  const known =
    (pathname === "/api/replica/notes" && (method === "PUT" || method === "GET")) ||
    (pathname === "/api/replica/status" && method === "GET")
  if (!known) return jsonResponse({ error: "not_found" }, 404)

  // THE tenant-scoping invariant (see the header comment): the only input to
  // the tenant handle is the server-verified GitHub id.
  const tenant = forTenant(corpusDriver(env), session)
  await readyTenant(tenant)

  if (pathname === "/api/replica/notes" && method === "PUT") return replicaPut(request, tenant)
  if (pathname === "/api/replica/notes") return replicaPull(request, tenant)
  return jsonResponse(await corpusStatus(tenant))
}

/**
 * Row pull — the read half of the replica API (database-authoritative mode's
 * boot + sync source).
 *
 * - `GET /api/replica/notes` → `{ nodes, links, cursor }`, every row of both
 *   tables, tombstones included.
 * - `GET /api/replica/notes?since=<cursor>` → the same shape with only the
 *   rows whose `updated_at > since`; because the comparison can miss (clock
 *   skew) the client pulls with an overlap window. A delete travels as an
 *   ordinary changed row carrying `deleted_at` — which is why this response no
 *   longer carries the corpus-wide key lists (see `replica-corpus.ts`).
 */
async function replicaPull(request: Request, tenant: TenantDb): Promise<Response> {
  const sinceRaw = new URL(request.url).searchParams.get("since")
  const since = sinceRaw === null ? null : parseSinceCursor(sinceRaw)
  if (sinceRaw !== null && since === null) return jsonResponse({ error: "invalid_since" }, 400)

  return jsonResponse(
    since === null ? await corpusPullFull(tenant) : await corpusPullSince(tenant, since),
  )
}

async function replicaPut(request: Request, tenant: TenantDb): Promise<Response> {
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

  return jsonResponse(await corpusPut(tenant, payload))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
