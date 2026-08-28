// The live GitHub access-token session, kept outside the XState machine so the
// refresh flow needs no changes to the machine (and its generated typegen).
//
// - `git.ts` reads the current access token from here via `getAccessToken`.
// - `ensureFreshToken` refreshes proactively just before expiry; `withAuthRetry`
//   refreshes reactively on a 401 and retries once.
// - `sessionStatusAtom` drives the bottom-left status ("Sign in soon" / "Signed
//   out"); it is layered over the sync status in sync-status.tsx.
//
// The refresh token itself never lives here — it stays in the HttpOnly cookie
// the worker manages. We only hold the short-lived access token + timestamps.

import { atom, getDefaultStore } from "jotai"
import type { GitHubUser } from "../schema"
import {
  isAccessTokenNearExpiry,
  isAuthError,
  isSessionExpiringSoon,
  refreshAccessToken,
  SessionExpiredError,
} from "./github-token"

export type SessionStatus = "active" | "expiring" | "expired"

/** Where the signed-in user (including the access token + expiries) persists
 * across reloads. Written on sign-in by the state machine and kept fresh here
 * after every successful token refresh. */
export const GITHUB_USER_STORAGE_KEY = "github_user"

/** Session state for the status UI. `expired` = re-auth required; `expiring` =
 * refresh token nearing its hard limit (rare — only after long inactivity). */
export const sessionStatusAtom = atom<SessionStatus>("active")

const store = getDefaultStore()

type Session = {
  token: string
  accessTokenExpiresAt?: number
  refreshTokenExpiresAt?: number
}

let session: Session | null = null
/** Single-flight guard so concurrent syncs don't refresh in parallel. */
let refreshing: Promise<void> | null = null

function recomputeStatus() {
  const expiring = !!session && isSessionExpiringSoon(session.refreshTokenExpiresAt, Date.now())
  store.set(sessionStatusAtom, expiring ? "expiring" : "active")
}

/** Seed (or replace) the session from a signed-in user. Called on sign-in and
 * on reload; clears the `expired` flag since we now have fresh credentials. */
export function seedSession(user: GitHubUser) {
  session = {
    token: user.token,
    accessTokenExpiresAt: user.accessTokenExpiresAt,
    refreshTokenExpiresAt: user.refreshTokenExpiresAt,
  }
  recomputeStatus()
}

/** Forget the session (sign-out). */
export function clearSession() {
  session = null
  store.set(sessionStatusAtom, "active")
}

/** The current access token, for git auth. */
export function getAccessToken(): string | undefined {
  return session?.token
}

/** Persist a refreshed token + expiries back into the stored user, so the next
 * page load starts with fresh credentials instead of a stale expiry that
 * blocks the first git op on /github-refresh. Single write point; keeps the
 * stored shape valid (only token/expiry fields change). Best-effort — a full
 * or unavailable localStorage never breaks the in-memory session. */
function persistRefreshedSession(next: {
  token: string
  accessTokenExpiresAt?: number
  refreshTokenExpiresAt?: number
}) {
  if (typeof window === "undefined" || !window.localStorage) return
  try {
    const raw = window.localStorage.getItem(GITHUB_USER_STORAGE_KEY)
    if (!raw) return
    const user = JSON.parse(raw)
    if (!user || typeof user !== "object") return
    window.localStorage.setItem(
      GITHUB_USER_STORAGE_KEY,
      JSON.stringify({
        ...user,
        token: next.token,
        accessTokenExpiresAt: next.accessTokenExpiresAt,
        refreshTokenExpiresAt: next.refreshTokenExpiresAt,
      }),
    )
  } catch {
    // Ignore storage errors (quota, private mode) — the in-memory session is
    // still fresh; only the next reload pays the refresh again.
  }
}

function doRefresh(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const next = await refreshAccessToken()
      session = {
        token: next.token,
        accessTokenExpiresAt: next.accessTokenExpiresAt,
        refreshTokenExpiresAt: next.refreshTokenExpiresAt,
      }
      persistRefreshedSession(next)
      recomputeStatus()
    } catch (error) {
      // A dead refresh token is terminal — surface "Signed out". Transient
      // (network) failures leave the status alone so a later sync can recover.
      if (error instanceof SessionExpiredError) store.set(sessionStatusAtom, "expired")
      throw error
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/** Refresh proactively when the access token is within the lead window, so an
 * upcoming git op doesn't 401. No-op without a session or a known expiry.
 *
 * A failed refresh is only fatal when the current token is already past its
 * expiry (no plausible token to proceed with). While the token is merely
 * *near* expiry, a transient refresh failure must not block the git op — we
 * proceed with the current token and let `withAuthRetry`'s 401 path handle
 * true expiry. */
export async function ensureFreshToken(): Promise<void> {
  if (!session) return
  if (!isAccessTokenNearExpiry(session.accessTokenExpiresAt, Date.now())) return
  try {
    await doRefresh()
  } catch (error) {
    const expiresAt = session?.accessTokenExpiresAt
    const stillPlausible = !!session?.token && (expiresAt == null || Date.now() < expiresAt)
    if (!stillPlausible) throw error
  }
}

/** Run a git operation, refreshing once and retrying if it fails with a 401.
 * If the refresh itself fails (revoked/expired token) the error propagates and
 * the status is set to `expired`. */
export async function withAuthRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!session || !isAuthError(error)) throw error
    await doRefresh()
    return await operation()
  }
}
