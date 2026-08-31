import { describe, expect, it, vi } from "vitest"
import migration0001 from "../../migrations/0001_init.sql?raw"
import migration0002 from "../../migrations/0002_nodes.sql?raw"
import migration0003 from "../../migrations/0003_control_plane.sql?raw"
import { ensureCorpusSchema } from "../../src/data/corpus-schema"
import type { SqlDriver } from "../../src/data/sql-driver"
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
import { asFakeD1, createTestSqlDriver } from "./sqlite-test-driver"

const node: NodeRow = { id: "blk_aaaaaaaaaa", type: "ul", text: "Hi", props: null, updated_at: 123 }
const link: LinkRow = {
  source_id: "note-a",
  destination_id: "blk_aaaaaaaaaa",
  kind: "child",
  sort_key: "a0",
  updated_at: 123,
}

describe("parseReplicaPayload", () => {
  it("accepts a well-formed payload", () => {
    const payload = parseReplicaPayload({
      nodes: [node],
      links: [link],
      deleteNodes: ["blk_old0000000"],
      deleteLinks: [["note-a", "blk_old0000000", "child"]],
      cursor: "abc123",
    })
    expect(payload).toEqual({
      nodes: [node],
      links: [link],
      deleteNodes: ["blk_old0000000"],
      deleteLinks: [["note-a", "blk_old0000000", "child"]],
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
  it("plans deletes first, then node upserts before link upserts", () => {
    const statements = planReplicaPut({
      nodes: [node],
      links: [link],
      deleteNodes: ["blk_gone000000"],
      deleteLinks: [["note-a", "blk_gone000000", "child"]],
      cursor: "c1",
    })
    expect(statements.map((s) => s.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      "DELETE FROM link",
      "DELETE FROM link",
      "DELETE FROM nodes",
      "INSERT INTO nodes",
      "INSERT INTO link",
      "UPDATE meta SET",
    ])
    expect(statements[3].params).toEqual(["blk_aaaaaaaaaa", "ul", "Hi", null, 123])
    expect(statements[4].params).toEqual(["note-a", "blk_aaaaaaaaaa", "child", "a0", 123])
  })

  it("upserts with per-row LWW: stale rows cannot clobber newer ones", () => {
    const statements = planReplicaPut({ nodes: [node], links: [link] })
    expect(statements[0].sql).toContain("WHERE excluded.updated_at >= nodes.updated_at")
    expect(statements[1].sql).toContain("WHERE excluded.updated_at >= link.updated_at")
  })

  it("node deletes clean their link rows explicitly", () => {
    const statements = planReplicaPut({ nodes: [], links: [], deleteNodes: ["gone"] })
    expect(statements.map((s) => s.sql)).toEqual([
      "DELETE FROM link WHERE source_id = ?1 OR destination_id = ?1",
      "DELETE FROM nodes WHERE id = ?1",
    ])
    for (const s of statements) expect(s.params).toEqual(["gone"])
  })

  it("updates the replica cursor only when provided", () => {
    expect(planReplicaPut({ nodes: [], links: [] })).toEqual([])
    const statements = planReplicaPut({ nodes: [], links: [], cursor: "sha-1234" })
    expect(statements).toEqual([
      { sql: "UPDATE meta SET value = ?1 WHERE key = 'replica_cursor'", params: ["sha-1234"] },
    ])
  })
})

/**
 * The planned SQL, executed for real: `node:sqlite` runs the exact statements
 * D1 would, so the per-row last-writer-wins semantics are pinned by an engine,
 * not by string inspection. The module is loaded via `getBuiltinModule` with a
 * hand-typed minimal surface because `check:worker` compiles this file against
 * workers-types (no node types).
 */
interface SqliteStatement {
  run(...params: (string | number | null)[]): unknown
  all(...params: (string | number | null)[]): Record<string, unknown>[]
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
}
const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
const sqlite = proc?.getBuiltinModule?.("node:sqlite") as
  { DatabaseSync: new (path: string) => SqliteDatabase } | undefined

describe("planReplicaPut against a real SQLite engine (per-row LWW)", () => {
  // The two replicated tables, mirroring migrations/0002_nodes.sql (the LWW
  // rule under test lives in planReplicaPut's upserts, not in this DDL).
  const DDL = `
CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT NOT NULL, text TEXT NOT NULL,
  props TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE link (source_id TEXT NOT NULL, destination_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'child', sort_key TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, destination_id, kind));
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

  const openDb = (): SqliteDatabase => {
    if (!sqlite) throw new Error("node:sqlite is unavailable — tests require Node >= 22.5")
    const db = new sqlite.DatabaseSync(":memory:")
    db.exec(DDL)
    return db
  }
  const push = (db: SqliteDatabase, payload: Parameters<typeof planReplicaPut>[0]) => {
    for (const statement of planReplicaPut(payload)) {
      db.prepare(statement.sql).run(...statement.params)
    }
  }
  const nodeText = (db: SqliteDatabase, id: string) =>
    db.prepare("SELECT text, updated_at FROM nodes WHERE id = ?1").all(id)[0]
  const at = (row: NodeRow, updated_at: number, text: string): NodeRow => ({
    ...row,
    updated_at,
    text,
  })

  it("an updated_at tie goes to the later push, in either arrival order", () => {
    const first = openDb()
    push(first, { nodes: [at(node, 100, "from-a")], links: [] })
    push(first, { nodes: [at(node, 100, "from-b")], links: [] })
    expect(nodeText(first, node.id)).toEqual({ text: "from-b", updated_at: 100 })

    const reversed = openDb()
    push(reversed, { nodes: [at(node, 100, "from-b")], links: [] })
    push(reversed, { nodes: [at(node, 100, "from-a")], links: [] })
    expect(nodeText(reversed, node.id)).toEqual({ text: "from-a", updated_at: 100 })
  })

  it("a stale push is rejected per row, not per batch", () => {
    const db = openDb()
    // Device A's state: one row newer than B's push, one older.
    push(db, {
      nodes: [at(node, 300, "newer"), { ...node, id: "blk_bbbbbbbbbb", updated_at: 100 }],
      links: [{ ...link, updated_at: 300, sort_key: "a5" }],
    })
    // Device B pushes one batch, all rows stamped 200: only the rows that are
    // actually newer than the replica's land.
    push(db, {
      nodes: [
        at(node, 200, "stale — must lose"),
        { ...node, id: "blk_bbbbbbbbbb", text: "fresh — must win", updated_at: 200 },
      ],
      links: [{ ...link, updated_at: 200, sort_key: "a0" }],
    })

    expect(nodeText(db, node.id)).toEqual({ text: "newer", updated_at: 300 })
    expect(nodeText(db, "blk_bbbbbbbbbb")).toEqual({ text: "fresh — must win", updated_at: 200 })
    expect(db.prepare("SELECT sort_key, updated_at FROM link").all()).toEqual([
      { sort_key: "a5", updated_at: 300 },
    ])
  })

  it("replaying the same push is idempotent (rows and deletes)", () => {
    const db = openDb()
    const payload = {
      nodes: [at(node, 100, "hello")],
      links: [link],
      deleteNodes: ["blk_gone000000"],
      cursor: "c1",
    }
    push(db, payload)
    push(db, payload)
    expect(db.prepare("SELECT COUNT(*) AS n FROM nodes").all()).toEqual([{ n: 1 }])
    expect(db.prepare("SELECT COUNT(*) AS n FROM link").all()).toEqual([{ n: 1 }])
    expect(nodeText(db, node.id)).toEqual({ text: "hello", updated_at: 100 })
  })

  it("a node delete removes the node's link rows in the same plan", () => {
    const db = openDb()
    push(db, { nodes: [{ ...node, id: "note-a", type: "page" }, node], links: [link] })
    push(db, { nodes: [], links: [], deleteNodes: [node.id] })
    expect(db.prepare("SELECT COUNT(*) AS n FROM nodes").all()).toEqual([{ n: 1 }])
    expect(db.prepare("SELECT COUNT(*) AS n FROM link").all()).toEqual([{ n: 0 }])
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

/** A corpus on the real test engine, built by the real migration ladder —
 * exactly what the `UserCorpus` DO holds, minus the platform. */
async function openCorpus(): Promise<SqlDriver> {
  const driver = createTestSqlDriver()
  await ensureCorpusSchema(driver, { init: migration0001, nodes: migration0002 })
  return driver
}

describe("corpus pulls over a real engine (the DO's read path)", () => {
  const nodes: NodeRow[] = [
    { id: "note-a", type: "page", text: "note-a", props: null, updated_at: 100 },
    { id: "blk_a000000000", type: "text", text: "A", props: null, updated_at: 300 },
  ]
  const links: LinkRow[] = [
    {
      source_id: "note-a",
      destination_id: "blk_a000000000",
      kind: "child",
      sort_key: "a0",
      updated_at: 100,
    },
  ]

  it("full pull returns every row of both tables plus the cursor", async () => {
    const driver = await openCorpus()
    await corpusPut(driver, { nodes, links, cursor: "42" })
    expect(await corpusPullFull(driver)).toEqual({ nodes, links, cursor: "42" })
  })

  it("since pull returns only newer rows, plus ALL keys for deletion detection", async () => {
    const driver = await openCorpus()
    await corpusPut(driver, { nodes, links, cursor: "301" })
    const body = await corpusPullSince(driver, 200)
    expect(body.nodes).toEqual([nodes[1]])
    expect(body.links).toEqual([])
    // Unchanged rows still appear in the key lists — a client deletes local
    // rows absent from these. (The lists are sets; order is not part of the
    // contract.)
    expect([...body.nodeIds].sort()).toEqual(["blk_a000000000", "note-a"])
    expect(body.linkKeys).toEqual([["note-a", "blk_a000000000", "child"]])
    expect(body.cursor).toBe("301")
  })

  it("since equal to the newest updated_at returns no changes (strict >)", async () => {
    const driver = await openCorpus()
    await corpusPut(driver, { nodes, links })
    const body = await corpusPullSince(driver, 300)
    expect(body.nodes).toEqual([])
    expect(body.links).toEqual([])
    expect(body.nodeIds).toHaveLength(2)
  })

  it("a fresh corpus pulls empty with the seeded empty-string cursor", async () => {
    // 0001 seeds replica_cursor as '' — the D1 replica has always answered ''
    // until the first cursor-carrying push, so the DO must too.
    const driver = await openCorpus()
    expect(await corpusPullFull(driver)).toEqual({ nodes: [], links: [], cursor: "" })
  })

  it("status reports counts, schema version, and cursor", async () => {
    const driver = await openCorpus()
    await corpusPut(driver, { nodes, links, cursor: "7" })
    expect(await corpusStatus(driver)).toEqual({
      counts: { nodes: 2, links: 1, pages: 1 },
      schema_version: "2",
      replica_cursor: "7",
    })
  })
})

/**
 * A fake CORPUS namespace: real corpora (test engine + real migrations + the
 * real `replica-corpus.ts` operations) behind stubs, with every `getByName`
 * address recorded — the observable half of the tenant-addressing invariant.
 */
function fakeCorpusNamespace() {
  const corpora = new Map<string, Promise<SqlDriver>>()
  const addressed: string[] = []
  const driverFor = (name: string): Promise<SqlDriver> => {
    let driver = corpora.get(name)
    if (!driver) {
      driver = openCorpus()
      corpora.set(name, driver)
    }
    return driver
  }
  const namespace = {
    getByName: (name: string) => {
      addressed.push(name)
      return {
        pullFull: async () => corpusPullFull(await driverFor(name)),
        pullSince: async (since: number) => corpusPullSince(await driverFor(name), since),
        put: async (payload: Parameters<typeof corpusPut>[1]) =>
          corpusPut(await driverFor(name), payload),
        status: async () => corpusStatus(await driverFor(name)),
      }
    },
  }
  return { namespace: namespace as unknown as Env["CORPUS"], corpora, addressed }
}

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

async function testEnv(
  overrides: Partial<Env> = {},
): Promise<{ env: Env } & ReturnType<typeof fakeCorpusNamespace>> {
  const control = createTestSqlDriver()
  await control.execScript(migration0003)
  const corpus = fakeCorpusNamespace()
  const env = {
    DB: asFakeD1(control),
    CORPUS: corpus.namespace,
    SIGNUP_MODE: "open",
    ALLOWED_GITHUB_ID: undefined,
    ...overrides,
  } as unknown as Env
  return { env, ...corpus }
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

describe("tenant routing — the addressing invariant", () => {
  const github = githubStub({
    "alice-token": { id: 111, login: "alice" },
    "bob-token": { id: 222, login: "bob" },
  })
  const aliceRows = {
    nodes: [{ id: "note-a", type: "page", text: "note-a", props: null, updated_at: 100 }],
    links: [],
  }

  it("a push lands in the VERIFIED identity's corpus, whatever tenant the request claims", async () => {
    const { env, addressed, corpora } = await testEnv()
    // The request claims tenant 222 everywhere a client could put it: query
    // params, headers, and body fields. None of it may reach the address.
    const response = await replica(
      new Request("https://example.com/api/replica/notes?github_id=222&tenant=222&user=222", {
        method: "PUT",
        headers: { ...authHeaders("alice-token"), "X-GitHub-Id": "222", "X-Tenant": "222" },
        body: JSON.stringify({ ...aliceRows, tenant: 222, github_id: 222, cursor: "c1" }),
      }),
      env,
      github,
    )
    expect(response.status).toBe(200)
    expect(addressed).toEqual(["111"]) // the verified id — and nothing else
    expect([...corpora.keys()]).toEqual(["111"]) // tenant 222 was never even created
    const stored = await corpusPullFull(await corpora.get("111")!)
    expect(stored.nodes).toEqual(aliceRows.nodes)
  })

  it("another verified identity gets its own (empty) corpus, never the first one's rows", async () => {
    const { env, corpora } = await testEnv()
    await replica(
      new Request("https://example.com/api/replica/notes", {
        method: "PUT",
        headers: authHeaders("alice-token"),
        body: JSON.stringify(aliceRows),
      }),
      env,
      github,
    )
    const bobPull = await replica(
      new Request("https://example.com/api/replica/notes", { headers: authHeaders("bob-token") }),
      env,
      github,
    )
    expect(bobPull.status).toBe(200)
    expect((await bobPull.json()) as ReplicaCorpusBody).toEqual({
      nodes: [],
      links: [],
      cursor: "",
    })
    // Bob's since-pull key lists are HIS corpus's, so deletion-by-absence can
    // never be poisoned by (or leak) another tenant's keys.
    const bobSince = await replica(
      new Request("https://example.com/api/replica/notes?since=0", {
        headers: authHeaders("bob-token"),
      }),
      env,
      github,
    )
    expect(((await bobSince.json()) as ReplicaChangesBody).nodeIds).toEqual([])
    // And Alice's corpus still holds her rows.
    const aliceCorpus = await corpusPullFull(await corpora.get("111")!)
    expect(aliceCorpus.nodes).toEqual(aliceRows.nodes)
  })

  it("rejects with 401 before any corpus is addressed", async () => {
    const { env, addressed } = await testEnv()
    const response = await replica(
      new Request("https://example.com/api/replica/notes"),
      env,
      github,
    )
    expect(response.status).toBe(401)
    expect(addressed).toEqual([])
  })

  it("a control-plane rejection (blocked user) also stops before addressing", async () => {
    const { env, addressed } = await testEnv()
    const db = env.DB
    await db
      .prepare(
        "INSERT INTO users (github_id, login, status, created_at) VALUES (?1, 'b', 'blocked', 1)",
      )
      .bind(222)
      .run()
    const response = await replica(
      new Request("https://example.com/api/replica/status", { headers: authHeaders("bob-token") }),
      env,
      github,
    )
    expect(response.status).toBe(403)
    expect(addressed).toEqual([])
  })

  it("rejects a malformed since cursor with 400", async () => {
    const { env } = await testEnv()
    const response = await replica(
      new Request("https://example.com/api/replica/notes?since=abc", {
        headers: authHeaders("alice-token"),
      }),
      env,
      github,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_since" })
  })

  it("rejects an invalid payload with 400 before writing", async () => {
    const { env, corpora } = await testEnv()
    const response = await replica(
      new Request("https://example.com/api/replica/notes", {
        method: "PUT",
        headers: authHeaders("alice-token"),
        body: JSON.stringify({ nodes: [{ nope: true }], links: [] }),
      }),
      env,
      github,
    )
    expect(response.status).toBe(400)
    // No corpus method ever ran — the (lazily created) corpus doesn't exist.
    expect(corpora.size).toBe(0)
  })
})
