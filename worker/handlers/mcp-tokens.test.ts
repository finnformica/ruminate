import { beforeEach, describe, expect, it } from "vitest"
import { createMcpTestEnv, mcpRequest, type McpTestEnv } from "../mcp/test-support"
import { mcp } from "./mcp"
import { mcpTokens } from "./mcp-tokens"

/**
 * The management API — the endpoints the settings page mints, lists and
 * revokes grants through.
 *
 * The property that matters most here is the one about what is NOT possible:
 * **an MCP token cannot mint another MCP token**. These routes take a browser
 * session and nothing else, so widening an agent's authority always requires
 * a person signed in to GitHub. The last group of tests is that boundary.
 */

const USER = 7
const OTHER_USER = 8
const NOTE = "blk_note"
const OTHER_NOTE = "blk_other"

let harness: McpTestEnv

/** A GitHub stub: "good" is USER's token, "other" is OTHER_USER's. */
const github = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) !== "https://api.github.com/user") {
    throw new Error(`Unexpected outbound fetch: ${String(input)}`)
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ""
  const token = /^Bearer (.+)$/.exec(auth)?.[1] ?? ""
  const ids: Record<string, number> = { good: USER, other: OTHER_USER }
  if (!(token in ids)) return new Response("{}", { status: 401 })
  return new Response(JSON.stringify({ id: ids[token], login: `u${ids[token]}` }), { status: 200 })
}) as typeof fetch

function apiRequest(
  method: string,
  path = "",
  body?: unknown,
  session: string | null = "good",
): Request {
  return new Request(`https://ruminate.test/api/mcp/tokens${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session === null
        ? {}
        : { Cookie: "gh_refresh=session", Authorization: `Bearer ${session}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const send = (request: Request) => mcpTokens(request, harness.env, github)
const bodyOf = async (response: Response) => (await response.json()) as any

const validMint = {
  name: "Claude Desktop",
  permissions: ["read", "write"],
  noteIds: null,
  expiresInDays: 30,
}

beforeEach(async () => {
  harness = await createMcpTestEnv()
  await harness.addUser(USER)
  await harness.addUser(OTHER_USER)
  await harness.seedNote(USER, { id: NOTE, title: "Mine", markdown: "- hello\n" })
  await harness.seedNote(OTHER_USER, { id: OTHER_NOTE, title: "Theirs", markdown: "- private\n" })
})

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

describe("session", () => {
  it("refuses an unauthenticated caller", async () => {
    expect((await send(apiRequest("GET", "", undefined, null))).status).toBe(401)
    expect((await send(apiRequest("POST", "", validMint, null))).status).toBe(401)
  })

  it("refuses a bearer token GitHub does not accept", async () => {
    expect((await send(apiRequest("GET", "", undefined, "bogus"))).status).toBe(401)
  })

  it("refuses an unknown method", async () => {
    expect((await send(apiRequest("PUT", "", {}))).status).toBe(405)
  })
})

// -----------------------------------------------------------------------------
// Minting
// -----------------------------------------------------------------------------

describe("mint", () => {
  it("returns the secret exactly once, and never again", async () => {
    const minted = await bodyOf(await send(apiRequest("POST", "", validMint)))
    expect(minted.token).toMatch(/^rmn_mcp_/)
    expect(minted.summary.permissions).toEqual(["read", "write"])

    const listed = await bodyOf(await send(apiRequest("GET")))
    expect(JSON.stringify(listed)).not.toContain(minted.token)
    expect(listed.tokens[0].id).toBe(minted.summary.id)
  })

  it("mints a token that actually works at /mcp", async () => {
    const minted = await bodyOf(await send(apiRequest("POST", "", validMint)))
    const response = await mcp(mcpRequest("tools/list", {}, { token: minted.token }), harness.env)
    expect(response.status).toBe(200)
  })

  it("records the expiry it was asked for", async () => {
    const before = Date.now()
    const minted = await bodyOf(await send(apiRequest("POST", "", validMint)))
    const expected = before + 30 * 24 * 60 * 60 * 1000
    expect(minted.summary.expiresAt).toBeGreaterThanOrEqual(expected - 5000)
  })

  it("needs a name and at least one permission", async () => {
    for (const body of [
      { ...validMint, name: "" },
      { ...validMint, name: "   " },
      { ...validMint, permissions: [] },
    ]) {
      const response = await send(apiRequest("POST", "", body))
      expect(response.status).toBe(400)
    }
  })

  it("refuses a permission it does not know", async () => {
    const response = await send(
      apiRequest("POST", "", { ...validMint, permissions: ["read", "sudo"] }),
    )
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).detail).toMatch(/Unknown permission/)
  })

  it("refuses an EMPTY note list rather than reading it as 'every note'", async () => {
    // The reading that would be a security bug: an empty scope silently
    // widening into unrestricted access.
    const response = await send(apiRequest("POST", "", { ...validMint, noteIds: [] }))
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).detail).toMatch(/at least one note/)
  })

  it("refuses an expiry outside the allowed range", async () => {
    for (const days of [0, -1, 400, 1.5]) {
      expect(
        (await send(apiRequest("POST", "", { ...validMint, expiresInDays: days }))).status,
      ).toBe(400)
    }
  })

  it("refuses a body that is not JSON", async () => {
    const response = await send(
      new Request("https://ruminate.test/api/mcp/tokens", {
        method: "POST",
        headers: { Cookie: "gh_refresh=session", Authorization: "Bearer good" },
        body: "{",
      }),
    )
    expect(response.status).toBe(400)
  })
})

