// tenant-guard: exempt — this suite reads raw storage (both tenants' rows,
// tombstones included) on purpose: that is how it proves the scoping works.
import { describe, expect, it } from "vitest"
import migration0008 from "../../migrations/0008_note_type.sql?raw"
import { rowsToEvents } from "../../src/data/events"
import { expandLog } from "../../src/data/key-events"
import type { SqlDriver } from "../../src/data/sql-driver"
import { ensureTenantMeta, forTenant, type TenantDb } from "../tenancy-db"
import type { Env } from "../types"
import { rowsOfEntities } from "../../src/data/cache-rows"
import { readAllEntities } from "./cache-reads"
import { planKeyAppend } from "./event-log"
import { corpusPut, corpusStatus } from "./replica-corpus"
import {
  REPLICA_PROTOCOL_HEADERS,
  parseReplicaPayload,
  type LinkRow,
  type NodeRow,
} from "./replica-payload"
import { replica, requireSession } from "./replica"
import {
  applyControlPlane,
  asFakeD1,
  createTenantTestDriver,
  createTestSqlDriver,
  signInUser,
} from "./sqlite-test-driver"
import { resolveTenancy } from "./tenancy"

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
    // A note id rides along when present and is optional otherwise; anything
    // that is not a string is malformed.
    expect(
      parseReplicaPayload({ nodes: [{ ...node, notes_id: "note1" }], links: [] })?.nodes[0]
        .notes_id,
    ).toBe("note1")
    expect(parseReplicaPayload({ nodes: [{ ...node, notes_id: null }], links: [] })).not.toBeNull()
    expect(parseReplicaPayload({ nodes: [{ ...node, notes_id: 7 }], links: [] })).toBeNull()
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

