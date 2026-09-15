import type { FeatureAudiencesBody } from "../../worker/admin-wire"
import type { Audience, FeatureAudiences, FeatureKey } from "./feature-flags"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"

/**
 * The client half of the admin page: the requests behind it, against
 * `/api/admin/*` (worker/handlers/admin.ts). Authenticated exactly as the
 * shares calls are — same-origin, so the `gh_refresh` cookie rides along,
 * plus the GitHub access token as a bearer — and answered only for the
 * admin; anyone else gets the 404 a missing route gets.
 */

const ENDPOINT = "/api/admin"

class AdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "AdminError"
  }
}

async function adminRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  await ensureFreshToken()
  if (!getAccessToken()) throw new AdminError("Not signed in.", 401)
  const response = await withAuthRetry(async () => {
    const token = getAccessToken()
    if (!token) throw new AdminError("Not signed in.", 401)
    const res = await fetch(`${ENDPOINT}${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    })
    if (res.status === 401) {
      throw Object.assign(new Error("Admin request rejected (401)"), { status: 401 })
    }
    return res
  })

  const body = (await response.json().catch(() => null)) as {
    error?: string
    detail?: string
  } | null

  if (!response.ok) {
    throw new AdminError(
      body?.detail ?? body?.error ?? `Request failed (${response.status}).`,
      response.status,
    )
  }
  return body
}

export async function listFeatureAudiences(): Promise<FeatureAudiences> {
  const body = (await adminRequest("/features")) as FeatureAudiencesBody
  return body.audiences
}

export async function setFeatureAudience(
  key: FeatureKey,
  audience: Audience,
): Promise<FeatureAudiences> {
  const body = (await adminRequest(`/features/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ audience }),
  })) as FeatureAudiencesBody
  return body.audiences
}
