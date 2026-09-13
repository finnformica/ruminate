// Search over HTTP, for the browser — and the operator's handle on the index
// (docs/semantic-search.md).
//
// Two routes, one implementation:
//
//   GET  /api/search?q=…&limit=&cursor=   hybrid search over the caller's corpus
//   POST /api/search/index                run one incremental indexing pass
//
// The search route is the SAME `hybridSearch` the MCP tool calls
// (worker/search/engine.ts) — the whole point of this feature is that there is
// one ranker, not one per caller. What differs is only who is asking and how
// they proved it: MCP presents a minted token with a note scope, this presents
// a browser session, exactly as the replica does.
//
// AUTH & TENANCY: `requireSession` — the `gh_refresh` cookie plus a GitHub
// access token, verified against GitHub, then resolved against the control
// plane. The verified id is the only input to `forTenant`, and to the Vectorize
// namespace. A caller cannot name a tenant; it can only be one.
//
// ## Why the app does not call this yet
//
// Deliberately. The app's search today makes ZERO network calls and works
// offline — everything runs over the local sqlite-wasm corpus. Calling this
// would make search an online-only escalation, and what should happen to a
// person typing in the search box with no connection is a product question
// with more than one defensible answer (fall back silently to local fuzzy?
// say so? only escalate on an explicit gesture?). This PR ships the endpoint
// and leaves that question open rather than answering it by accident.
//
// ## Why indexing is a request and not a cron trigger
//
// Because embedding a corpus is an operator's decision the first time — it
// sends three tenants' private notes through a model — and a cron trigger in
// wrangler.jsonc would make it happen on the next deploy, silently. The
// mechanism is here and is exercised; adding
// `"triggers": { "crons": ["*/5 * * * *"] }` is one line the operator adds
// when they have decided to.

import { hybridSearch } from "../search/engine"
import { resetCursor, syncVectors } from "../search/sync"
import { semanticFor } from "../search/vector-index"
import { scopedGraph } from "../mcp/graph-access"
import type { Grant } from "../mcp/grant"
import { corpusDriver, forTenant, type TenantDb } from "../tenancy-db"
import type { Env } from "../types"
import { requireSession } from "./replica"

export const SEARCH_PATH = "/api/search"
const SEARCH_INDEX_PATH = "/api/search/index"

/** Default page size, and the cap an over-large `limit` lands on — the same
 * numbers the MCP tool uses, because it is the same search. */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * The browser session's grant: its own corpus, every note, read only.
 *
 * The person IS the tenant, so the note scope that exists to fence an agent in
 * has nothing to fence here — but `hybridSearch` takes a `ScopedGraph` and a
 * `ScopedGraph` is built from a grant, so the grant is stated rather than
 * bypassed. `noteIds: null` is the unrestricted reading, and `permissions`
 * holds `read` alone: nothing on this path writes, and a grant that cannot
 * write is one fewer thing to get wrong if it ever does.
 */
const sessionGrant = (userId: number): Grant => ({
  tokenId: "session",
  userId,
  name: "browser session",
  permissions: new Set(["read"] as const),
  noteIds: null,
  expiresAt: null,
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

export async function search(
  request: Request,
  env: Env,
  // Injectable for the tests, exactly as the images and token routes take it:
  // GitHub's `/user` is the one outbound call on this path.
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  const tenant = forTenant(corpusDriver(env), session)
  const url = new URL(request.url)

  if (url.pathname === SEARCH_INDEX_PATH) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405)
    return index(tenant, env, url)
  }
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405)

  const query = url.searchParams.get("q") ?? ""
  if (query.trim() === "") return json({ error: "missing_query" }, 400)

  const limit = clamp(url.searchParams.get("limit"), DEFAULT_LIMIT)
  const cursor = url.searchParams.get("cursor")
  if (cursor !== null && !/^\d{1,9}$/.test(cursor)) return json({ error: "bad_cursor" }, 400)

  const grant = sessionGrant(session.id)
  const graph = await scopedGraph(tenant, grant)
  const found = await hybridSearch({
    graph,
    query,
    limit,
    offset: cursor === null ? 0 : Number(cursor),
    semantic: semanticFor(env, tenant),
  })
  return json(found)
}

/**
 * One indexing pass, or — with `?reset=1` — a full rebuild.
 *
 * `reset` moves the cursor back to zero so the next pass re-reads every row.
 * It is the lever for the changes an incremental pass cannot see, because
 * nothing about the ROWS changed: a different embedding model, a different
 * chunker, a different index.
 */
async function index(tenant: TenantDb, env: Env, url: URL): Promise<Response> {
  const semantic = semanticFor(env, tenant)
  if (!semantic) return json({ error: "semantic_search_not_configured" }, 501)
  if (url.searchParams.get("reset") === "1") await resetCursor(tenant)
  return json(await syncVectors(tenant, semantic))
}

/** A page size: absent or unparseable means the default, over-large is capped
 * rather than refused (the reading `limitArg` takes in the MCP tools). */
function clamp(value: string | null, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return fallback
  return Math.min(parsed, MAX_LIMIT)
}
