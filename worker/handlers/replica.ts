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
// id is then resolved against the control plane (`tenancy.ts`: the users
// table, and per SIGNUP_MODE an invite, with ALLOWED_GITHUB_ID as the
// fail-closed bootstrap), and names the tenant.
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
import {
  LEGACY_TIMESTAMP_CURSOR_FLOOR,
  REPLICA_PROTOCOL_HEADER,
  parseReplicaPayload,
  parseSinceCursor,
} from "./replica-payload"
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

/**
 * The oldest client protocol this Worker serves (`REPLICA_PROTOCOL` in
 * replica-payload.ts is what the current build sends). Raise the code default
 * in the same change that bumps the protocol; the `MIN_REPLICA_PROTOCOL` var
 * overrides it so a client that turns out to be harmful can be shut out from
 * the dashboard without a deploy.
 *
 * `2` is the stored note-root type value (migrations/0008). It is the first
 * time this default has been anything but `0`: until now every older client
 * was served correctly, so admitting it cost nothing. A client below 2 reads
 * `type = 'page'` roots that the migration has rewritten to `'note'`, finds no
 * notes at all, and has no way of knowing why — so it is refused instead, and
 * says so.
 *
 * The var still overrides this, and on the note-type rollout it has to be
 * raised in the dashboard BEFORE the migration runs: `npm run deploy` applies
 * migrations first, so between the rewrite and the upload the old Worker —
 * this default's old value — is the one answering.
 */
const MIN_REPLICA_PROTOCOL = 2

function minProtocol(env: Env): number {
  const raw = env.MIN_REPLICA_PROTOCOL
  return raw !== undefined && /^\d{1,6}$/.test(raw) ? Number(raw) : MIN_REPLICA_PROTOCOL
}

/** Absent or unreadable both mean "predates the header", i.e. 0. */
function clientProtocol(request: Request): number {
  const raw = request.headers.get(REPLICA_PROTOCOL_HEADER)
  return raw !== null && /^\d{1,6}$/.test(raw) ? Number(raw) : 0
}

/** Route /api/replica/* requests. Every route is session-guarded. */
export async function replica(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  // The protocol gate: after auth, so an unauthenticated caller learns
  // nothing about the wire format; before any tenant work, so a refused
  // client costs one control-plane read and nothing else.
  const minimum = minProtocol(env)
  if (clientProtocol(request) < minimum) {
    return jsonResponse({ error: "client_too_old", minimum }, 409)
  }

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
  if (pathname === "/api/replica/notes") return replicaPull(request, tenant, env)
  return jsonResponse({ ...(await corpusStatus(tenant)), replica_id: replicaId(env) })
}

/**
 * Which database this Worker answers from. Production has no `REPLICA_ID`;
 * a preview version carries its clone's D1 id (scripts/preview-deploy.mjs).
 * Every pull and status response says, so a client whose stored cursor came
 * from a different database can tell — a cursor is a row sequence, and a
 * rebuilt clone starts its sequence wherever production was that day, which
 * is behind any device that had pushed to the previous clone.
 */
const replicaId = (env: Env): string => env.REPLICA_ID || "production"

/**
 * Row pull — the read half of the replica API (database-authoritative mode's
 * boot + sync source).
 *
 * - `GET /api/replica/notes` → `{ nodes, links, cursor }`, every row of both
 *   tables, tombstones included.
 * - `GET /api/replica/notes?since=<cursor>` → the same shape with only the
 *   rows whose `seq > since` — exact, because `seq` is assigned by the
 *   database (migrations/0005), so no clock is compared and no overlap window
 *   is needed. A delete travels as an ordinary changed row carrying
 *   `deleted_at` — which is why this response carries nothing but rows (see
 *   `replica-corpus.ts`).
 */
async function replicaPull(request: Request, tenant: TenantDb, env: Env): Promise<Response> {
  const sinceRaw = new URL(request.url).searchParams.get("since")
  const parsed = sinceRaw === null ? null : parseSinceCursor(sinceRaw)
  if (sinceRaw !== null && parsed === null) return jsonResponse({ error: "invalid_since" }, 400)
  // A pre-0005 timestamp cursor, from a client on a cached bundle that
  // predates the guard in database-mode.ts. `seq > 1.7e12` would match
  // nothing, forever, and that client has no way to learn why: serve the
  // corpus, and it leaves with a sequence cursor.
  const since = parsed !== null && parsed >= LEGACY_TIMESTAMP_CURSOR_FLOOR ? null : parsed

  const body = since === null ? await corpusPullFull(tenant) : await corpusPullSince(tenant, since)
  return jsonResponse({ ...body, replica_id: replicaId(env) })
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
