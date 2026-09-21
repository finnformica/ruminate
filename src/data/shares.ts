import type { GraphDiff } from "../../worker/handlers/replica-payload"
import type {
  CreateShareBody,
  GivenShare,
  ReceivedShareSummary,
  SharesListBody,
  SliceBody,
} from "../../worker/shares/wire"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"
import { writerHeaders } from "./writer-identity"

export type {
  CreateShareBody,
  GivenShare,
  ReceivedShareSummary,
  ShareView,
  SliceBody,
} from "../../worker/shares/wire"
export type SharePermission = "read" | "write" | "delete"

/**
 * The client half of sharing (docs/sharing.md): the five requests behind the
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

/** Is this a refusal the server will repeat if asked again? */
export const isSharesRefusal = (error: unknown): boolean =>
  error instanceof SharesError && error.status >= 400 && error.status < 500

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

/** The slice of a share I received: every live node and link beneath its
 * root, and the owner's view of it as it stands now. */
export async function pullShare(id: string, fetchImpl?: typeof fetch): Promise<SliceBody> {
  const body = (await request(`/${encodeURIComponent(id)}/notes`, { fetchImpl })) as SliceBody
  return { nodes: body.nodes ?? [], links: body.links ?? [], view: body.view }
}

/** Push a row diff into a share I received. Refused as a whole when any row
 * would leave the slice or needs a verb the share lacks. */
export async function pushShare(
  id: string,
  diff: GraphDiff,
  options: { keepalive?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await request(`/${encodeURIComponent(id)}/notes`, {
    method: "PUT",
    headers: writerHeaders(),
    body: JSON.stringify({ nodes: diff.nodes, links: diff.links }),
    keepalive: options.keepalive,
    fetchImpl: options.fetchImpl,
  })
}

/** "read + write", for lists and summaries. */
export const describeSharePermissions = (permissions: readonly SharePermission[]): string =>
  (permissions.length === 0 ? ["read"] : permissions).join(" + ")

/** A person's name for a share's owner: their display name, else their login. */
export const shareOwnerName = (share: ReceivedShareSummary): string =>
  share.owner.name?.trim() || share.owner.login
