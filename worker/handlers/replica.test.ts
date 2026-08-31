// tenant-guard: exempt — this suite reads raw storage (both tenants' rows,
// tombstones included) on purpose: that is how it proves the scoping works.
import { describe, expect, it } from "vitest"
import migration0003 from "../../migrations/0003_control_plane.sql?raw"
import type { SqlDriver } from "../../src/data/sql-driver"
import { ensureTenantMeta, forTenant, type TenantDb } from "../tenancy-db"
import type { Env } from "../types"
import { corpusPullFull, corpusPullSince, corpusPut, corpusStatus } from "./replica-corpus"
import {
  parseReplicaPayload,
  parseSinceCursor,
  planReplicaPut,
  type LinkRow,
  type NodeRow,
  type ReplicaChangesBody,
  type ReplicaCorpusBody,
} from "./replica-payload"
import { replica, requireSession } from "./replica"
import { asFakeD1, createTenantTestDriver, createTestSqlDriver } from "./sqlite-test-driver"

const node: NodeRow = { id: "blk_aaaaaaaaaa", type: "ul", text: "Hi", props: null, updated_at: 123 }
const link: LinkRow = {
  source_id: "blk_noteaaaaaa",
  destination_id: "blk_aaaaaaaaaa",
  kind: "child",
  sort_key: "a0",
  updated_at: 123,
}

const NOW = 1_700_000_000_000

describe("parseReplicaPayload", () => {
  it("accepts a well-formed payload", () => {
    const payload = parseReplicaPayload({
      nodes: [node],
      links: [link],
      deleteNodes: ["blk_old0000000"],
      deleteLinks: [["blk_noteaaaaaa", "blk_old0000000", "child"]],
      cursor: "abc123",
    })
    expect(payload).toEqual({
      nodes: [node],
      links: [link],
      deleteNodes: ["blk_old0000000"],
      deleteLinks: [["blk_noteaaaaaa", "blk_old0000000", "child"]],
      cursor: "abc123",
    })
  })

  it("accepts an empty batch and omitted optionals", () => {
    expect(parseReplicaPayload({ nodes: [], links: [] })).toEqual({
      nodes: [],
      links: [],
      deleteNodes: undefined,
      deleteLinks: undefined,
      cursor: undefined,
    })
  })

  it("carries a tombstone through, and treats null/absent as live", () => {
    const tombstoned = parseReplicaPayload({
      nodes: [{ ...node, deleted_at: 999 }],
      links: [{ ...link, deleted_at: 999 }],
    })
    expect(tombstoned?.nodes[0].deleted_at).toBe(999)
    expect(tombstoned?.links[0].deleted_at).toBe(999)
    // A pre-tombstone client sends no field at all; an explicit null is live.
    expect(parseReplicaPayload({ nodes: [{ ...node, deleted_at: null }], links: [] })).toEqual({
      nodes: [node],
      links: [],
      deleteNodes: undefined,
      deleteLinks: undefined,
      cursor: undefined,
    })
  })

  it("rejects non-objects and missing row arrays", () => {
    expect(parseReplicaPayload(null)).toBeNull()
    expect(parseReplicaPayload("hi")).toBeNull()
    expect(parseReplicaPayload({})).toBeNull()
    expect(parseReplicaPayload({ nodes: [] })).toBeNull()
    expect(parseReplicaPayload({ links: [] })).toBeNull()
  })

  it("rejects malformed rows", () => {
    expect(parseReplicaPayload({ nodes: [{ ...node, id: "" }], links: [] })).toBeNull()
    expect(parseReplicaPayload({ nodes: [{ ...node, updated_at: "123" }], links: [] })).toBeNull()
    expect(parseReplicaPayload({ nodes: [{ ...node, props: 7 }], links: [] })).toBeNull()
    expect(parseReplicaPayload({ nodes: [{ ...node, deleted_at: "999" }], links: [] })).toBeNull()
    expect(parseReplicaPayload({ nodes: [], links: [{ ...link, sort_key: 1 }] })).toBeNull()
    expect(parseReplicaPayload({ nodes: [], links: [{ ...link, kind: null }] })).toBeNull()
  })

  it("rejects malformed deletes and cursor", () => {
    expect(parseReplicaPayload({ nodes: [], links: [], deleteNodes: [1] })).toBeNull()
    expect(parseReplicaPayload({ nodes: [], links: [], deleteLinks: [["a", "b"]] })).toBeNull()
    expect(parseReplicaPayload({ nodes: [], links: [], cursor: 7 })).toBeNull()
  })

  it("strips unknown properties from rows", () => {
    const payload = parseReplicaPayload({ nodes: [{ ...node, sneaky: "x" }], links: [] })
    expect(payload?.nodes[0]).toEqual(node)
  })
})

