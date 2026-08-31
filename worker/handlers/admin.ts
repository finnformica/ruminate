// Owner-only admin routes (wired in worker/index.ts under /api/admin/*).
//
//   POST /api/admin/import-do-corpus — the DO→D1 import
//   (docs/multi-tenant-design.md, "Decision reversal" → deploy-day runbook):
//   for the owner and every user in the control plane's `users` table, copy
//   that user's `UserCorpus` Durable Object rows into their `user_id`-scoped
//   partition of D1. Read-only on the DOs, idempotent, and marked per tenant
//   so re-runs are cheap. Query params:
//     ?merge=1  LWW-merge into a non-empty partition instead of refusing it —
//               what the OWNER needs, whose partition still holds the pre-DO
//               rows migration 0004 preserved.
//     ?force=1  re-run for tenants already marked imported.
//
// Auth: the full `requireSession` (cookie + GitHub-verified bearer + control
// plane), *plus* an owner check — only the bootstrap `ALLOWED_GITHUB_ID`
// identity may run admin routes.
//
// This route writes into OTHER users' partitions, which is why it is the one
// caller of `forAdminImport` (worker/tenancy-db.ts): the ids it may name come
// from the control-plane `users` table, never from the request. It retires
// together with the DO class.

import { controlPlaneDriver, corpusDriver, ensureTenantMeta, forAdminImport } from "../tenancy-db"
import type { Env } from "../types"
import { importDoCorpus, type CorpusImportResult } from "./corpus-migration"
import { doCorpusSource, requireSession } from "./replica"

/** Every tenant id the control plane knows, plus the bootstrap owner. */
async function knownUserIds(env: Env, ownerId: number): Promise<number[]> {
  const ids = new Set<number>([ownerId])
  try {
    const rows = await controlPlaneDriver(env).exec("SELECT github_id FROM users")
    for (const row of rows) ids.add(Number(row.github_id))
  } catch {
    // Control-plane tables missing: the owner is the only tenant there can be.
  }
  return [...ids].filter((id) => Number.isSafeInteger(id))
}

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

  const url = new URL(request.url)
  if (url.pathname === "/api/admin/import-do-corpus" && request.method === "POST") {
    const merge = url.searchParams.get("merge") === "1"
    const force = url.searchParams.get("force") === "1"
    const driver = corpusDriver(env)
    const results: CorpusImportResult[] = []
    for (const userId of await knownUserIds(env, session.id)) {
      const tenant = forAdminImport(driver, userId)
      await ensureTenantMeta(tenant)
      results.push(await importDoCorpus(doCorpusSource(env, userId), tenant, { merge, force }))
    }
    return jsonResponse({ ok: true, results })
  }
  return jsonResponse({ error: "not_found" }, 404)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