// -----------------------------------------------------------------------------
// Scoping a grant to notes
// -----------------------------------------------------------------------------

describe("note scope", () => {
  it("accepts a scope naming the caller's own note", async () => {
    const response = await send(apiRequest("POST", "", { ...validMint, noteIds: [NOTE] }))
    expect(response.status).toBe(201)
    expect((await bodyOf(response)).summary.noteIds).toEqual([NOTE])
  })

  it("refuses a scope naming a note that does not exist", async () => {
    const response = await send(apiRequest("POST", "", { ...validMint, noteIds: ["blk_ghost"] }))
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).detail).toMatch(/not notes in your corpus/)
  })

  it("refuses a scope naming ANOTHER user's note", async () => {
    // Naming someone else's note id must be indistinguishable from naming one
    // that does not exist — otherwise this endpoint is an existence oracle.
    const response = await send(apiRequest("POST", "", { ...validMint, noteIds: [OTHER_NOTE] }))
    expect(response.status).toBe(400)
    expect((await bodyOf(response)).detail).toMatch(/not notes in your corpus/)
  })

  it("refuses more scoped notes than the limit allows", async () => {
    const many = Array.from({ length: 101 }, (_, index) => `blk_${index}`)
    const response = await send(apiRequest("POST", "", { ...validMint, noteIds: many }))
    expect(response.status).toBe(400)
  })
})

// -----------------------------------------------------------------------------
// Listing and revoking
// -----------------------------------------------------------------------------

describe("list and revoke", () => {
  it("lists only the caller's own tokens", async () => {
    await send(apiRequest("POST", "", { ...validMint, name: "Mine" }))
    await send(apiRequest("POST", "", { ...validMint, name: "Theirs" }, "other"))

    const mine = await bodyOf(await send(apiRequest("GET")))
    expect(mine.tokens.map((token: any) => token.name)).toEqual(["Mine"])
  })

  it("revokes a token, and the token stops working at /mcp immediately", async () => {
    const minted = await bodyOf(await send(apiRequest("POST", "", validMint)))
    expect(
      (await mcp(mcpRequest("tools/list", {}, { token: minted.token }), harness.env)).status,
    ).toBe(200)

    const revoked = await send(apiRequest("DELETE", `/${minted.summary.id}`))
    expect(revoked.status).toBe(200)

    expect(
      (await mcp(mcpRequest("tools/list", {}, { token: minted.token }), harness.env)).status,
    ).toBe(401)
  })

  it("keeps the revoked row, as an audit trail", async () => {
    const minted = await bodyOf(await send(apiRequest("POST", "", validMint)))
    await send(apiRequest("DELETE", `/${minted.summary.id}`))

    const listed = await bodyOf(await send(apiRequest("GET")))
    expect(listed.tokens[0].revokedAt).not.toBeNull()
  })

  it("cannot revoke ANOTHER user's token", async () => {
    const theirs = await bodyOf(await send(apiRequest("POST", "", validMint, "other")))

    const attempt = await send(apiRequest("DELETE", `/${theirs.summary.id}`, undefined, "good"))
    expect(attempt.status).toBe(404)

    // And theirs still works.
    expect(
      (await mcp(mcpRequest("tools/list", {}, { token: theirs.token }), harness.env)).status,
    ).toBe(200)
  })

  it("404s on a token id that does not exist", async () => {
    expect((await send(apiRequest("DELETE", "/mcp_nothing"))).status).toBe(404)
  })

  it("refuses more live tokens than the per-user limit", async () => {
    for (let i = 0; i < 50; i += 1) {
      const response = await send(apiRequest("POST", "", { ...validMint, name: `t${i}` }))
      expect(response.status).toBe(201)
    }
    const over = await send(apiRequest("POST", "", { ...validMint, name: "one too many" }))
    expect(over.status).toBe(409)
  })
})

// -----------------------------------------------------------------------------
// The boundary that matters most
// -----------------------------------------------------------------------------

describe("an MCP token cannot mint an MCP token", () => {
  it("refuses an MCP token presented to the management API", async () => {
    const minted = await bodyOf(await send(apiRequest("POST", "", validMint)))

    // Presented exactly as an agent would: as the bearer credential.
    const attempt = await send(apiRequest("POST", "", validMint, minted.token))
    expect(attempt.status).toBe(401)

    // And it cannot list or revoke either.
    expect((await send(apiRequest("GET", "", undefined, minted.token))).status).toBe(401)
    expect(
      (await send(apiRequest("DELETE", `/${minted.summary.id}`, undefined, minted.token))).status,
    ).toBe(401)
  })

  it("does not expose the management API through the MCP endpoint's tool list", async () => {
    const minted = await bodyOf(await send(apiRequest("POST", "", validMint)))
    const listed = await (
      await mcp(mcpRequest("tools/list", {}, { token: minted.token }), harness.env)
    ).json()

    const names = (listed as any).result.tools.map((tool: any) => tool.name)
    expect(names.some((name: string) => /token|grant|permission/i.test(name))).toBe(false)
  })
})