describe("planReplicaPut", () => {
  it("plans tombstones first, then node upserts before link upserts", () => {
    const statements = planReplicaPut(
      {
        nodes: [node],
        links: [link],
        deleteNodes: ["blk_gone000000"],
        deleteLinks: [["blk_noteaaaaaa", "blk_gone000000", "child"]],
        cursor: "c1",
      },
      NOW,
    )
    expect(statements.map((s) => s.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      "UPDATE link SET",
      "UPDATE nodes SET",
      "INSERT INTO nodes",
      "INSERT INTO link",
      "INSERT INTO meta",
    ])
    expect(statements[2].params).toEqual(["blk_aaaaaaaaaa", "ul", "Hi", null, 123, null])
    expect(statements[3].params).toEqual([
      "blk_noteaaaaaa",
      "blk_aaaaaaaaaa",
      "child",
      "a0",
      123,
      null,
    ])
  })

  it("every statement names its tenant with the :tenant token, never a parameter", () => {
    const statements = planReplicaPut(
      { nodes: [node], links: [link], deleteNodes: ["x"], cursor: "c" },
      NOW,
    )
    for (const statement of statements) {
      expect(statement.sql).toContain("user_id")
      expect(statement.sql).toContain(":tenant")
      // No planned parameter is a user id — there is nowhere to put one.
      expect(statement.params).not.toContain(42536816)
    }
  })

  it("upserts with per-row LWW: stale rows cannot clobber newer ones", () => {
    const statements = planReplicaPut({ nodes: [node], links: [link] }, NOW)
    expect(statements[0].sql).toContain("WHERE excluded.updated_at >= nodes.updated_at")
    expect(statements[1].sql).toContain("WHERE excluded.updated_at >= link.updated_at")
  })

  it("carries deleted_at through an upsert, so a tombstone (and a revive) replicates", () => {
    const [tombstone] = planReplicaPut({ nodes: [{ ...node, deleted_at: 500 }], links: [] }, NOW)
    expect(tombstone.sql).toContain("deleted_at = excluded.deleted_at")
    expect(tombstone.params[5]).toBe(500)
    const [revive] = planReplicaPut({ nodes: [node], links: [] }, NOW)
    expect(revive.params[5]).toBeNull()
  })

  it("the legacy delete channel stamps tombstones and leaves link rows alone", () => {
    const statements = planReplicaPut({ nodes: [], links: [], deleteNodes: ["gone"] }, NOW)
    // No cascade: a link pointing at a deleted node is retained, so a restore
    // has somewhere to put the node back.
    expect(statements).toHaveLength(1)
    expect(statements[0].sql).toContain("UPDATE nodes SET deleted_at = ?2, updated_at = ?2")
    expect(statements[0].params).toEqual(["gone", NOW])
  })

  it("gives every row one delete retires the SAME stamp", () => {
    const statements = planReplicaPut(
      {
        nodes: [],
        links: [],
        deleteNodes: ["a", "b"],
        deleteLinks: [["p", "a", "child"]],
      },
      NOW,
    )
    expect(statements.map((s) => s.params[s.params.length - 1])).toEqual([NOW, NOW, NOW])
  })

  it("updates the replica cursor only when provided", () => {
    expect(planReplicaPut({ nodes: [], links: [] }, NOW)).toEqual([])
    const statements = planReplicaPut({ nodes: [], links: [], cursor: "sha-1234" }, NOW)
    expect(statements).toHaveLength(1)
    expect(statements[0].sql).toContain("INSERT INTO meta (user_id, key, value)")
    expect(statements[0].params).toEqual(["sha-1234"])
  })
})

