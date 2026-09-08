// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GitHubUser } from "../schema"
import { backfillPrimaryEmail, fetchPrimaryEmail, isNoreplyEmail } from "./github-email"

afterEach(() => vi.unstubAllGlobals())

const NOREPLY = "42536816+finnformica@users.noreply.github.com"

function user(email: string): GitHubUser {
  return { token: "gho_test", login: "finnformica", name: "Finn", email }
}

function mockEmails(status: number, body: unknown) {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
  vi.stubGlobal("fetch", fetchSpy)
  return fetchSpy
}

describe("isNoreplyEmail", () => {
  it("recognises GitHub's private-email alias only", () => {
    expect(isNoreplyEmail(NOREPLY)).toBe(true)
    expect(isNoreplyEmail("finnformica@gmail.com")).toBe(false)
    expect(isNoreplyEmail("noreply@github.com")).toBe(false)
    expect(isNoreplyEmail(null)).toBe(false)
  })
})

describe("fetchPrimaryEmail", () => {
  it("returns the primary verified address, whatever its visibility", async () => {
    const fetchSpy = mockEmails(200, [
      { email: NOREPLY, primary: false, verified: true, visibility: null },
      { email: "finnformica@gmail.com", primary: true, verified: true, visibility: "private" },
    ])
    await expect(fetchPrimaryEmail("gho_test")).resolves.toBe("finnformica@gmail.com")
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.github.com/user/emails")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gho_test")
  })

  it("is null when the token cannot read emails, the shape is wrong, or nothing is verified", async () => {
    mockEmails(401, { message: "Bad credentials" })
    await expect(fetchPrimaryEmail("gho_test")).resolves.toBeNull()
    mockEmails(200, { not: "an array" })
    await expect(fetchPrimaryEmail("gho_test")).resolves.toBeNull()
    mockEmails(200, [{ email: "x@example.com", primary: true, verified: false }])
    await expect(fetchPrimaryEmail("gho_test")).resolves.toBeNull()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
    await expect(fetchPrimaryEmail("gho_test")).resolves.toBeNull()
  })
})

describe("backfillPrimaryEmail", () => {
  it("repairs a session stored under the noreply alias", async () => {
    mockEmails(200, [{ email: "finnformica@gmail.com", primary: true, verified: true }])
    const repaired = await backfillPrimaryEmail(user(NOREPLY))
    expect(repaired.email).toBe("finnformica@gmail.com")
    // Everything else on the stored user is untouched.
    expect(repaired.token).toBe("gho_test")
    expect(repaired.login).toBe("finnformica")
  })

  it("leaves a session with a real email alone, without calling GitHub", async () => {
    const fetchSpy = mockEmails(200, [])
    const stored = user("finnformica@gmail.com")
    await expect(backfillPrimaryEmail(stored)).resolves.toBe(stored)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("keeps the stored user when the address cannot be read", async () => {
    mockEmails(401, {})
    const stored = user(NOREPLY)
    await expect(backfillPrimaryEmail(stored)).resolves.toBe(stored)
  })

  it("does not touch the network while offline", async () => {
    const fetchSpy = mockEmails(200, [])
    vi.stubGlobal("navigator", { ...navigator, onLine: false })
    const stored = user(NOREPLY)
    await expect(backfillPrimaryEmail(stored)).resolves.toBe(stored)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