describe("the planned write", () => {
  const write = { actor: 111, origin: "replica" as const, client: null, now: NOW, appendId: "apd" }
  const events = rowsToEvents(
    { nodes: new Map(), links: new Map(), views: new Map() },
    { nodes: [node], links: [link] },
    { batch: "apd", device: "tab", now: NOW },
  )

  const keys = expandLog(events)

  it("every statement names its tenant with the :tenant token, never a parameter", () => {
    // The log insert, the cache upsert, the watermark.
    const statements = planKeyAppend(keys, write)
    expect(statements).toHaveLength(3)
    for (const statement of statements) {
      expect(statement.sql).toContain("user_id")
      expect(statement.sql).toContain(":tenant")
    }
    // The one user id among the parameters is the ACTOR — who wrote, recorded
    // beside the event — and never which tenant's rows are written.
    const [append, ...projections] = planKeyAppend(keys, write)
    expect(append.params).toContain(111)
    for (const statement of projections) expect(statement.params ?? []).not.toContain(111)
  })

  it("plans only the watermark for a write that changes nothing", () => {
    const statements = planKeyAppend([], write)
    expect(statements).toHaveLength(1)
    expect(statements[0].sql).toContain("'cache_seq'")
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

/**
 * Attach the sequence the replica would have assigned. `rowsToEvents`
 * derives deletes first, then nodes, then views, then links, and each row
 * of each event takes the next value — a block's create is four rows (its
 * liveness, type, text and note id), a view's six, a link's five — and a
 * row takes the seq of its last. So a push of two nodes and one link lays
 * down 4, 8 and 13.
 */
const withSeq = <T>(row: T, seq: number): T & { seq: number } => ({ ...row, seq })

/** Every block and link of a tenant as the cache holds them, tombstones too
 * (docs/events-log-cache.md): what the row pull used to answer. */
const corpusOf = async (tenant: TenantDb) => rowsOfEntities(await readAllEntities(tenant))

describe("corpus operations over the real D1 schema", () => {
  const nodes: NodeRow[] = [
    { id: "blk_noteaaaaaa", type: "note", text: "blk_noteaaaaaa", props: null, updated_at: 100 },
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

  it("a write lands every entity in the cache, with the sequence each reached", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, { nodes, links, cursor: "42" }, NOW)
    // An entity's seq is its last event's, NOT the client's push cursor
    // ("42"): the two were conflated once, and only one orders the log.
    // The cache answers by id, not by the order of the push.
    expect(await corpusOf(tenant)).toEqual({
      nodes: [withSeq(nodes[1], 8), withSeq(nodes[0], 4)],
      links: [withSeq(links[0], 13)],
    })
  })

  it("an edit at a LOWER updated_at than the rows stored still lands, at its event's seq", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, { nodes, links }, NOW)
    // The order is the log's sequence, never a clock.
    await corpusPut(
      tenant,
      { nodes: [{ ...nodes[1], text: "A2", updated_at: 301 }], links: [] },
      NOW,
    )
    expect(await corpusOf(tenant)).toEqual({
      nodes: [withSeq({ ...nodes[1], text: "A2", updated_at: 301 }, 14), withSeq(nodes[0], 4)],
      links: [withSeq(links[0], 13)],
    })
  })

  it("a write from a device with a BEHIND clock still lands", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, { nodes, links }, NOW)
    // Device B's clock is four minutes slow, so this row lands with an
    // `updated_at` well BEHIND rows already stored. A device pulls the log
    // by sequence, so nothing compares clocks on the way.
    const skewed = { ...nodes[1], id: "blk_skewed0001", text: "late", updated_at: 60 }
    await corpusPut(tenant, { nodes: [skewed], links: [] }, NOW)
    expect((await corpusOf(tenant)).nodes).toContainEqual(withSeq(skewed, 17))
  })

  it("a push echoes the cursor it committed, so no status call is needed", async () => {
    const tenant = await openTenant(1)
    expect(await corpusPut(tenant, { nodes, links, cursor: "42" }, NOW)).toEqual({
      ok: true,
      nodes: 2,
      links: 1,
      deletes: 0,
      cursor: "42",
    })
    // Chunked pushes carry the cursor only on the last chunk; the rest say so.
    expect((await corpusPut(tenant, { nodes: [], links: [] }, NOW)).cursor).toBeNull()
    expect((await corpusStatus(tenant)).replica_cursor).toBe("42")
  })

  it("a fresh corpus holds nothing", async () => {
    const tenant = await openTenant(1)
    expect(await corpusOf(tenant)).toEqual({ nodes: [], links: [] })
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
    expect((await corpusOf(first)).nodes[0].text).toBe("from-b")

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
    expect((await corpusOf(reversed)).nodes[0].text).toBe("from-a")
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
    const pulled = await corpusOf(tenant)
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
      { id: "blk_noteaaaaaa", type: "note", text: "blk_noteaaaaaa", props: null, updated_at: 100 },
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

  it("a tombstone is an entity like any other, and stops counting", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, rows, NOW)
    await corpusPut(
      tenant,
      { nodes: [{ ...rows.nodes[1], updated_at: 200, deleted_at: 200 }], links: [] },
      NOW,
    )

    const pulled = await corpusOf(tenant)
    // The tombstone is itself the change, carrying its stamp and a fresh
    // seq: a device learns of the deletion from the log like any edit.
    expect(pulled.nodes.find((row) => row.id === "blk_a000000000")).toEqual(
      withSeq({ ...rows.nodes[1], updated_at: 200, deleted_at: 200 }, 14),
    )
    // …and the link to it is retained, untouched — though a link into a
    // tombstoned node is not part of the graph anyone can see, so it stops
    // counting alongside the node.
    expect(pulled.links).toEqual([withSeq(rows.links[0], 13)])
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
    const pulled = await corpusOf(tenant)
    const revived = pulled.nodes.find((row) => row.id === "blk_a000000000")
    expect(revived).toEqual(withSeq({ ...rows.nodes[1], text: "back", updated_at: 300 }, 16))
    expect((await corpusStatus(tenant)).counts.nodes).toBe(2)
  })

  it("the legacy delete channel tombstones instead of removing", async () => {
    const tenant = await openTenant(1)
    await corpusPut(tenant, rows, NOW)
    await corpusPut(tenant, { nodes: [], links: [], deleteNodes: ["blk_a000000000"] }, NOW)
    const pulled = await corpusOf(tenant)
    expect(pulled.nodes).toHaveLength(2)
    expect(pulled.nodes.find((row) => row.id === "blk_a000000000")?.deleted_at).toBe(NOW)
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
  await applyControlPlane(driver)
  // Alice and Bob have signed in (the callback provisions the row; the API
  // path cannot). The owner and the stranger deliberately have not.
  await signInUser(driver, 111, "alice")
  await signInUser(driver, 222, "bob")
  const env = {
    DB: asFakeD1(driver),
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
    const { env } = await testEnv({ SIGNUP_MODE: "invite" })
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
    const { env, driver } = await testEnv({ SIGNUP_MODE: undefined, ALLOWED_GITHUB_ID: "42536816" })
    await signInUser(driver, 42536816, "finn")
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
      { id: "blk_noteaaaaaa", type: "note", text: "alice's note", props: null, updated_at: 100 },
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

  // Every request here is a CURRENT client: the protocol gate's code default
  // is 3 (the cache of the log), so a request without the header is refused
  // before any of the scoping these tests are about is reached.
  const clientHeaders = (token: string) => ({ ...authHeaders(token), ...REPLICA_PROTOCOL_HEADERS })
  /** Rows as the key events a client pushes (`opsToKeyEvents` would make
   * them): the events the rows amount to, read per key. */
  const keyEventsOf = (
    rows: { nodes: NodeRow[]; links: LinkRow[] },
    device = "dev12345.tab001",
    now = NOW,
  ) =>
    expandLog(
      rowsToEvents({ nodes: new Map(), links: new Map(), views: new Map() }, rows, {
        batch: `bat_${now}`,
        device,
        now,
      }),
    )
  let minted = 0
  /** One key event of a client's own: a set, or a liveness row. */
  const keyEvent = (
    entityId: string,
    action: "set" | "delete",
    key: string,
    value: unknown,
    at: number,
    device = "dev12345.tab001",
  ) => ({
    id: `key_own_${(minted += 1)}`,
    entity: "block",
    entity_id: entityId,
    action,
    key,
    value,
    batch: "bat_own",
    device,
    at,
    hlc: `${String(at).padStart(15, "0")}-0000-${device}`,
    v: 2,
  })
  /** A push of key events: the door a client of this build uses. */
  const push = (env: Env, token: string, body: unknown, query = "") =>
    replica(
      new Request(`https://example.com/api/replica/events${query}`, {
        method: "PUT",
        headers: clientHeaders(token),
        body: JSON.stringify(body),
      }),
      env,
      github,
    )
  const get = (env: Env, token: string, path: string) =>
    replica(
      new Request(`https://example.com${path}`, { headers: clientHeaders(token) }),
      env,
      github,
    )

  async function seededEnv(): Promise<{ env: Env; driver: SqlDriver }> {
    const made = await testEnv()
    expect(
      (await push(made.env, "alice-token", { events: keyEventsOf(aliceRows), cursor: "c1" }))
        .status,
    ).toBe(200)
    return made
  }

  it("a push lands under the VERIFIED id, whatever tenant the request claims", async () => {
    const { env, driver } = await testEnv()
    // The request claims tenant 222 everywhere a client could put it.
    const response = await replica(
      new Request("https://example.com/api/replica/events?github_id=222&tenant=222&user_id=222", {
        method: "PUT",
        headers: { ...clientHeaders("alice-token"), "X-GitHub-Id": "222", "X-Tenant": "222" },
        body: JSON.stringify({
          events: keyEventsOf(aliceRows),
          user_id: 222,
          tenant: 222,
          cursor: "c1",
        }),
      }),
      env,
      github,
    )
    expect(response.status).toBe(200)
    const owners = await driver.exec(
      "SELECT DISTINCT user_id FROM events_log_cache ORDER BY user_id",
    )
    expect(owners).toEqual([{ user_id: 111 }])
  })

  it("a client below the minimum protocol is refused with 409", async () => {
    const { env } = await seededEnv()
    // A protocol-2 client — the build before the cache of the log, which
    // pushed and pulled rows through routes this Worker no longer serves —
    // and a client with no header at all: both refused, against the CODE
    // default, which is 3 (docs/events-log-cache.md).
    for (const headers of [
      { ...authHeaders("alice-token"), "X-Replica-Protocol": "2" },
      authHeaders("alice-token"),
    ]) {
      const old = await replica(
        new Request("https://example.com/api/replica/status", { headers }),
        env,
        github,
      )
      expect(old.status).toBe(409)
      expect(await old.json()).toEqual({ error: "client_too_old", minimum: 3 })
    }
    // The current build.
    expect((await get(env, "alice-token", "/api/replica/status")).status).toBe(200)
  })

  it("the MIN_REPLICA_PROTOCOL var overrides the code default, either way", async () => {
    const { env } = await seededEnv()
    // Lowered: a pre-header client is let back in without a deploy.
    const lax = { ...env, MIN_REPLICA_PROTOCOL: "0" }
    const old = await replica(
      new Request("https://example.com/api/replica/status", {
        headers: authHeaders("alice-token"),
      }),
      lax,
      github,
    )
    expect(old.status).toBe(200)
    // Raised above what this build speaks: even the current client is shut out
    // — the dashboard lever a rollout pulls BEFORE a migration.
    const strict = { ...env, MIN_REPLICA_PROTOCOL: "4" }
    const current = await get(strict, "alice-token", "/api/replica/status")
    expect(current.status).toBe(409)
    expect(await current.json()).toEqual({ error: "client_too_old", minimum: 4 })
  })

  it("the protocol gate sits behind auth: no session, no verdict", async () => {
    const { env } = await seededEnv()
    const strict = { ...env, MIN_REPLICA_PROTOCOL: "4" }
    const res = await replica(new Request("https://example.com/api/replica/status"), strict, github)
    expect(res.status).toBe(401)
  })

  it("the row routes are gone: a push or a pull of rows is not found", async () => {
    const { env } = await seededEnv()
    expect((await get(env, "alice-token", "/api/replica/notes")).status).toBe(404)
    expect((await get(env, "alice-token", "/api/replica/notes?since=0")).status).toBe(404)
    const put = await replica(
      new Request("https://example.com/api/replica/notes", {
        method: "PUT",
        headers: clientHeaders("alice-token"),
        body: JSON.stringify(aliceRows),
      }),
      env,
      github,
    )
    expect(put.status).toBe(404)
  })

  it("B's snapshot of the cache holds none of A's rows", async () => {
    const { env } = await seededEnv()
    const body = await (await get(env, "bob-token", "/api/replica/cache")).json()
    // Exhaustive: any of A's rows here would be a cross-tenant disclosure.
    expect(body).toEqual({ rows: [], seq: 0, cursor: null, replica_id: "production" })
  })

  it("B's log holds none of A's events", async () => {
    const { env } = await seededEnv()
    const body = await (await get(env, "bob-token", "/api/replica/events-log?since=0")).json()
    expect(body).toEqual({ events: [], cursor: null, replica_id: "production" })
  })

  it("B's status counts none of A's rows", async () => {
    const { env } = await seededEnv()
    const status = await (await get(env, "bob-token", "/api/replica/status")).json()
    expect(status).toMatchObject({ counts: { nodes: 0, links: 0, pages: 0 } })
  })

  it("B writing A's ids does not touch A's data", async () => {
    const { env, driver } = await seededEnv()
    await push(env, "bob-token", {
      events: keyEventsOf({
        nodes: [
          {
            id: "blk_noteaaaaaa",
            type: "note",
            text: "bob's overwrite",
            props: null,
            updated_at: 999999,
          },
          { id: "blk_secret0001", type: "text", text: "bob's", props: null, updated_at: 999999 },
        ],
        links: [],
      }),
    })
    const alice = await corpusOf(forTenant(driver, identityOf(111)))
    expect(alice.nodes).toEqual(aliceRows.nodes.map((row, i) => withSeq(row, 4 * (i + 1))))
    // Both tenants now hold the same id — proof the composite key is per-tenant.
    const rows = await driver.exec(
      "SELECT user_id, json_extract(value, '$') AS text FROM events_log_cache " +
        "WHERE entity = 'block' AND entity_id = 'blk_noteaaaaaa' AND key = 'text' ORDER BY user_id",
    )
    expect(rows).toEqual([
      { user_id: 111, text: "alice's note" },
      { user_id: 222, text: "bob's overwrite" },
    ])
  })

  it("B deleting A's ids tombstones only B's copies", async () => {
    const { env, driver } = await seededEnv()
    await push(env, "bob-token", {
      events: keyEventsOf({
        nodes: aliceRows.nodes.map((row) => ({ ...row, text: "bob's" })),
        links: [],
      }),
    })
    await push(env, "bob-token", {
      events: [
        keyEvent("blk_noteaaaaaa", "delete", "", null, 900),
        keyEvent("blk_secret0001", "delete", "", null, 900),
      ],
    })
    const alive = await driver.exec(
      "SELECT user_id, COUNT(*) AS n FROM events_log_cache WHERE entity = 'block' " +
        "AND key = 'deleted' AND value = 'null' GROUP BY user_id",
    )
    expect(alive).toEqual([{ user_id: 111, n: 2 }])
  })

  it("rejects with 401 before any tenant work happens", async () => {
    const { env, driver } = await testEnv()
    const response = await replica(
      new Request("https://example.com/api/replica/status"),
      env,
      github,
    )
    expect(response.status).toBe(401)
    expect(await driver.exec("SELECT COUNT(*) AS n FROM meta")).toEqual([{ n: 2 }])
  })

  it("a control-plane rejection (blocked user) also stops before tenant work", async () => {
    const { env, driver } = await testEnv()
    await driver.exec("UPDATE users SET status = 'blocked' WHERE github_id = ?1", [222])
    const response = await get(env, "bob-token", "/api/replica/status")
    expect(response.status).toBe(403)
    expect(await driver.exec("SELECT COUNT(*) AS n FROM events_log_cache")).toEqual([{ n: 0 }])
  })

  it("rejects an invalid payload with 400 before writing", async () => {
    const { env, driver } = await testEnv()
    const response = await push(env, "alice-token", { nodes: [{ nope: true }], links: [] })
    expect(response.status).toBe(400)
    expect(await driver.exec("SELECT COUNT(*) AS n FROM events_log_cache")).toEqual([{ n: 0 }])
  })

  it("answers 404 for an unknown replica route", async () => {
    const { env } = await testEnv()
    const response = await get(env, "alice-token", "/api/replica/nope")
    expect(response.status).toBe(404)
  })

  // The log is corpus data like any other: it is the tenant's, it names who
  // wrote it, and nobody else's token reaches it.
  describe("the event log over HTTP", () => {
    const post = (env: Env, token: string, path: string, body: unknown) =>
      replica(
        new Request(`https://example.com${path}`, {
          method: "POST",
          headers: clientHeaders(token),
          body: JSON.stringify(body),
        }),
        env,
        github,
      )

    it("a push is events, carrying the device and build the writer named", async () => {
      const { env } = await testEnv()
      const response = await replica(
        new Request("https://example.com/api/replica/events", {
          method: "PUT",
          headers: {
            ...clientHeaders("alice-token"),
            "X-Ruminate-Device": "dev12345.tab001",
            "X-Ruminate-Build": "2026-W39.abc",
          },
          body: JSON.stringify({ events: keyEventsOf(aliceRows) }),
        }),
        env,
        github,
      )
      expect(response.status).toBe(200)
      const { events, cursor } = (await (
        await get(env, "alice-token", "/api/replica/events-log")
      ).json()) as { events: Record<string, unknown>[]; cursor: number }
      // Four rows per block, five for the link.
      expect(
        events
          .filter((event) => event.key === "")
          .map((event) => `${event.entity}.${event.action}`),
      ).toEqual(["block.create", "block.create", "link.create"])
      expect(cursor).toBe(13)
      expect(events[0]).toMatchObject({
        actor: 111,
        origin: "replica",
        device: "dev12345.tab001",
        client: "2026-W39.abc",
      })
    })

    it("drops a device a writer could not plausibly have sent, rather than store it", async () => {
      const { env } = await testEnv()
      await replica(
        new Request("https://example.com/api/replica/events", {
          method: "PUT",
          headers: { ...clientHeaders("alice-token"), "X-Ruminate-Device": "<script>" },
          body: JSON.stringify({ events: keyEventsOf(aliceRows, "<script>") }),
        }),
        env,
        github,
      )
      const { events } = (await (
        await get(env, "alice-token", "/api/replica/events-log")
      ).json()) as { events: { device: string }[] }
      expect(events[0].device).toBe("unknown")
    })

    it("a push of key events lands, answers each row's place in the log, and is served back per key", async () => {
      const { env } = await testEnv()
      const row = (n: number, action: string, key: string, value: unknown) => ({
        id: `key_${n}`,
        entity: "block",
        entity_id: "blk_a",
        action,
        key,
        value,
        batch: "b1",
        device: "dev12345.tab001",
        at: 1_000 + n,
        hlc: `${String(1_000 + n).padStart(15, "0")}-0000-dev12345.tab001`,
        v: 2,
      })
      const events = [
        row(1, "create", "", null),
        row(2, "set", "type", "image"),
        row(3, "set", "text", "A"),
        row(4, "set", "notes_id", null),
        row(5, "set", "props.align", "left"),
      ]
      const response = await replica(
        new Request("https://example.com/api/replica/events", {
          method: "PUT",
          headers: clientHeaders("alice-token"),
          body: JSON.stringify({ events, cursor: "c9" }),
        }),
        env,
        github,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        ok: true,
        appended: 5,
        stale: 0,
        seqs: [1, 2, 3, 4, 5].map((seq) => [`key_${seq}`, seq]),
        cursor: "c9",
      })
      const served = (await (await get(env, "alice-token", "/api/replica/events-log")).json()) as {
        events: Record<string, unknown>[]
        cursor: number
      }
      expect(served.cursor).toBe(5)
      expect(served.events.map((event) => `${event.action} ${event.key}`)).toEqual([
        "create ",
        "set type",
        "set text",
        "set notes_id",
        "set props.align",
      ])
      expect(served.events[4]).toMatchObject({ value: "left", event: "key_1", actor: 111 })
      expect(served.events[4].event_seq).toBeUndefined()
      // The cache holds the block's key, at its event's seq.
      const snapshot = (await (await get(env, "alice-token", "/api/replica/cache")).json()) as {
        rows: Record<string, unknown>[]
      }
      expect(snapshot.rows).toContainEqual(
        expect.objectContaining({
          entity_id: "blk_a",
          key: "props.align",
          value: '"left"',
          seq: 5,
        }),
      )
      // The verify folds the log and reads the cache.
      expect(await (await get(env, "alice-token", "/api/replica/verify")).json()).toMatchObject({
        ok: true,
        keyEvents: 5,
        rows: 5,
        drift: [],
        behind: 0,
      })
    })

    it("refuses a push of key events that is not what this build sends, whole", async () => {
      const { env } = await testEnv()
      const bad = await replica(
        new Request("https://example.com/api/replica/events", {
          method: "PUT",
          headers: clientHeaders("alice-token"),
          body: JSON.stringify({
            events: [
              {
                id: "key_1",
                entity: "block",
                entity_id: "blk_a",
                action: "set",
                key: "props.bad key",
                value: 1,
                batch: "b1",
                device: "d",
                at: 1,
                v: 2,
              },
            ],
          }),
        }),
        env,
        github,
      )
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: "invalid_payload" })
      const log = (await (await get(env, "alice-token", "/api/replica/events-log")).json()) as {
        events: unknown[]
      }
      expect(log.events).toEqual([])
    })

    it("neither a snapshot nor a page of the log reconciles: a row around the log stays out", async () => {
      // A row written into the old table around the log (the console) is
      // not what is served any more: every reader reads the cache, which
      // only the log's own append writes (docs/events-log-cache.md).
      const { env, driver } = await seededEnv()
      await driver.exec(
        "INSERT INTO nodes (user_id, id, type, text, props, updated_at, seq) " +
          "VALUES (111, 'blk_aroundlog1', 'note', 'around the log', NULL, 100, 900)",
      )
      const page = async () =>
        (await (await get(env, "alice-token", "/api/replica/events-log")).json()) as {
          events: { entity_id: string; action: string }[]
        }
      const before = await page()
      expect(before.events.some((event) => event.entity_id === "blk_aroundlog1")).toBe(false)
      const snapshot = (await (await get(env, "alice-token", "/api/replica/cache")).json()) as {
        rows: { entity_id: string }[]
      }
      expect(snapshot.rows.some((row) => row.entity_id === "blk_aroundlog1")).toBe(false)
      const after = await page()
      expect(after.events.some((event) => event.entity_id === "blk_aroundlog1")).toBe(false)
    })

    it("serves the cache in pages, keyed, to the tenant alone", async () => {
      const { env } = await seededEnv()
      const page = async (token: string, query: string) =>
        (await (await get(env, token, `/api/replica/cache${query}`)).json()) as {
          rows: { entity: string; entity_id: string; key: string; seq: number }[]
          seq: number
          cursor: [string, string, string] | null
          replica_id: string
        }
      // Alice's first push: two blocks of four rows and a link of five.
      const first = await page("alice-token", "?limit=8")
      expect(first.rows).toHaveLength(8)
      expect(first.rows.map((row) => `${row.entity} ${row.entity_id} ${row.key}`)).toEqual([
        "block blk_noteaaaaaa deleted",
        "block blk_noteaaaaaa notes_id",
        "block blk_noteaaaaaa text",
        "block blk_noteaaaaaa type",
        "block blk_secret0001 deleted",
        "block blk_secret0001 notes_id",
        "block blk_secret0001 text",
        "block blk_secret0001 type",
      ])
      expect(first).toMatchObject({ seq: 13, replica_id: "production" })
      expect(first.cursor).toEqual(["block", "blk_secret0001", "type"])
      const rest = await page(
        "alice-token",
        `?limit=8&after=${encodeURIComponent(JSON.stringify(first.cursor))}`,
      )
      expect(rest.rows.map((row) => `${row.entity_id} ${row.key}`)).toEqual([
        "blk_noteaaaaaa|blk_secret0001|child deleted",
        "blk_noteaaaaaa|blk_secret0001|child destination_id",
        "blk_noteaaaaaa|blk_secret0001|child kind",
        "blk_noteaaaaaa|blk_secret0001|child sort_key",
        "blk_noteaaaaaa|blk_secret0001|child source_id",
      ])
      expect(rest.cursor).toBeNull()
      // Bob's page holds none of Alice's rows.
      expect(await page("bob-token", "")).toMatchObject({ rows: [], cursor: null, seq: 0 })
      const bad = await get(env, "alice-token", "/api/replica/cache?after=nope")
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: "invalid_after" })
      const short = await get(env, "alice-token", '/api/replica/cache?after=["block"]')
      expect(short.status).toBe(400)
    })

    it("one tenant's log and past are not another's to read", async () => {
      const { env } = await seededEnv()
      const log = (await (await get(env, "bob-token", "/api/replica/events")).json()) as {
        events: unknown[]
      }
      expect(log.events).toEqual([])
      const past = (await (await get(env, "bob-token", "/api/replica/at?seq=99")).json()) as {
        nodes: unknown[]
        earliest: unknown
      }
      expect(past.nodes).toEqual([])
      expect(past.earliest).toBeNull()
      const history = await get(
        env,
        "bob-token",
        "/api/replica/events?entity=block&entity_id=blk_secret0001",
      )
      expect(((await history.json()) as { events: unknown[] }).events).toEqual([])
    })

    it("serves a past moment, one block's history, and a clean bill of health", async () => {
      const { env } = await seededEnv()
      await push(env, "alice-token", {
        events: [keyEvent("blk_secret0001", "set", "text", "rewritten", 200)],
      })

      // The first push was 13 rows: the moment at its end.
      const then = (await (await get(env, "alice-token", "/api/replica/at?seq=13")).json()) as {
        seq: number
        nodes: { id: string; text: string }[]
      }
      expect(then.seq).toBe(13)
      expect(then.nodes.find((row) => row.id === "blk_secret0001")?.text).toBe("alice's secret")

      const history = (await (
        await get(
          env,
          "alice-token",
          "/api/replica/events-log?entity=block&entity_id=blk_secret0001",
        )
      ).json()) as { events: { action: string; key: string; value: unknown }[] }
      expect(history.events.map((event) => [event.action, event.key, event.value])).toEqual([
        ["create", "", null],
        ["set", "type", "text"],
        ["set", "text", "alice's secret"],
        ["set", "notes_id", null],
        ["set", "text", "rewritten"],
      ])

      const verdict = await (await get(env, "alice-token", "/api/replica/verify")).json()
      expect(verdict).toMatchObject({ ok: true, keyEvents: 14, drift: [], behind: 0 })
    })

    it("restores by appending — for the tenant, and only with a well-formed request", async () => {
      const { env } = await seededEnv()
      await push(env, "alice-token", {
        events: [keyEvent("blk_secret0001", "set", "text", "", 200)],
      })

      const bad = await post(env, "alice-token", "/api/replica/restore", { block: "", seq: "4" })
      expect(bad.status).toBe(400)
      // Bob naming Alice's block restores nothing: it is not in HIS log.
      const bob = await post(env, "bob-token", "/api/replica/restore", {
        block: "blk_secret0001",
        seq: 13,
      })
      expect(await bob.json()).toEqual({ ok: true, events: 0 })

      const ok = await post(env, "alice-token", "/api/replica/restore", {
        block: "blk_secret0001",
        seq: 13,
      })
      expect(await ok.json()).toEqual({ ok: true, events: 1 })
      const snapshot = (await (await get(env, "alice-token", "/api/replica/cache")).json()) as {
        rows: { entity_id: string; key: string; value: string; seq: number }[]
      }
      const text = snapshot.rows.find(
        (row) => row.entity_id === "blk_secret0001" && row.key === "text",
      )
      expect(text).toMatchObject({ value: JSON.stringify("alice's secret") })
      // The restore's row carries a fresh seq, so every device pulls it.
      expect(text?.seq).toBeGreaterThan(14)
    })

    it("takes a client's own events, scoped to the tenant, with the header's device as the fallback", async () => {
      const { env } = await seededEnv()
      const event = (id: string, text: string, device = "dev12345.tab001") => ({
        id,
        entity: "block",
        entity_id: "blk_bob0000001",
        action: id.endsWith("1") ? "create" : "update",
        patch: id.endsWith("1") ? { type: "text", text, props: null, notes_id: null } : { text },
        batch: "bat_1",
        device,
        at: 500,
        tz: -300,
        v: 1,
      })
      const response = await replica(
        new Request("https://example.com/api/replica/events", {
          method: "PUT",
          headers: { ...clientHeaders("bob-token"), "X-Ruminate-Device": "hdr00000.tab999" },
          body: JSON.stringify({
            events: [event("evt_1", "bob's"), event("evt_2", "bob's own", "<script>")],
            cursor: "bob-c1",
          }),
        }),
        env,
        github,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        ok: true,
        appended: 2,
        stale: 0,
        seqs: [
          ["evt_1", 4],
          ["evt_2", 5],
        ],
        cursor: "bob-c1",
      })
      const bobs = (await (await get(env, "bob-token", "/api/replica/events-log")).json()) as {
        events: Record<string, unknown>[]
      }
      expect(bobs.events.map((e) => [e.event, e.device, e.tz, e.actor])).toEqual([
        ["evt_1", "dev12345.tab001", -300, 222],
        ["evt_1", "dev12345.tab001", -300, 222],
        ["evt_1", "dev12345.tab001", -300, 222],
        ["evt_1", "dev12345.tab001", -300, 222],
        ["evt_2", "hdr00000.tab999", -300, 222],
      ])
      // Alice's log is Alice's: nothing of Bob's reached it.
      const alices = (await (await get(env, "alice-token", "/api/replica/events-log")).json()) as {
        events: { event: string }[]
      }
      expect(alices.events.map((e) => e.event)).not.toContain("evt_1")
      // And the row is Bob's to take, with the cursor he stamped.
      const snapshot = (await (await get(env, "bob-token", "/api/replica/cache")).json()) as {
        rows: { entity_id: string; key: string; value: string }[]
      }
      expect(snapshot.rows.find((row) => row.key === "text")).toMatchObject({
        entity_id: "blk_bob0000001",
        value: JSON.stringify("bob's own"),
      })
      const status = (await (await get(env, "bob-token", "/api/replica/status")).json()) as {
        replica_cursor: string
      }
      expect(status.replica_cursor).toBe("bob-c1")
    })

    it("refuses a push of events with one malformed event, whole", async () => {
      const { env } = await seededEnv()
      const bad = await replica(
        new Request("https://example.com/api/replica/events", {
          method: "PUT",
          headers: clientHeaders("alice-token"),
          body: JSON.stringify({
            events: [
              {
                id: "evt_x",
                entity: "block",
                entity_id: "blk_secret0001",
                action: "update",
                patch: { text: 42 },
                batch: "b",
                device: "d",
                at: 1,
                v: 1,
              },
            ],
          }),
        }),
        env,
        github,
      )
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: "invalid_payload" })
      const log = (await (await get(env, "alice-token", "/api/replica/events")).json()) as {
        events: { id: string }[]
      }
      expect(log.events.map((e) => e.id)).not.toContain("evt_x")
    })

    it("refuses a moment that is neither a seq nor a time, and half an entity", async () => {
      const { env } = await seededEnv()
      expect((await get(env, "alice-token", "/api/replica/at")).status).toBe(400)
      expect((await get(env, "alice-token", "/api/replica/at?seq=1&at=2")).status).toBe(400)
      expect((await get(env, "alice-token", "/api/replica/events?entity=block")).status).toBe(400)
      expect(
        (await get(env, "alice-token", "/api/replica/events?entity=note&entity_id=x")).status,
      ).toBe(400)
    })
  })

  // Which database answered (docs/preview-databases.md): production has no
  // REPLICA_ID; a preview version carries its clone's id. Every snapshot
  // page, every page of the log and the status say, so a client can tell a
  // rebuilt clone from the one it last pulled and discard a cursor that no
  // longer means anything.
  describe("replica_id", () => {
    type Labelled = { replica_id?: string; rows?: unknown[] }
    const labelled = async (env: Env, path: string) =>
      (await (await get(env, "alice-token", path)).json()) as Labelled

    it('is "production" without the var, on the snapshot, the log and status alike', async () => {
      const { env } = await seededEnv()
      const snapshot = await labelled(env, "/api/replica/cache")
      const log = await labelled(env, "/api/replica/events-log?since=0")
      const status = await labelled(env, "/api/replica/status")
      expect(snapshot.replica_id).toBe("production")
      expect(log.replica_id).toBe("production")
      expect(status.replica_id).toBe("production")
    })

    it("is the REPLICA_ID var when set, and an empty var counts as unset", async () => {
      const { env } = await seededEnv()
      const preview = { ...env, REPLICA_ID: "11111111-2222-4333-8444-555555555555" }
      const snapshot = await labelled(preview, "/api/replica/cache")
      const status = await labelled(preview, "/api/replica/status")
      expect(snapshot.replica_id).toBe("11111111-2222-4333-8444-555555555555")
      expect(status.replica_id).toBe("11111111-2222-4333-8444-555555555555")
      // The rows are the same rows: the id is a label, not a filter.
      expect(snapshot.rows?.length).toBeGreaterThan(0)

      const blank = { ...env, REPLICA_ID: "" }
      const body = await labelled(blank, "/api/replica/cache")
      expect(body.replica_id).toBe("production")
    })
  })
})