// -----------------------------------------------------------------------------
// The real thing: real migrations, real SQL, real tenant scoping
// -----------------------------------------------------------------------------

const identityOf = (id: number) => ({ id, login: `u${id}`, name: null })

/** A tenant handle on a database in the exact shape production D1 is in. */
async function openTenant(id: number, existing?: SqlDriver): Promise<TenantDb> {
  const driver = existing ?? (await createTenantTestDriver())
  const tenant = forTenant(driver, identityOf(id))
  await ensureTenantMeta(tenant)
  return tenant
}

describe("corpus operations over the real D1 schema", () => {
  const nodes: NodeRow[] = [
    { id: "blk_noteaaaaaa", type: "page", text: "blk_noteaaaaaa", props: null, updated_at: 100 },
    { id: "blk_a000000000", type: "text", text: "A", props: null, updated_at: 300 },
  ]
  const links: LinkRow[] = [
    {
      source_id: "blk_noteaaaaaa",
      destination_id: "blk_a000000000",
      kind: "child",
      sort_key: "a0",
      updated_at: 100,
    },
  ]

  it("full pull returns every row of both tables plus the cursor", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, { nodes, links, cursor: "42" }, NOW)
    expect(await corpusPullFull(tenant)).toEqual({ nodes, links, cursor: "42" })
  })

  it("since pull returns only newer rows, plus ALL keys", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, { nodes, links, cursor: "301" }, NOW)
    const body = await corpusPullSince(tenant, 200)
    expect(body.nodes).toEqual([nodes[1]])
    expect(body.links).toEqual([])
    expect([...body.nodeIds].sort()).toEqual(["blk_a000000000", "blk_noteaaaaaa"])
    expect(body.linkKeys).toEqual([["blk_noteaaaaaa", "blk_a000000000", "child"]])
    expect(body.cursor).toBe("301")
  })

  it("since equal to the newest updated_at returns no changes (strict >)", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, { nodes, links }, NOW)
    const body = await corpusPullSince(tenant, 300)
    expect(body.nodes).toEqual([])
    expect(body.links).toEqual([])
    expect(body.nodeIds).toHaveLength(2)
  })

  it("a fresh corpus pulls empty with the seeded empty-string cursor", async () => {
    const tenant = await openTenant(1)
    expect(await corpusPullFull(tenant)).toEqual({ nodes: [], links: [], cursor: "" })
  })

  it("status reports LIVE counts, schema version, and cursor", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, { nodes, links, cursor: "7" }, NOW)
    expect(await corpusStatus(tenant)).toEqual({
      counts: { nodes: 2, links: 1, pages: 1 },
      schema_version: "3",
      replica_cursor: "7",
    })
  })

  it("per-row LWW: an updated_at tie goes to the later push, either order", async () => {
    const first = await openTenant(1)
    await corpusPut(
      first,
      { nodes: [{ ...node, updated_at: 100, text: "from-a" }], links: [] },
      NOW,
    )
    await corpusPut(
      first,
      { nodes: [{ ...node, updated_at: 100, text: "from-b" }], links: [] },
      NOW,
    )
    expect((await corpusPullFull(first)).nodes[0].text).toBe("from-b")

    const reversed = await openTenant(1)
    await corpusPut(
      reversed,
      { nodes: [{ ...node, updated_at: 100, text: "from-b" }], links: [] },
      NOW,
    )
    await corpusPut(
      reversed,
      { nodes: [{ ...node, updated_at: 100, text: "from-a" }], links: [] },
      NOW,
    )
    expect((await corpusPullFull(reversed)).nodes[0].text).toBe("from-a")
  })

  it("per-row LWW: a stale push is rejected per row, not per batch", async () => {
    const tenant = await openTenant(1)
    await corpusPut(
      tenant,
      {
        nodes: [
          { ...node, updated_at: 300, text: "newer" },
          { ...node, id: "blk_bbbbbbbbbb", updated_at: 100 },
        ],
        links: [{ ...link, updated_at: 300, sort_key: "a5" }],
      },
      NOW,
    )
    await corpusPut(
      tenant,
      {
        nodes: [
          { ...node, updated_at: 200, text: "stale — must lose" },
          { ...node, id: "blk_bbbbbbbbbb", text: "fresh — must win", updated_at: 200 },
        ],
        links: [{ ...link, updated_at: 200, sort_key: "a0" }],
      },
      NOW,
    )
    const pulled = await corpusPullFull(tenant)
    expect(pulled.nodes.find((row) => row.id === node.id)?.text).toBe("newer")
    expect(pulled.nodes.find((row) => row.id === "blk_bbbbbbbbbb")?.text).toBe("fresh — must win")
    expect(pulled.links[0].sort_key).toBe("a5")
  })

  it("replaying the same push is idempotent", async () => {
    const tenant = await openTenant(1)
    const payload = { nodes, links, deleteNodes: ["blk_gone000000"], cursor: "c1" }
    await corpusPut(tenant, payload, NOW)
    await corpusPut(tenant, payload, NOW)
    expect((await corpusStatus(tenant)).counts).toEqual({ nodes: 2, links: 1, pages: 1 })
  })
})

