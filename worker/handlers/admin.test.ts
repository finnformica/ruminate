import { beforeEach, describe, expect, it } from "vitest"
import type { FeatureAudiencesBody } from "../admin-wire"
import { featureAllows, featureAudiences, isAdmin } from "../features"
import { createMcpTestEnv, type McpTestEnv } from "../mcp/test-support"
import { admin } from "./admin"
import { features } from "./features"

/**
 * The admin API and the caller's feature view.
 *
 * The property that matters most: **only the bootstrap owner gets past the
 * first line.** Every other verified session — a tenant in good standing
 * included — gets the 404 a missing route gets, whatever it asks.
 */

const ADMIN = 42536816
const USER = 7

let harness: McpTestEnv

const github = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) !== "https://api.github.com/user") {
    throw new Error(`Unexpected outbound fetch: ${String(input)}`)
  }
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ""
  const token = /^Bearer (.+)$/.exec(auth)?.[1] ?? ""
  const ids: Record<string, number> = { admin: ADMIN, user: USER }
  if (!(token in ids)) return new Response("{}", { status: 401 })
  return new Response(JSON.stringify({ id: ids[token], login: `u${ids[token]}` }), { status: 200 })
}) as typeof fetch

function apiRequest(
  method: string,
  path: string,
  body?: unknown,
  session: string | null = "admin",
): Request {
  return new Request(`https://ruminate.test${path}`, {
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

const sendAdmin = (request: Request) => admin(request, harness.env, github)
const sendFeatures = (request: Request) => features(request, harness.env, github)
const bodyOf = async (response: Response) => (await response.json()) as any

beforeEach(async () => {
  harness = await createMcpTestEnv()
  Object.assign(harness.env, { ALLOWED_GITHUB_ID: String(ADMIN) })
  await harness.addUser(ADMIN)
  await harness.addUser(USER)
})

// -----------------------------------------------------------------------------
// Who
// -----------------------------------------------------------------------------

describe("the admin line", () => {
  it("refuses an unauthenticated caller", async () => {
    expect(
      (await sendAdmin(apiRequest("GET", "/api/admin/features", undefined, null))).status,
    ).toBe(401)
  })

  it("answers a tenant who is not the admin with the 404 a missing route gets", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/admin/features"],
      ["PUT", "/api/admin/features/mcp", { audience: "off" }],
    ] as const) {
      const response = await sendAdmin(apiRequest(method, path, body, "user"))
      expect(response.status).toBe(404)
      expect(await bodyOf(response)).toEqual({ error: "not_found" })
    }
    expect(await harness.control.exec("SELECT key FROM feature_flags")).toEqual([])
  })

  it("has no admin at all without the bootstrap id configured", async () => {
    Object.assign(harness.env, { ALLOWED_GITHUB_ID: undefined })
    expect(isAdmin(harness.env, ADMIN)).toBe(false)
    expect((await sendAdmin(apiRequest("GET", "/api/admin/features"))).status).toBe(404)
  })

  it("answers an unknown admin route with 404", async () => {
    expect((await sendAdmin(apiRequest("GET", "/api/admin/users"))).status).toBe(404)
    expect((await sendAdmin(apiRequest("GET", "/api/admin"))).status).toBe(404)
  })
})

// -----------------------------------------------------------------------------
// Feature flags
// -----------------------------------------------------------------------------

describe("feature flags", () => {
  it("starts at the registry defaults, with no rows", async () => {
    const body = (await bodyOf(
      await sendAdmin(apiRequest("GET", "/api/admin/features")),
    )) as FeatureAudiencesBody
    expect(body.audiences).toEqual({ mcp: "everyone", sharing: "everyone" })
  })

  it("sets an audience and answers with the whole set", async () => {
    const response = await sendAdmin(
      apiRequest("PUT", "/api/admin/features/mcp", { audience: "admin" }),
    )
    expect(response.status).toBe(200)
    expect(((await bodyOf(response)) as FeatureAudiencesBody).audiences).toEqual({
      mcp: "admin",
      sharing: "everyone",
    })
    // Set again: an update, not a second row.
    await sendAdmin(apiRequest("PUT", "/api/admin/features/mcp", { audience: "off" }))
    expect(await featureAudiences(harness.control)).toEqual({ mcp: "off", sharing: "everyone" })
    expect(await harness.control.exec("SELECT key, updated_by FROM feature_flags")).toEqual([
      { key: "mcp", updated_by: ADMIN },
    ])
  })

  it("refuses an unknown feature or audience", async () => {
    expect(
      (await sendAdmin(apiRequest("PUT", "/api/admin/features/teleport", { audience: "off" })))
        .status,
    ).toBe(404)
    for (const bad of [{ audience: "friends" }, {}, null]) {
      const response = await sendAdmin(apiRequest("PUT", "/api/admin/features/mcp", bad))
      expect(response.status).toBe(400)
    }
    expect(await harness.control.exec("SELECT key FROM feature_flags")).toEqual([])
  })

  it("`admin` admits the admin alone; `off` nobody; `everyone` everyone", async () => {
    const allows = (id: number) => featureAllows(harness.control, harness.env, "mcp", id)
    expect(await allows(USER)).toBe(true)
    await sendAdmin(apiRequest("PUT", "/api/admin/features/mcp", { audience: "admin" }))
    expect(await allows(ADMIN)).toBe(true)
    expect(await allows(USER)).toBe(false)
    await sendAdmin(apiRequest("PUT", "/api/admin/features/mcp", { audience: "off" }))
    expect(await allows(ADMIN)).toBe(false)
    expect(await allows(USER)).toBe(false)
    await sendAdmin(apiRequest("PUT", "/api/admin/features/mcp", { audience: "everyone" }))
    expect(await allows(USER)).toBe(true)
  })

  it("reads as the defaults when the table is missing (migration 0013 not applied), and cannot be set", async () => {
    await harness.control.execScript("DROP TABLE feature_flags")
    expect(await featureAudiences(harness.control)).toEqual({
      mcp: "everyone",
      sharing: "everyone",
    })
    expect((await sendAdmin(apiRequest("GET", "/api/admin/features"))).status).toBe(200)
    expect(
      (await sendAdmin(apiRequest("PUT", "/api/admin/features/mcp", { audience: "off" }))).status,
    ).toBe(503)
  })
})

// -----------------------------------------------------------------------------
// GET /api/features — the caller's view
// -----------------------------------------------------------------------------

describe("GET /api/features", () => {
  it("tells each caller what they may use, and whether they are the admin", async () => {
    await sendAdmin(apiRequest("PUT", "/api/admin/features/mcp", { audience: "admin" }))
    await sendAdmin(apiRequest("PUT", "/api/admin/features/sharing", { audience: "off" }))
    expect(await bodyOf(await sendFeatures(apiRequest("GET", "/api/features")))).toEqual({
      admin: true,
      features: { mcp: true, sharing: false },
    })
    expect(
      await bodyOf(await sendFeatures(apiRequest("GET", "/api/features", undefined, "user"))),
    ).toEqual({ admin: false, features: { mcp: false, sharing: false } })
  })

  it("is session-guarded and GET only", async () => {
    expect((await sendFeatures(apiRequest("GET", "/api/features", undefined, null))).status).toBe(
      401,
    )
    expect((await sendFeatures(apiRequest("POST", "/api/features", {}))).status).toBe(405)
  })
})
