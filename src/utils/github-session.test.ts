// @vitest-environment jsdom
import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GitHubUser } from "../schema"
import {
  GITHUB_USER_STORAGE_KEY,
  clearSession,
  ensureFreshToken,
  getAccessToken,
  seedSession,
  sessionStatusAtom,
  withAuthRetry,
} from "./github-session"
import { REFRESH_LEAD_MS } from "./github-token"

const store = getDefaultStore()

function user(over: Partial<GitHubUser> = {}): GitHubUser {
  return { token: "gho_old", login: "finn", name: "Finn", email: "f@x.com", ...over }
}

/** Mock the /github-refresh call. */
function mockRefresh(result: { status: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body ?? {},
    }),
  )
}

beforeEach(() => {
  clearSession()
  window.localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("github session", () => {
  it("seeds and exposes the access token", () => {
    seedSession(user({ token: "gho_seed" }))
    expect(getAccessToken()).toBe("gho_seed")
    clearSession()
    expect(getAccessToken()).toBeUndefined()
  })

  it("marks the session expiring when the refresh token nears its limit", () => {
    seedSession(user({ refreshTokenExpiresAt: Date.now() + 1000 }))
    expect(store.get(sessionStatusAtom)).toBe("expiring")
    seedSession(user({ refreshTokenExpiresAt: Date.now() + 1_000_000_000 }))
    expect(store.get(sessionStatusAtom)).toBe("active")
  })

  it("withAuthRetry returns without refreshing when the op succeeds", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    seedSession(user())
    await expect(withAuthRetry(async () => "ok")).resolves.toBe("ok")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("withAuthRetry refreshes on a 401 and retries once with the new token", async () => {
    mockRefresh({
      status: 200,
      body: {
        token: "gho_new",
        accessTokenExpiresAt: Date.now() + 8 * 60 * 60 * 1000,
        refreshTokenExpiresAt: Date.now() + 180 * 24 * 60 * 60 * 1000,
      },
    })
    seedSession(user({ token: "gho_old" }))

    let calls = 0
    const result = await withAuthRetry(async () => {
      calls += 1
      if (calls === 1) throw { data: { statusCode: 401 } }
      return getAccessToken()
    })

    expect(calls).toBe(2)
    expect(result).toBe("gho_new")
    expect(store.get(sessionStatusAtom)).toBe("active")
  })

  it("withAuthRetry surfaces SignedOut when the refresh itself fails", async () => {
    mockRefresh({ status: 401 })
    seedSession(user())
    await expect(
      withAuthRetry(async () => {
        throw { data: { statusCode: 401 } }
      }),
    ).rejects.toBeTruthy()
    expect(store.get(sessionStatusAtom)).toBe("expired")
  })

  it("withAuthRetry does not refresh on a non-auth error", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    seedSession(user())
    await expect(
      withAuthRetry(async () => {
        throw new Error("merge conflict")
      }),
    ).rejects.toThrow("merge conflict")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("persists a refreshed token back to localStorage (github_user)", async () => {
    const stored = user({ token: "gho_old", accessTokenExpiresAt: Date.now() + 60_000 })
    window.localStorage.setItem(GITHUB_USER_STORAGE_KEY, JSON.stringify(stored))
    const accessTokenExpiresAt = Date.now() + 8 * 60 * 60 * 1000
    const refreshTokenExpiresAt = Date.now() + 180 * 24 * 60 * 60 * 1000
    mockRefresh({
      status: 200,
      body: { token: "gho_new", accessTokenExpiresAt, refreshTokenExpiresAt },
    })
    seedSession(stored)

    await ensureFreshToken()

    const persisted = JSON.parse(
      window.localStorage.getItem(GITHUB_USER_STORAGE_KEY)!,
    ) as GitHubUser
    expect(persisted.token).toBe("gho_new")
    expect(persisted.accessTokenExpiresAt).toBe(accessTokenExpiresAt)
    expect(persisted.refreshTokenExpiresAt).toBe(refreshTokenExpiresAt)
    // The rest of the stored user survives untouched (schema stays valid).
    expect(persisted.login).toBe("finn")
    expect(persisted.name).toBe("Finn")
    expect(persisted.email).toBe("f@x.com")
  })

  it("does not touch localStorage when there is no stored user", async () => {
    mockRefresh({
      status: 200,
      body: { token: "gho_new", accessTokenExpiresAt: 1, refreshTokenExpiresAt: 2 },
    })
    seedSession(user({ accessTokenExpiresAt: Date.now() + 60_000 }))
    await ensureFreshToken()
    expect(window.localStorage.getItem(GITHUB_USER_STORAGE_KEY)).toBeNull()
  })

  it("ensureFreshToken proceeds on a transient refresh failure while the token is still valid", async () => {
    // Within the refresh lead window, but not yet expired.
    mockRefresh({ status: 500 })
    seedSession(user({ token: "gho_current", accessTokenExpiresAt: Date.now() + 60_000 }))

    await expect(ensureFreshToken()).resolves.toBeUndefined()
    // The current token is kept; withAuthRetry's 401 path covers true expiry.
    expect(getAccessToken()).toBe("gho_current")
    expect(store.get(sessionStatusAtom)).toBe("active")
  })

  it("ensureFreshToken fails when the token is already expired and the refresh fails", async () => {
    mockRefresh({ status: 500 })
    seedSession(user({ token: "gho_dead", accessTokenExpiresAt: Date.now() - 1000 }))

    await expect(ensureFreshToken()).rejects.toThrow()
  })

  it("ensureFreshToken refreshes only when near expiry", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "gho_x", accessTokenExpiresAt: 1, refreshTokenExpiresAt: 2 }),
    })
    vi.stubGlobal("fetch", fetchSpy)

    seedSession(user({ accessTokenExpiresAt: Date.now() + 5 * REFRESH_LEAD_MS }))
    await ensureFreshToken()
    expect(fetchSpy).not.toHaveBeenCalled()

    seedSession(user({ accessTokenExpiresAt: Date.now() + 60_000 })) // inside 10-min lead
    await ensureFreshToken()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(getAccessToken()).toBe("gho_x")
  })
})