describe("soft deletes at the replica", () => {
  const rows = {
    nodes: [
      { id: "blk_noteaaaaaa", type: "page", text: "blk_noteaaaaaa", props: null, updated_at: 100 },
      { id: "blk_a000000000", type: "text", text: "A", props: null, updated_at: 100 },
    ],
    links: [
      {
        source_id: "blk_noteaaaaaa",
        destination_id: "blk_a000000000",
        kind: "child",
        sort_key: "a0",
        updated_at: 100,
      },
    ],
  }

  it("a tombstone round-trips through push and pull, and stops counting", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, rows, NOW)
    await corpusPut(
      tenant,
      { nodes: [{ ...rows.nodes[1], updated_at: 200, deleted_at: 200 }], links: [] },
      NOW,
    )

    const pulled = await corpusPullFull(tenant)
    expect(pulled.nodes.find((row) => row.id === "blk_a000000000")?.deleted_at).toBe(200)
    // The row still EXISTS, so it stays in the key lists — no purge is implied.
    const since = await corpusPullSince(tenant, 150)
    expect(since.nodes.map((row) => row.id)).toEqual(["blk_a000000000"])
    expect([...since.nodeIds].sort()).toEqual(["blk_a000000000", "blk_noteaaaaaa"])
    // …and the link to it is retained, untouched — though a link into a
    // tombstoned node is not part of the graph anyone can see, so it stops
    // counting alongside the node.
    expect(pulled.links).toEqual(rows.links)
    expect((await corpusStatus(tenant)).counts).toEqual({ nodes: 1, links: 0, pages: 1 })
  })

  it("re-creating the id revives it cleanly", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, rows, NOW)
    await corpusPut(
      tenant,
      { nodes: [{ ...rows.nodes[1], updated_at: 200, deleted_at: 200 }], links: [] },
      NOW,
    )
    await corpusPut(
      tenant,
      { nodes: [{ ...rows.nodes[1], text: "back", updated_at: 300 }], links: [] },
      NOW,
    )
    const pulled = await corpusPullFull(tenant)
    const revived = pulled.nodes.find((row) => row.id === "blk_a000000000")
    expect(revived).toEqual({ ...rows.nodes[1], text: "back", updated_at: 300 })
    expect((await corpusStatus(tenant)).counts.nodes).toBe(2)
  })

  it("the legacy delete channel tombstones instead of removing", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, rows, NOW)
    await corpusPut(tenant, { nodes: [], links: [], deleteNodes: ["blk_a000000000"] }, NOW)
    const pulled = await corpusPullFull(tenant)
    expect(pulled.nodes).toHaveLength(2)
    expect(pulled.nodes.find((row) => row.id === "blk_a000000000")?.deleted_at).toBe(NOW)
  })
})

