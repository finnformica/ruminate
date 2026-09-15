import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../types"
import { mintInvite } from "../invites"
import { githubAuth, resolveDisplayName, resolveSignInEmail } from "./github-auth"
import { applyControlPlane, asFakeD1, createTestSqlDriver } from "./sqlite-test-driver"

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

  it("provisions the users row, address included, as the account signs in", async () => {
    // Signing in is signing up: the callback is the one moment the address is
    // known, so the row exists — with it — before the first API request.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const target = String(input)
        if (target === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "test-token" })
        }
        if (target === "https://api.github.com/user") {
          return Response.json({ id: 1, login: "ada", name: "Ada" })
        }
        if (target === "https://api.github.com/user/emails") {
          return Response.json([{ email: "Ada@Example.com", primary: true, visibility: "private" }])
        }
        throw new Error(`Unexpected fetch: ${target}`)
      }),
    )
    const driver = createTestSqlDriver()
    await applyControlPlane(driver)
    const env = {
      VITE_GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "secret",
      SIGNUP_MODE: "open",
      DB: asFakeD1(driver),
    } as Env

    const response = await githubAuth(
      new Request("https://ruminate.test/github-auth?code=abc"),
      env,
    )
    expect(response.status).toBe(302)
    const rows = await driver.exec("SELECT login, email FROM users WHERE github_id = 1")
    expect(rows).toEqual([{ login: "ada", email: "ada@example.com" }])
  })
})

describe("githubAuth — invites", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** GitHub, for a sign-in as `id`. */
  const stubGitHub = (id: number) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const target = String(input)
        if (target === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "test-token" })
        }
        if (target === "https://api.github.com/user") {
          return Response.json({ id, login: `u${id}`, name: null })
        }
        if (target === "https://api.github.com/user/emails") {
          return Response.json([
            { email: `u${id}@example.com`, primary: true, visibility: "public" },
          ])
        }
        throw new Error(`Unexpected fetch: ${target}`)
      }),
    )

  async function inviteEnv() {
    const driver = createTestSqlDriver()
    await applyControlPlane(driver)
    const env = {
      VITE_GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "secret",
      SIGNUP_MODE: "invite",
      ALLOWED_GITHUB_ID: "1",
      DB: asFakeD1(driver),
    } as Env
    const { token } = await mintInvite(driver, { createdBy: 1, note: null, expiresInDays: 7 })
    return { driver, env, token }
  }

  /** Sign in returning to `state`, and read where the browser is sent. */
  const signIn = async (env: Env, state: string) => {
    const response = await githubAuth(
      new Request(`https://ruminate.test/github-auth?code=abc&state=${encodeURIComponent(state)}`),
      env,
    )
    expect(response.status).toBe(302)
    return new URL(response.headers.get("Location") ?? "")
  }

  it("redeems the invite in the return URL, and returns there saying so", async () => {
    const { driver, env, token } = await inviteEnv()
    stubGitHub(7)
    const location = await signIn(env, `https://ruminate.test/invite/${token}`)
    expect(location.pathname).toBe(`/invite/${token}`)
    expect(location.searchParams.get("invite")).toBe("accepted")
    expect(location.searchParams.get("user_id")).toBe("7")
    expect(await driver.exec("SELECT created_by FROM users WHERE github_id = 7")).toEqual([
      { created_by: "invite" },
    ])
    expect(await driver.exec("SELECT redeemed_by FROM invites")).toEqual([{ redeemed_by: 7 }])
  })

  it("says `invalid` for a spent link — the second person through it is not a tenant", async () => {
    const { driver, env, token } = await inviteEnv()
    stubGitHub(7)
    await signIn(env, `https://ruminate.test/invite/${token}`)
    stubGitHub(8)
    const location = await signIn(env, `https://ruminate.test/invite/${token}`)
    expect(location.searchParams.get("invite")).toBe("invalid")
    expect(await driver.exec("SELECT github_id FROM users WHERE github_id = 8")).toEqual([])
  })

  it("says `member` for someone who already has access, leaving the link unused", async () => {
    const { driver, env, token } = await inviteEnv()
    stubGitHub(1) // the bootstrap owner
    const location = await signIn(env, `https://ruminate.test/invite/${token}`)
    expect(location.searchParams.get("invite")).toBe("member")
    expect((await driver.exec("SELECT redeemed_by FROM invites"))[0]?.redeemed_by).toBeNull()
  })

  it("says nothing about invites on an ordinary sign-in", async () => {
    const { env } = await inviteEnv()
    stubGitHub(7)
    const location = await signIn(env, "https://ruminate.test/notes/abc")
    expect(location.searchParams.has("invite")).toBe(false)
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
