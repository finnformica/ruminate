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