describe("parseSinceCursor", () => {
  it("accepts a ms-timestamp cursor string", () => {
    expect(parseSinceCursor("1756400000000")).toBe(1756400000000)
    expect(parseSinceCursor("0")).toBe(0)
  })

  it("rejects anything that is not a plain number string", () => {
    expect(parseSinceCursor("")).toBeNull()
    expect(parseSinceCursor("-5")).toBeNull()
    expect(parseSinceCursor("12.5")).toBeNull()
    expect(parseSinceCursor("abc")).toBeNull()
    expect(parseSinceCursor("1".repeat(16))).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// Routing, auth, and the adversarial cross-tenant suite
// -----------------------------------------------------------------------------

/** GitHub `/user` stub: token → identity. Unknown tokens get GitHub's 401. */
function githubStub(users: Record<string, { id: number; login?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "https://api.github.com/user") {
      throw new Error(`Unexpected outbound fetch: ${String(input)}`)
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""
    const token = /^Bearer (.+)$/.exec(auth)?.[1] ?? ""
    const user = users[token]
    if (!user) return new Response("{}", { status: 401 })
    return new Response(JSON.stringify({ id: user.id, login: user.login ?? `u${user.id}` }), {
      status: 200,
    })
  }) as typeof fetch
}

/**
 * One database holding both the control plane (0003) and every tenant's corpus
 * (0001 + 0002 + 0004) — exactly the deployed arrangement, which is what makes
 * the cross-tenant assertions below meaningful: A's and B's rows really are
 * one `WHERE` clause apart.
 */
async function testEnv(overrides: Partial<Env> = {}): Promise<{ env: Env; driver: SqlDriver }> {
  const driver = await createTenantTestDriver()
  await driver.execScript(migration0003)
  const env = {
    DB: asFakeD1(driver),
    CORPUS: undefined,
    SIGNUP_MODE: "open",
    ALLOWED_GITHUB_ID: undefined,
    ...overrides,
  } as unknown as Env
  return { env, driver }
}

const authHeaders = (token: string) => ({
  Cookie: "gh_refresh=session",
  Authorization: `Bearer ${token}`,
})

describe("requireSession", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://example.com/api/replica/status", { headers })
  const github = githubStub({ good: { id: 42536816, login: "finn" }, other: { id: 999 } })

  it("rejects a request without the session cookie", async () => {
    const { env } = await testEnv()
    const result = await requireSession(request({ Authorization: "Bearer good" }), env, github)
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  it("rejects a request without a bearer token", async () => {
    const { env } = await testEnv()
    const result = await requireSession(request({ Cookie: "gh_refresh=abc" }), env, github)
    expect((result as Response).status).toBe(401)
  })

  it("rejects a token GitHub does not accept", async () => {
    const { env } = await testEnv()
    const result = await requireSession(request(authHeaders("bad")), env, github)
    expect((result as Response).status).toBe(401)
  })

  it("rejects a VALID GitHub identity the control plane does not admit (403)", async () => {
    const { env } = await testEnv({ SIGNUP_MODE: "allowlist" })
    const result = await requireSession(request(authHeaders("other")), env, github)
    expect((result as Response).status).toBe(403)
    expect(await (result as Response).json()).toEqual({ error: "signup_closed" })
  })

  it("fails closed when no signup mode and no owner id are configured (403)", async () => {
    const { env } = await testEnv({ SIGNUP_MODE: undefined })
    const result = await requireSession(request(authHeaders("good")), env, github)
    expect((result as Response).status).toBe(403)
    expect(await (result as Response).json()).toEqual({ error: "owner_not_configured" })
  })

  it("returns the VERIFIED identity — GitHub's id for the token, nothing client-sent", async () => {
    const { env } = await testEnv({ SIGNUP_MODE: undefined, ALLOWED_GITHUB_ID: "42536816" })
    const result = await requireSession(
      request({ ...authHeaders("good"), "X-GitHub-Id": "999" }),
      env,
      github,
    )
    expect(result).toEqual({ id: 42536816, login: "finn", name: null })
  })
})

describe("tenant scoping — the adversarial suite", () => {
  const github = githubStub({
    "alice-token": { id: 111, login: "alice" },
    "bob-token": { id: 222, login: "bob" },
  })
  const aliceRows = {
    nodes: [
      { id: "blk_noteaaaaaa", type: "page", text: "alice's note", props: null, updated_at: 100 },
      { id: "blk_secret0001", type: "text", text: "alice's secret", props: null, updated_at: 100 },
    ],
    links: [
      {
        source_id: "blk_noteaaaaaa",
        destination_id: "blk_secret0001",
        kind: "child",
        sort_key: "a0",
        updated_at: 100,
      },
    ],
  }

  const push = (env: Env, token: string, body: unknown, query = "") =>
    replica(
      new Request(`https://example.com/api/replica/notes${query}`, {
        method: "PUT",
        headers: authHeaders(token),
        body: JSON.stringify(body),
      }),
      env,
      github,
    )
  const get = (env: Env, token: string, path: string) =>
    replica(new Request(`https://example.com${path}`, { headers: authHeaders(token) }), env, github)

  async function seededEnv(): Promise<{ env: Env; driver: SqlDriver }> {
    const made = await testEnv()
    expect((await push(made.env, "alice-token", { ...aliceRows, cursor: "c1" })).status).toBe(200)
    return made
  }

  it("a push lands under the VERIFIED id, whatever tenant the request claims", async () => {
    const { env, driver } = await testEnv()
    // The request claims tenant 222 everywhere a client could put it.
    const response = await replica(
      new Request("https://example.com/api/replica/notes?github_id=222&tenant=222&user_id=222", {
        method: "PUT",
        headers: { ...authHeaders("alice-token"), "X-GitHub-Id": "222", "X-Tenant": "222" },
        body: JSON.stringify({ ...aliceRows, user_id: 222, tenant: 222, cursor: "c1" }),
      }),
      env,
      github,
    )
    expect(response.status).toBe(200)
    const owners = await driver.exec("SELECT DISTINCT user_id FROM nodes ORDER BY user_id")
    expect(owners).toEqual([{ user_id: 111 }])
  })

  it("B's full pull contains none of A's rows", async () => {
    const { env } = await seededEnv()
    const body = (await (
      await get(env, "bob-token", "/api/replica/notes")
    ).json()) as ReplicaCorpusBody
    expect(body).toEqual({ nodes: [], links: [], cursor: "" })
  })

  it("B's since-pull — rows AND key lists — contains none of A's", async () => {
    const { env } = await seededEnv()
    const body = (await (
      await get(env, "bob-token", "/api/replica/notes?since=0")
    ).json()) as ReplicaChangesBody
    // The key lists are the destructive channel: a leak here does not merely
    // disclose A's ids, it tells B's client to delete rows it does not have —
    // and would tell A's client that B's absent rows are gone.
    expect(body.nodeIds).toEqual([])
    expect(body.linkKeys).toEqual([])
    expect(body.nodes).toEqual([])
    expect(body.links).toEqual([])
  })

  it("B's status counts none of A's rows", async () => {
    const { env } = await seededEnv()
    const status = await (await get(env, "bob-token", "/api/replica/status")).json()
    expect(status).toMatchObject({ counts: { nodes: 0, links: 0, pages: 0 } })
  })

  it("B writing rows with A's ids does not touch A's data", async () => {
    const { env, driver } = await seededEnv()
    await push(env, "bob-token", {
      nodes: [
        {
          id: "blk_noteaaaaaa",
          type: "page",
          text: "bob's overwrite",
          props: null,
          updated_at: 999999,
        },
        { id: "blk_secret0001", type: "text", text: "bob's", props: null, updated_at: 999999 },
      ],
      links: [],
    })
    const alice = (await (
      await get(env, "alice-token", "/api/replica/notes")
    ).json()) as ReplicaCorpusBody
    expect(alice.nodes).toEqual(aliceRows.nodes)
    // Both tenants now hold the same id — proof the composite key is per-tenant.
    const rows = await driver.exec(
      "SELECT user_id, text FROM nodes WHERE id = 'blk_noteaaaaaa' ORDER BY user_id",
    )
    expect(rows).toEqual([
      { user_id: 111, text: "alice's note" },
      { user_id: 222, text: "bob's overwrite" },
    ])
  })

  it("B deleting A's ids tombstones only B's copies", async () => {
    const { env, driver } = await seededEnv()
    await push(env, "bob-token", {
      nodes: aliceRows.nodes.map((row) => ({ ...row, text: "bob's" })),
      links: [],
    })
    await push(env, "bob-token", {
      nodes: [],
      links: [],
      deleteNodes: ["blk_noteaaaaaa", "blk_secret0001"],
    })
    const alive = await driver.exec(
      "SELECT user_id, COUNT(*) AS n FROM nodes WHERE deleted_at IS NULL GROUP BY user_id",
    )
    expect(alive).toEqual([{ user_id: 111, n: 2 }])
  })

  it("rejects with 401 before any tenant work happens", async () => {
    const { env, driver } = await testEnv()
    const response = await replica(
      new Request("https://example.com/api/replica/notes"),
      env,
      github,
    )
    expect(response.status).toBe(401)
    expect(await driver.exec("SELECT COUNT(*) AS n FROM meta")).toEqual([{ n: 2 }])
  })

  it("a control-plane rejection (blocked user) also stops before tenant work", async () => {
    const { env, driver } = await testEnv()
    await driver.exec(
      "INSERT INTO users (github_id, login, status, created_at) VALUES (?1, 'b', 'blocked', 1)",
      [222],
    )
    const response = await get(env, "bob-token", "/api/replica/status")
    expect(response.status).toBe(403)
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 0 }])
  })

  it("rejects a malformed since cursor with 400", async () => {
    const { env } = await testEnv()
    const response = await get(env, "alice-token", "/api/replica/notes?since=abc")
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_since" })
  })

  it("rejects an invalid payload with 400 before writing", async () => {
    const { env, driver } = await testEnv()
    const response = await push(env, "alice-token", { nodes: [{ nope: true }], links: [] })
    expect(response.status).toBe(400)
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes")).toEqual([{ n: 0 }])
  })

  it("answers 404 for an unknown replica route", async () => {
    const { env } = await testEnv()
    const response = await get(env, "alice-token", "/api/replica/nope")
    expect(response.status).toBe(404)
  })
})

describe("the control plane is not tenant data", () => {
  it("resolveTenancy still admits an id that is not yet a tenant", async () => {
    // The `users`/`allowlist` lookup has to happen BEFORE a tenant exists, so
    // those tables are deliberately outside the tenant scope. Proving it: a
    // brand-new id signs in and gets a corpus.
    const github = githubStub({ "new-token": { id: 4242, login: "new" } })
    const driver = await createTenantTestDriver()
    await driver.execScript(migration0003)
    const env = {
      DB: asFakeD1(driver),
      SIGNUP_MODE: "open",
    } as unknown as Env
    const response = await replica(
      new Request("https://example.com/api/replica/status", { headers: authHeaders("new-token") }),
      env,
      github,
    )
    expect(response.status).toBe(200)
    expect(await driver.exec("SELECT github_id FROM users")).toEqual([{ github_id: 4242 }])
  })
})

describe("createTestSqlDriver", () => {
  it("is a real engine (the suites above are not asserting against a fake)", async () => {
    const driver = createTestSqlDriver()
    await driver.execScript("CREATE TABLE t (a INTEGER)")
    await driver.exec("INSERT INTO t (a) VALUES (1)")
    expect(await driver.exec("SELECT a FROM t")).toEqual([{ a: 1 }])
  })
})
