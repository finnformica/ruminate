import type { GitHubUser } from "../schema"

/**
 * Repairing the stored sign-in email.
 *
 * Sessions captured before the Worker preferred the PRIMARY address
 * (`worker/handlers/github-auth.ts`, `resolveSignInEmail`) were stored under
 * GitHub's private-email alias, `<id>+<login>@users.noreply.github.com`, and
 * that alias persists in localStorage until the next sign-in. The access
 * token the app holds carries the `user:email` scope, so the real address can
 * be fetched from the browser and the stored session repaired at boot — no
 * re-sign-in needed. Best-effort: offline, a stale token, or an unexpected
 * shape all leave the stored user exactly as it was.
 */

const NOREPLY_RE = /^\d+\+[^@]+@users\.noreply\.github\.com$/i

export function isNoreplyEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && NOREPLY_RE.test(email.trim())
}

interface GitHubEmail {
  email: string
  primary: boolean
  verified?: boolean
}

/** The primary verified address on the account, or null when the token
 * cannot read it (revoked, offline, missing scope) or none is verified. The
 * selection mirrors the Worker's `resolveSignInEmail`. */
export async function fetchPrimaryEmail(
  token: string,
  { timeoutMs = 4000 }: { timeoutMs?: number } = {},
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const emails = (await response.json()) as unknown
    if (!Array.isArray(emails)) return null
    const primary = (emails as GitHubEmail[]).find(
      (entry) =>
        entry && typeof entry.email === "string" && entry.primary && entry.verified !== false,
    )
    return primary?.email ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The stored user with its email repaired when it is the noreply alias and
 * the account's primary address can be read; otherwise the same user. */
export async function backfillPrimaryEmail(user: GitHubUser): Promise<GitHubUser> {
  if (!isNoreplyEmail(user.email)) return user
  if (typeof navigator !== "undefined" && navigator.onLine === false) return user
  const email = await fetchPrimaryEmail(user.token)
  return email && email !== user.email ? { ...user, email } : user
}
