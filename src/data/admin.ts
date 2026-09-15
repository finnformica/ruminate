import type {
  FeatureAudiencesBody,
  InvitesListBody,
  MintedInviteBody,
} from "../../worker/admin-wire"
import type { InviteSummary } from "../../worker/invites"
import type { Audience, FeatureAudiences, FeatureKey } from "./feature-flags"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"

export type { InviteSummary } from "../../worker/invites"
export { inviteState } from "../../worker/invites"

/**
 * The client half of the admin page: the five requests behind it, against
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

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
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

export async function listInvites(): Promise<InviteSummary[]> {
  const body = (await request("/invites")) as Partial<InvitesListBody> | null
  return body?.invites ?? []
}

/**
 * Mint an invite. The returned `token` is the ONLY copy that will ever exist
 * — the server stores a hash — so the caller must show the link before
 * discarding it.
 */
export async function mintInvite(mint: {
  note: string | null
  expiresInDays: number
}): Promise<MintedInviteBody> {
  return (await request("/invites", {
    method: "POST",
    body: JSON.stringify(mint),
  })) as MintedInviteBody
}

export async function revokeInvite(id: string): Promise<void> {
  await request(`/invites/${encodeURIComponent(id)}`, { method: "DELETE" })
}

/** The link an invite token opens: the invite page, on this deployment. */
export const inviteUrl = (token: string): string =>
  `${window.location.origin}/invite/${encodeURIComponent(token)}`

export async function listFeatureAudiences(): Promise<FeatureAudiences> {
  const body = (await request("/features")) as FeatureAudiencesBody
  return body.audiences
}

export async function setFeatureAudience(
  key: FeatureKey,
  audience: Audience,
): Promise<FeatureAudiences> {
  const body = (await request(`/features/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ audience }),
  })) as FeatureAudiencesBody
  return body.audiences
}
