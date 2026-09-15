import type {
  CreateShareBody,
  GivenShare,
  ReceivedShareSummary,
  SharesListBody,
  SliceBody,
} from "../../worker/shares/wire"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"

export type {
  CreateShareBody,
  GivenShare,
  ReceivedShareSummary,
  SliceBody,
} from "../../worker/shares/wire"

/**
 * The client half of sharing (docs/sharing.md): the four requests behind the
 * Settings panel and the shared runtime (`shared-mode.ts`).
 *
 * Authenticated exactly as the replica calls are — same-origin, so the
 * `gh_refresh` cookie rides along, plus the GitHub access token as a bearer
 * (`ensureFreshToken` proactively, `withAuthRetry` refreshing once and
 * retrying on 401) — because every route is guarded by the same
 * `requireSession` (worker/handlers/shares.ts).
 */

const ENDPOINT = "/api/shares"

class SharesError extends Error {
  constructor(
    message: string,
    /** The HTTP status, so a caller can tell a refusal (4xx) from a network
     * failure and stop retrying the former. */
    readonly status: number,
    /** The machine-readable code (`permission_denied`, `outside_share`…). */
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = "SharesError"
  }
}

async function request(
  path: string,
  init: RequestInit & { fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const { fetchImpl = fetch, ...rest } = init
  await ensureFreshToken()
  if (!getAccessToken()) throw new SharesError("Not signed in.", 401)
  const response = await withAuthRetry(async () => {
    const token = getAccessToken()
    if (!token) throw new SharesError("Not signed in.", 401)
    const res = await fetchImpl(`${ENDPOINT}${path}`, {
      ...rest,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...rest.headers,
      },
    })
    if (res.status === 401) {
      // Shaped so `isAuthError` recognizes it → one refresh + retry.
      throw Object.assign(new Error("Shares request rejected (401)"), { status: 401 })
    }
    return res
  })

  const body = (await response.json().catch(() => null)) as {
    error?: string
    detail?: string
  } | null

  if (!response.ok) {
    // `detail` is written for a person ("Pick at least one note"), so prefer
    // it; `error` is the machine-readable code behind it.
    throw new SharesError(
      body?.detail ?? body?.error ?? `Request failed (${response.status}).`,
      response.status,
      body?.error ?? null,
    )
  }
  return body
}

/** The shares I have given and the shares addressed to me. */
export async function listShares(fetchImpl?: typeof fetch): Promise<SharesListBody> {
  const body = (await request("", { fetchImpl })) as Partial<SharesListBody> | null
  return {
    me: { email: body?.me?.email ?? "" },
    given: body?.given ?? [],
    received: body?.received ?? [],
  }
}

export async function createShare(share: CreateShareBody): Promise<GivenShare> {
  const body = (await request("", { method: "POST", body: JSON.stringify(share) })) as {
    share: GivenShare
  }
  return body.share
}

export async function revokeShare(id: string): Promise<void> {
  await request(`/${encodeURIComponent(id)}`, { method: "DELETE" })
}

/** The slice of a share I received: every live node and link beneath its roots. */
export async function pullShare(id: string, fetchImpl?: typeof fetch): Promise<SliceBody> {
  const body = (await request(`/${encodeURIComponent(id)}/notes`, { fetchImpl })) as SliceBody
  return { nodes: body.nodes ?? [], links: body.links ?? [] }
}

/** A person's name for a share's owner: their display name, else their login. */
export const shareOwnerName = (share: ReceivedShareSummary): string =>
  share.owner.name?.trim() || share.owner.login
