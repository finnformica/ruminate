import { beforeEach, describe, expect, it } from "vitest"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { preferences } from "./preferences"

/**
 * The account preferences route: what is stored follows the account, one
 * account cannot see another's, and a body only says what this build
 * understands.
 */

const USER = 7
const OTHER_USER = 8

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

function apiRequest(method: string, body?: unknown, session: string | null = "good"): Request {
  return new Request("https://ruminate.test/api/preferences", {
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

const send = (request: Request) => preferences(request, harness.env, github)
const bodyOf = async (response: Response) => (await response.json()) as any

beforeEach(async () => {
  harness = await createMcpTestEnv()
  await harness.addUser(USER)
  await harness.addUser(OTHER_USER)
})

describe("session", () => {
  it("refuses an unauthenticated caller", async () => {
    expect((await send(apiRequest("GET", undefined, null))).status).toBe(401)
    expect((await send(apiRequest("PUT", { preferences: {} }, null))).status).toBe(401)
  })

  it("refuses a bearer token GitHub does not accept", async () => {
    expect((await send(apiRequest("GET", undefined, "bogus"))).status).toBe(401)
  })

  it("refuses an unknown method", async () => {
    expect((await send(apiRequest("POST", { preferences: {} }))).status).toBe(405)
  })
})

describe("reading and saving", () => {
  it("starts at the defaults, with the what's-new card off", async () => {
    const response = await send(apiRequest("GET"))
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ preferences: { whatsNewCard: false } })
  })

  it("stores a saved preference and reads it back", async () => {
    const saved = await send(apiRequest("PUT", { preferences: { whatsNewCard: true } }))
    expect(saved.status).toBe(200)
    expect(await bodyOf(saved)).toEqual({ preferences: { whatsNewCard: true } })
    expect(await bodyOf(await send(apiRequest("GET")))).toEqual({
      preferences: { whatsNewCard: true },
    })
  })

  it("merges a partial save over what is stored", async () => {
    await send(apiRequest("PUT", { preferences: { whatsNewCard: true } }))
    const saved = await send(apiRequest("PUT", { preferences: {} }))
    expect(await bodyOf(saved)).toEqual({ preferences: { whatsNewCard: true } })
  })

  it("drops keys it does not know and values of the wrong type", async () => {
    const saved = await send(
      apiRequest("PUT", { preferences: { whatsNewCard: "yes", admin: true } }),
    )
    expect(saved.status).toBe(200)
    expect(await bodyOf(saved)).toEqual({ preferences: { whatsNewCard: false } })
    const rows = await harness
      .tenant(USER)
      .exec("SELECT value FROM meta WHERE user_id = :tenant AND key = 'preferences'")
    expect(JSON.parse(String(rows[0]?.value))).toEqual({ whatsNewCard: false })
  })

  it("refuses a body that is not shaped as preferences", async () => {
    expect((await send(apiRequest("PUT", { whatsNewCard: true }))).status).toBe(400)
    expect((await send(apiRequest("PUT", "nonsense"))).status).toBe(400)
    expect((await send(apiRequest("PUT"))).status).toBe(400)
  })

  it("keeps each account's preferences to itself", async () => {
    await send(apiRequest("PUT", { preferences: { whatsNewCard: true } }))
    expect(await bodyOf(await send(apiRequest("GET", undefined, "other")))).toEqual({
      preferences: { whatsNewCard: false },
    })
    expect(await bodyOf(await send(apiRequest("GET")))).toEqual({
      preferences: { whatsNewCard: true },
    })
  })

  it("reads a row that is not JSON as saying nothing", async () => {
    await harness
      .tenant(USER)
      .exec("INSERT INTO meta (user_id, key, value) VALUES (:tenant, 'preferences', '{oops')")
    expect(await bodyOf(await send(apiRequest("GET")))).toEqual({
      preferences: { whatsNewCard: false },
    })
  })
})
