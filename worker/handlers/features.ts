// `GET /api/features` — what the signed-in caller may use.
//
// The client's view of the feature flags (src/data/feature-flags.ts): every
// registered feature as on or off FOR THIS CALLER, plus whether the caller
// is the admin. Purely informational — the features' own routes enforce the
// flags — so a client that ignores it draws panels that refuse.

import type { FeaturesBody } from "../../src/data/feature-flags"
import { enabledFor, featureAudiences, isAdmin } from "../features"
import { controlPlaneDriver } from "../tenancy-db"
import type { Env } from "../types"
import { requireSession } from "./replica"

export const FEATURES_PATH = "/api/features"

export async function features(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const session = await requireSession(request, env, fetchImpl)
  if (session instanceof Response) return session
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    })
  }
  const admin = isAdmin(env, session.id)
  const body: FeaturesBody = {
    admin,
    features: enabledFor(await featureAudiences(controlPlaneDriver(env)), admin),
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}
