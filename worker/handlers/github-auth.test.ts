import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../types"
import { githubAuth, resolveDisplayName, resolveSignInEmail } from "./github-auth"

describe("githubAuth", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("sends the request host's redirect_uri in the token exchange", async () => {
    // The OAuth app registers multiple callback URLs (production + preview
    // hosts); the exchange must echo the redirect_uri the authorize request
    // used, which both sides derive from their own origin.
    let exchangeBody: Record<string, string> | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = String(input)
        if (target === "https://github.com/login/oauth/access_token") {
          exchangeBody = JSON.parse(String(init?.body))
          return Response.json({ access_token: "test-token" })
        }
        if (target === "https://api.github.com/user") {
          return Response.json({ id: 1, login: "ada", name: "Ada" })
        }
        if (target === "https://api.github.com/user/emails") {
          return Response.json([{ email: "ada@example.com", primary: true, visibility: "public" }])
        }
        throw new Error(`Unexpected fetch: ${target}`)
      }),
    )

    const request = new Request(
      "https://claude-graph-storage-ruminate.finnformica.workers.dev/github-auth?code=abc",
    )
    const env = { VITE_GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "secret" } as Env
    const response = await githubAuth(request, env)

    expect(response.status).toBe(302)
    expect(exchangeBody?.redirect_uri).toBe(
      "https://claude-graph-storage-ruminate.finnformica.workers.dev/github-auth",
    )
  })
})

describe("resolveDisplayName", () => {
  it("uses the GitHub display name when present", () => {
    expect(resolveDisplayName("Ada Lovelace", "ada")).toBe("Ada Lovelace")
  })

  it("falls back to the login when name is null (never the literal 'null')", () => {
    expect(resolveDisplayName(null, "ada")).toBe("ada")
    expect(resolveDisplayName(undefined, "ada")).toBe("ada")
  })

  it("falls back to the login for empty, whitespace, or literal 'null' names", () => {
    expect(resolveDisplayName("", "ada")).toBe("ada")
    expect(resolveDisplayName("   ", "ada")).toBe("ada")
    expect(resolveDisplayName("null", "ada")).toBe("ada")
  })
})

describe("resolveSignInEmail", () => {
  it("prefers the primary verified address even when it is private", () => {
    expect(
      resolveSignInEmail([
        {
          email: "1+ada@users.noreply.github.com",
          primary: false,
          verified: true,
          visibility: null,
        },
        { email: "ada@example.com", primary: true, verified: true, visibility: "private" },
      ]),
    ).toBe("ada@example.com")
  })

  it("falls back to the first non-private address when no primary is verified", () => {
    expect(
      resolveSignInEmail([
        { email: "old@example.com", primary: true, verified: false, visibility: "private" },
        { email: "ada@example.com", primary: false, verified: true, visibility: "public" },
      ]),
    ).toBe("ada@example.com")
  })

  it("is null when every address is private and none is a verified primary", () => {
    expect(
      resolveSignInEmail([{ email: "x@example.com", primary: false, visibility: "private" }]),
    ).toBeNull()
  })
})
