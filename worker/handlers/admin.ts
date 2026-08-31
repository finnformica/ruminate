// Owner-only admin routes (wired in worker/index.ts under /api/admin/*).
//
//   POST /api/admin/migrate-corpus — run the tenant-#1 migration (§6 of
//   docs/multi-tenant-design.md): copy the legacy shared-D1 corpus into the
//   owner's `UserCorpus` DO, if and only if that DO is empty. Idempotent and
//   read-only on D1 — see `corpus-migration.ts` for the safety properties.
//
// Auth: the full `requireSession` (cookie + GitHub-verified bearer + control
// plane), *plus* an owner check — only the bootstrap `ALLOWED_GITHUB_ID`
// identity may run admin routes. The DO written to is still addressed by the
// verified id (the tenant-addressing invariant holds here too).

import { createD1SqlDriver } from "../d1-sql-driver"
import type { Env } from "../types"
import { migrateCorpusFromD1 } from "./corpus-migration"
import { requireSession } from "./replica"

export async function admin(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session

  if (!env.ALLOWED_GITHUB_ID || String(session.id) !== env.ALLOWED_GITHUB_ID) {
    return jsonResponse({ error: "forbidden" }, 403)
  }

  const { pathname } = new URL(request.url)
  if (pathname === "/api/admin/migrate-corpus" && request.method === "POST") {
    const corpus = env.CORPUS.getByName(String(session.id))
    const result = await migrateCorpusFromD1(createD1SqlDriver(env.DB), corpus)
    return jsonResponse(result)
  }
  return jsonResponse({ error: "not_found" }, 404)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
