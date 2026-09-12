import type { GitHubUser } from "../schema"

/**
 * The client half of MCP token management (docs/mcp-server.md).
 *
 * Thin on purpose: the settings panel owns the state, this module owns the
 * three requests. They are authenticated exactly as the replica calls are —
 * `credentials: "same-origin"` to send the `gh_refresh` cookie, plus the
 * GitHub access token as a bearer — because they are guarded by the same
 * `requireSession`. An MCP token is never used here, and could not be: only a
 * signed-in person may mint or revoke a grant (worker/handlers/mcp-tokens.ts).
 */

export type McpPermission = "read" | "write" | "delete"

/** A token as the settings page sees it. Never the secret. */
export interface McpTokenSummary {
  id: string
  name: string
  permissions: McpPermission[]
  /** null = every note. */
  noteIds: string[] | null
  createdAt: number
  expiresAt: number | null
  lastUsedAt: number | null
  revokedAt: number | null
}

export interface MintRequest {
  name: string
  permissions: McpPermission[]
  /** null = every note. */
  noteIds: string[] | null
  expiresInDays: number | null
}

const ENDPOINT = "/api/mcp/tokens"

/** The URL an MCP client is pointed at. Derived from where the app is served
 * so it is right in dev, on a preview deployment and in production alike. */
export const mcpEndpointUrl = (): string => `${window.location.origin}/mcp`

class McpTokensError extends Error {}

async function request(user: GitHubUser, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${ENDPOINT}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${user.token}`,
      ...init.headers,
    },
  })

  const body = (await response.json().catch(() => null)) as {
    error?: string
    detail?: string
  } | null

  if (!response.ok) {
    // `detail` is written for a person filling in the form ("Pick at least one
    // note"), so prefer it; `error` is the machine-readable code behind it.
    throw new McpTokensError(body?.detail ?? body?.error ?? `Request failed (${response.status}).`)
  }
  return body
}

export async function listMcpTokens(user: GitHubUser): Promise<McpTokenSummary[]> {
  const body = (await request(user, "")) as { tokens?: McpTokenSummary[] } | null
  return body?.tokens ?? []
}

/**
 * Mint a token. The returned `token` is the ONLY copy that will ever exist —
 * the server stores a hash — so the caller must show it before discarding it.
 */
export async function mintMcpToken(
  user: GitHubUser,
  mint: MintRequest,
): Promise<{ token: string; summary: McpTokenSummary }> {
  const body = (await request(user, "", {
    method: "POST",
    body: JSON.stringify({
      name: mint.name,
      permissions: mint.permissions,
      noteIds: mint.noteIds,
      expiresInDays: mint.expiresInDays,
    }),
  })) as { token: string; summary: McpTokenSummary }
  return body
}

export async function revokeMcpToken(user: GitHubUser, id: string): Promise<void> {
  await request(user, `/${encodeURIComponent(id)}`, { method: "DELETE" })
}

/** "read + write", for the token list. */
export const describePermissions = (permissions: McpPermission[]): string =>
  permissions.length === 0 ? "nothing" : permissions.join(" + ")

/** A token's state, as one word. */
export function tokenState(
  token: McpTokenSummary,
  now = Date.now(),
): "live" | "revoked" | "expired" {
  if (token.revokedAt !== null) return "revoked"
  if (token.expiresAt !== null && token.expiresAt <= now) return "expired"
  return "live"
}
