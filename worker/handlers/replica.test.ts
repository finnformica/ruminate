import { describe, expect, it, vi } from "vitest"
import {
  parseReplicaPayload,
  parseSinceCursor,
  planReplicaPut,
  type LinkRow,
  type NodeRow,
} from "./replica-payload"
import { replica, replicaPull, requireSession } from "./replica"
import type { Env } from "../types"

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
  | { DatabaseSync: new (path: string) => SqliteDatabase }
  | undefined

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

/**
 * Minimal fake D1 for `replicaPull`: dispatches on the handful of fixed SQL
 * strings the handler issues. Anything unexpected throws, so a new query
 * cannot silently return empty results in tests.
 */
function fakePullDb(data: {
  nodes: NodeRow[]
  links?: LinkRow[]
  cursor?: string | null
}): D1Database {
  const links = data.links ?? []
  const prepare = (sql: string) => {
    let bound: unknown[] = []
    const statement = {
      bind: (...params: unknown[]) => {
        bound = params
        return statement
      },
      first: async () => {
        if (sql.includes("FROM meta")) return { value: data.cursor ?? null }
        throw new Error(`Unexpected first(): ${sql}`)
      },
      all: async () => {
        if (sql.startsWith("SELECT id, type, text, props, updated_at FROM nodes")) {
          if (sql.includes("updated_at > ?1")) {
            const since = Number(bound[0])
            return { results: data.nodes.filter((row) => row.updated_at > since) }
          }
          return { results: data.nodes }
        }
        if (sql === "SELECT id FROM nodes") {
          return { results: data.nodes.map((row) => ({ id: row.id })) }
        }
        if (sql.startsWith("SELECT source_id, destination_id, kind, sort_key, updated_at")) {
          if (sql.includes("updated_at > ?1")) {
            const since = Number(bound[0])
            return { results: links.filter((row) => row.updated_at > since) }
          }
          return { results: links }
        }
        if (sql === "SELECT source_id, destination_id, kind FROM link") {
          return {
            results: links.map((row) => ({
              source_id: row.source_id,
              destination_id: row.destination_id,
              kind: row.kind,
            })),
          }
        }
        throw new Error(`Unexpected all(): ${sql}`)
      },
    }
    return statement
  }
  return { prepare } as unknown as D1Database
}

describe("replicaPull", () => {
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
  const pull = (path: string, db: D1Database) =>
    replicaPull(new Request(`https://example.com${path}`), db)

  it("returns every row of both tables (plus cursor) without ?since", async () => {
    const response = await pull("/api/replica/notes", fakePullDb({ nodes, links, cursor: "42" }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ nodes, links, cursor: "42" })
  })

  it("returns only newer-than-since rows, plus ALL keys for deletion detection", async () => {
    const response = await pull(
      "/api/replica/notes?since=200",
      fakePullDb({ nodes, links, cursor: "301" }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      nodes: [nodes[1]],
      links: [],
      // Unchanged rows still appear in the key lists — a client deletes local
      // rows absent from these.
      nodeIds: ["note-a", "blk_a000000000"],
      linkKeys: [["note-a", "blk_a000000000", "child"]],
      cursor: "301",
    })
  })

  it("since equal to the newest updated_at returns no changes (strict >)", async () => {
    const response = await pull("/api/replica/notes?since=300", fakePullDb({ nodes, links }))
    const body = (await response.json()) as {
      nodes: unknown[]
      links: unknown[]
      nodeIds: string[]
    }
    expect(body.nodes).toEqual([])
    expect(body.links).toEqual([])
    expect(body.nodeIds).toHaveLength(2)
  })

  it("rejects a malformed since cursor with 400", async () => {
    const response = await pull("/api/replica/notes?since=abc", fakePullDb({ nodes }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_since" })
  })

  it("null cursor (never pushed) comes back as null", async () => {
    const response = await pull("/api/replica/notes", fakePullDb({ nodes: [] }))
    expect(await response.json()).toEqual({ nodes: [], links: [], cursor: null })
  })

  it("is session-guarded through the router (401 before touching D1)", async () => {
    const response = await replica(
      new Request("https://example.com/api/replica/notes"),
      // DB deliberately absent: the guard must reject before any D1 access.
      { DB: undefined } as unknown as Env,
    )
    expect(response.status).toBe(401)
  })
})

describe("requireSession", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://example.com/api/replica/status", { headers })

  const OWNER = "42536816"

  it("rejects a request without the session cookie", async () => {
    const response = await requireSession(request({ Authorization: "Bearer tok" }), OWNER)
    expect(response?.status).toBe(401)
  })

  it("rejects a request without a bearer token", async () => {
    const response = await requireSession(request({ Cookie: "gh_refresh=abc" }), OWNER)
    expect(response?.status).toBe(401)
  })

  it("rejects a token GitHub does not accept", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }))
    const response = await requireSession(
      request({ Cookie: "gh_refresh=abc", Authorization: "Bearer bad" }),
      OWNER,
      fetchImpl as unknown as typeof fetch,
    )
    expect(response?.status).toBe(401)
  })

  it("rejects a VALID GitHub token belonging to someone else (403)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 999 }), { status: 200 }))
    const response = await requireSession(
      request({ Cookie: "gh_refresh=abc", Authorization: "Bearer other" }),
      OWNER,
      fetchImpl as unknown as typeof fetch,
    )
    expect(response?.status).toBe(403)
  })

  it("fails closed when no owner id is configured (403)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: 42536816 }), { status: 200 }),
    )
    const response = await requireSession(
      request({ Cookie: "gh_refresh=abc", Authorization: "Bearer good" }),
      undefined,
      fetchImpl as unknown as typeof fetch,
    )
    expect(response?.status).toBe(403)
  })

  it("passes the owner's session (cookie + owner-validated token)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: 42536816 }), { status: 200 }),
    )
    const response = await requireSession(
      request({ Cookie: "gh_refresh=abc", Authorization: "Bearer good" }),
      OWNER,
      fetchImpl as unknown as typeof fetch,
    )
    expect(response).toBeNull()
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: { Authorization: "Bearer good", "User-Agent": "ruminate" },
      }),
    )
  })
})
