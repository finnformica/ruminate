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

import { ensureDataVersion } from "../../src/data/data-version"
import type { UserCorpus } from "../corpus-do"
import { readRefreshCookie } from "../github-cookie"
import {
  controlPlaneDriver,
  corpusDriver,
  ensureTenantMeta,
  forTenant,
  tenantCorpus,
  type TenantDb,
} from "../tenancy-db"
import type { Env } from "../types"
import { importDoCorpus, type DoCorpusSource } from "./corpus-migration"
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

/**
 * The retiring DO for one user, or null once the binding is gone. Structural
 * (`DoCorpusSource`), so nothing downstream depends on the Cloudflare type.
 */
export function doCorpusSource(env: Env, userId: number): DoCorpusSource | null {
  const namespace = env.CORPUS as DurableObjectNamespace<UserCorpus> | undefined
  if (!namespace) return null
  return namespace.getByName(String(userId)) as unknown as DoCorpusSource
}

/** The meta keys that, once all present, mean this tenant needs no further
 * preparation — the whole warm-path check, in one indexed read. */
const READY_KEYS = ["schema_version", "do_import_at", "data_version"]

/**
 * Per-tenant preparation, in the order that matters:
 *
 * 1. seed this tenant's `meta` rows (0004 only stamped the owner's);
 * 2. import their DO corpus if it has not been imported yet — in `merge` mode,
 *    because the owner's partition holds the stale *pre-DO* rows that 0004
 *    preserved. Skipping this would let a first since-pull answer with stale
 *    key lists and make the client delete its DO-era notes. That is the
 *    destructive failure this closes;
 * 3. run the data-version transform over whatever is now there.
 *
 * The readiness marker lives in the tenant's own `meta` rows rather than in
 * isolate memory, so a second isolate (or a second Worker instance) reaches
 * the same conclusion, and the warm path costs one SELECT. Each step is
 * separately idempotent, so a half-finished preparation simply resumes.
 */
async function readyTenant(env: Env, identity: VerifiedIdentity, tenant: TenantDb): Promise<void> {
  const rows = await tenant.exec(
    "SELECT key FROM meta WHERE user_id = :tenant " +
      "AND key IN ('schema_version', 'do_import_at', 'data_version')",
  )
  if (rows.length === READY_KEYS.length) return

  await ensureTenantMeta(tenant)
  await importDoCorpus(doCorpusSource(env, identity.id), tenant, { merge: true })
  await ensureDataVersion(tenantCorpus(tenant))
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
  await readyTenant(env, session, tenant)

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
 * - `GET /api/replica/notes?since=<cursor>` → `{ nodes, links, nodeIds,
 *   linkKeys, cursor }`. Changed rows are `updated_at > since`; because the
 *   comparison can miss (clock skew) the client pulls with an overlap window.
 *   A delete now travels as an ordinary changed row carrying `deleted_at`; the
 *   full key lists are kept as belt-and-braces (see `replica-corpus.ts`).
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