describe("the control plane is not tenant data", () => {
  it("resolveTenancy still admits an id that is not yet a tenant", async () => {
    // The `users` lookup has to happen BEFORE a tenant exists, so
    // those tables are deliberately outside the tenant scope. Proving it: a
    // brand-new id signs in (the callback's resolve, address in hand) and
    // gets a corpus.
    const github = githubStub({ "new-token": { id: 4242, login: "new" } })
    const driver = await createTenantTestDriver()
    await applyControlPlane(driver)
    const env = {
      DB: asFakeD1(driver),
      SIGNUP_MODE: "open",
    } as unknown as Env
    const signedIn = await resolveTenancy(
      driver,
      { id: 4242, login: "new", name: null, email: "new@example.com" },
      { signupMode: "open", bootstrapGithubId: undefined },
    )
    expect(signedIn.allowed).toBe(true)
    const response = await replica(
      new Request("https://example.com/api/replica/status", {
        headers: { ...authHeaders("new-token"), ...REPLICA_PROTOCOL_HEADERS },
      }),
      env,
      github,
    )
    expect(response.status).toBe(200)
    expect(await driver.exec("SELECT github_id FROM users")).toEqual([{ github_id: 4242 }])
  })

  it("the API path cannot provision: a new id that never signed in is refused", async () => {
    // `requireSession` verifies `/user` alone and carries no address, and the
    // address is mandatory — so the row can only come from the callback.
    const github = githubStub({ "new-token": { id: 4343, login: "new" } })
    const { env, driver } = await testEnv()
    const response = await replica(
      new Request("https://example.com/api/replica/status", {
        headers: { ...authHeaders("new-token"), ...REPLICA_PROTOCOL_HEADERS },
      }),
      env,
      github,
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "sign_in_required" })
    expect(await driver.exec("SELECT github_id FROM users WHERE github_id = 4343")).toEqual([])
  })
})

