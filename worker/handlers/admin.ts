// The admin API — `/api/admin/*` (docs/multi-tenant-design.md §3).
//
// The bootstrap owner's controls: the feature flags
// (src/data/feature-flags.ts). Reached by the admin page in the browser, so
// it authenticates like every other browser-facing route — `requireSession`,
// the cookie + GitHub token check — and then asks one more question: is this
// verified id the admin? Nobody else gets past the first line, whatever the
// path.
//
// Routes:
//   GET    /api/admin/features        — every flag's audience
//   PUT    /api/admin/features/<key>  — set one flag's audience

import { isAudience, isFeatureKey } from "../../src/data/feature-flags"
import type { FeatureAudiencesBody } from "../admin-wire"
import { featureAudiences, isAdmin, setFeatureAudience } from "../features"
import { controlPlaneDriver } from "../tenancy-db"
import type { Env } from "../types"
import { requireSession } from "./replica"

export const ADMIN_PREFIX = "/api/admin"

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

/** Route `/api/admin/*`. Every route is session-guarded AND admin-only. */
export async function admin(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session
  // The same 404 a route that does not exist gets: the admin API confirms
  // nothing about itself to anyone but the admin.
  if (!isAdmin(env, session.id)) return json({ error: "not_found" }, 404)

  const { pathname } = new URL(request.url)
  const segments = pathname
    .slice(ADMIN_PREFIX.length)
    .replace(/^\//, "")
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeURIComponent)
  const control = controlPlaneDriver(env)

  try {
    if (segments[0] === "features") {
      if (segments.length === 1) {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405)
        const body: FeatureAudiencesBody = { audiences: await featureAudiences(control) }
        return json(body)
      }
      if (segments.length === 2) {
        if (request.method !== "PUT") return json({ error: "method_not_allowed" }, 405)
        const key = segments[1]
        if (!isFeatureKey(key)) return json({ error: "not_found" }, 404)
        const raw = (await request.json().catch(() => null)) as { audience?: unknown } | null
        if (!raw || !isAudience(raw.audience)) {
          return json(
            { error: "invalid_request", detail: "`audience` must be off, admin or everyone." },
            400,
          )
        }
        await setFeatureAudience(control, key, raw.audience, session.id)
        const body: FeatureAudiencesBody = { audiences: await featureAudiences(control) }
        return json(body)
      }
    }
  } catch {
    // The feature_flags table (migrations/0013) is not there yet.
    return json(
      {
        error: "admin_unavailable",
        detail: "The admin tables are not set up on this server yet (a migration is pending).",
      },
      503,
    )
  }

  return json({ error: "not_found" }, 404)
}
