import { beforeEach, describe, expect, it } from "vitest"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { anthropicKey, spendKey } from "./anthropic-key"

/**
 * The Anthropic API key route: a kept key is never answered back, and one
 * account cannot see another's.
 */

const USER = 7
const OTHER_USER = 8
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD"

let harness: McpTestEnv

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
  return new Request("https://ruminate.test/api/anthropic-key", {
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

const send = (request: Request) => anthropicKey(request, harness.env, github, () => 5000)
const bodyOf = async (response: Response) => (await response.json()) as any

beforeEach(async () => {
  harness = await createMcpTestEnv()
  await harness.addUser(USER)
  await harness.addUser(OTHER_USER)
})

describe("the line", () => {
  it("refuses an unauthenticated caller", async () => {
    expect((await send(apiRequest("GET", undefined, null))).status).toBe(401)
  })

  it("refuses an unknown method", async () => {
    expect((await send(apiRequest("POST", { key: KEY }))).status).toBe(405)
  })
})

describe("keeping a key", () => {
  it("starts with none", async () => {
    const response = await send(apiRequest("GET"))
    expect(response.status).toBe(200)
    expect(await bodyOf(response)).toEqual({ set: false, last4: null })
  })

  it("keeps a key and answers only that it is kept, with its tail", async () => {
    const saved = await send(apiRequest("PUT", { key: ` ${KEY}\n` }))
    expect(saved.status).toBe(200)
    const body = await bodyOf(saved)
    expect(body).toEqual({ set: true, last4: "ABCD" })
    expect(JSON.stringify(body)).not.toContain(KEY)
    const read = await send(apiRequest("GET"))
    expect(await bodyOf(read)).toEqual({ set: true, last4: "ABCD" })
    const rows = await harness.control.exec(
      "SELECT api_key, updated_at FROM anthropic_keys WHERE user_id = ?1",
      [USER],
    )
    expect(rows).toEqual([{ api_key: KEY, updated_at: 5000 }])
  })

  it("replaces a kept key", async () => {
    await send(apiRequest("PUT", { key: KEY }))
    const next = KEY.slice(0, -4) + "WXYZ"
    expect(await bodyOf(await send(apiRequest("PUT", { key: next })))).toEqual({
      set: true,
      last4: "WXYZ",
    })
    const rows = await harness.control.exec("SELECT api_key FROM anthropic_keys")
    expect(rows).toEqual([{ api_key: next }])
  })

  it("refuses something that is not shaped as a key, and keeps what it had", async () => {
    await send(apiRequest("PUT", { key: KEY }))
    for (const body of [{ key: "hunter2" }, { key: "sk-ant-short" }, { key: 7 }, {}, "nonsense"]) {
      const response = await send(apiRequest("PUT", body))
      expect(response.status).toBe(400)
      expect((await bodyOf(response)).error).toBe("invalid_key")
    }
    expect(await bodyOf(await send(apiRequest("GET")))).toEqual({ set: true, last4: "ABCD" })
  })

  it("forgets a key", async () => {
    await send(apiRequest("PUT", { key: KEY }))
    expect(await bodyOf(await send(apiRequest("DELETE")))).toEqual({ set: false, last4: null })
    expect(await harness.control.exec("SELECT user_id FROM anthropic_keys")).toEqual([])
    // Forgetting what is not there is nothing.
    expect((await send(apiRequest("DELETE"))).status).toBe(200)
  })

  it("keeps each account's key to itself", async () => {
    await send(apiRequest("PUT", { key: KEY }))
    expect(await bodyOf(await send(apiRequest("GET", undefined, "other")))).toEqual({
      set: false,
      last4: null,
    })
    await send(apiRequest("DELETE", undefined, "other"))
    expect(await bodyOf(await send(apiRequest("GET")))).toEqual({ set: true, last4: "ABCD" })
  })
})

describe("spendKey", () => {
  const DAY = 24 * 60 * 60 * 1000

  it("reads the key and counts the call, and tells no key from a spent day", async () => {
    expect(await spendKey(harness.control, USER, 10 * DAY, 2)).toEqual({
      ok: false,
      reason: "no_key",
    })
    await send(apiRequest("PUT", { key: KEY }))
    expect(await spendKey(harness.control, USER, 10 * DAY, 2)).toEqual({
      ok: true,
      apiKey: KEY,
      callsToday: 1,
    })
    expect(await spendKey(harness.control, USER, 10 * DAY + 1, 2)).toMatchObject({ callsToday: 2 })
    expect(await spendKey(harness.control, USER, 10 * DAY + 2, 2)).toEqual({
      ok: false,
      reason: "daily_limit",
    })
    // A new day starts the count over.
    expect(await spendKey(harness.control, USER, 11 * DAY, 2)).toMatchObject({ callsToday: 1 })
  })
})