describe("migrations/0008 — the stored note-root type value", () => {
  // 0008 is a DATA migration, so it is deliberately not in the corpus ladder
  // (src/data/corpus-schema.ts is DDL only). It still has to be valid SQL
  // against the real D1 shape, and it still has to rewrite the right rows and
  // move the right columns — which is what running the real file against the
  // real schema proves.
  const seedNode = (driver: SqlDriver, tenant: number, id: string, type: string, seq: number) =>
    driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, updated_at, seq) " +
        "VALUES (?1, ?2, ?3, ?2, 100, ?4)",
      [tenant, id, type, seq],
    )
  const seedLink = (driver: SqlDriver, tenant: number, source: string, seq: number) =>
    driver.exec(
      "INSERT INTO link (user_id, source_id, destination_id, kind, sort_key, updated_at, seq) " +
        "VALUES (?1, ?2, 'blk_child00000', 'child', 'a0', 100, ?3)",
      [tenant, source, seq],
    )

  it("rewrites every page row — tombstones included — and nothing else", async () => {
    const driver = await createTenantTestDriver()
    await seedNode(driver, 111, "blk_noteaaaaaa", "page", 1)
    await seedNode(driver, 111, "blk_blockaaaaa", "text", 2)
    await seedNode(driver, 111, "blk_futureaaaa", "note", 3)
    await driver.exec(
      "INSERT INTO nodes (user_id, id, type, text, updated_at, seq, deleted_at) " +
        "VALUES (111, 'blk_notedeadaa', 'page', 'x', 100, 4, 500)",
    )
    await driver.execScript(migration0008)
    expect(await driver.exec("SELECT id, type FROM nodes ORDER BY id")).toEqual([
      { id: "blk_blockaaaaa", type: "text" },
      { id: "blk_futureaaaa", type: "note" },
      { id: "blk_noteaaaaaa", type: "note" },
      { id: "blk_notedeadaa", type: "note" },
    ])
    // No `page` left anywhere, which is what makes the rewrite one-way.
    expect(await driver.exec("SELECT COUNT(*) AS n FROM nodes WHERE type = 'page'")).toEqual([
      { n: 0 },
    ])
    // …and the scratch table it uses for the sequence arithmetic is gone.
    expect(
      await driver.exec("SELECT name FROM sqlite_master WHERE name = 'note_type_seq_base'"),
    ).toEqual([])
  })

  it("lifts every rewritten row's `seq` above any cursor a client could hold", async () => {
    // A client's cursor is the highest `seq` it has pulled, across BOTH tables
    // (corpusPullFull/corpusPullSince). Every rewritten row must land above it,
    // or the since-pull that is meant to deliver this change skips it.
    const driver = await createTenantTestDriver()
    await seedNode(driver, 111, "blk_noteaaaaaa", "page", 1)
    await seedNode(driver, 111, "blk_notebbbbbb", "page", 2)
    await seedNode(driver, 111, "blk_blockaaaaa", "text", 3)
    await seedLink(driver, 111, "blk_noteaaaaaa", 9) // the tenant's true high-water mark
    await driver.execScript(migration0008)

    const cursor = 9
    const rewritten = (await driver.exec(
      "SELECT id, seq FROM nodes WHERE user_id = 111 AND type = 'note' ORDER BY seq",
    )) as { id: string; seq: number }[]
    expect(rewritten.map((row) => row.id)).toEqual(["blk_noteaaaaaa", "blk_notebbbbbb"])
    for (const row of rewritten) expect(row.seq).toBeGreaterThan(cursor)
    // Distinct, so neither shadows the other in the pull's ordering.
    expect(new Set(rewritten.map((row) => row.seq)).size).toBe(rewritten.length)
    // The untouched block keeps its place in the sequence.
    expect(await driver.exec("SELECT seq FROM nodes WHERE id = 'blk_blockaaaaa'")).toEqual([
      { seq: 3 },
    ])
  })

  it("leaves `updated_at` alone, so it cannot beat an unpushed local edit", async () => {
    // 0005 split delivery (`seq`) from last-writer-wins intent (`updated_at`).
    // This rewrite is the former and must not pretend to be the latter.
    const driver = await createTenantTestDriver()
    await seedNode(driver, 111, "blk_noteaaaaaa", "page", 1)
    await driver.execScript(migration0008)
    expect(await driver.exec("SELECT updated_at FROM nodes WHERE id = 'blk_noteaaaaaa'")).toEqual([
      { updated_at: 100 },
    ])
  })

  it("takes each tenant's OWN high-water mark, not the database's", async () => {
    // `seq` is scoped by user_id and is not globally unique: a busy tenant's
    // sequence must not push a quiet tenant's rows into a range its own cursor
    // has already passed, and must not leave them below its own maximum either.
    const driver = await createTenantTestDriver()
    await seedNode(driver, 111, "blk_noisyaaaaa", "text", 5000)
    await seedNode(driver, 111, "blk_noisynote0", "page", 5001)
    await seedNode(driver, 222, "blk_quietaaaaa", "text", 2)
    await seedNode(driver, 222, "blk_quietnote0", "page", 3)
    await driver.execScript(migration0008)

    const [noisy] = (await driver.exec("SELECT seq FROM nodes WHERE id = 'blk_noisynote0'")) as {
      seq: number
    }[]
    const [quiet] = (await driver.exec("SELECT seq FROM nodes WHERE id = 'blk_quietnote0'")) as {
      seq: number
    }[]
    expect(noisy.seq).toBeGreaterThan(5001)
    expect(quiet.seq).toBeGreaterThan(3)
    // The quiet tenant is not dragged up to the noisy one's range.
    expect(quiet.seq).toBeLessThan(5000)
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
