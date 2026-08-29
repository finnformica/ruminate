import { describe, expect, it, vi } from "vitest"
import {
  parseReplicaPayload,
  planReplicaPut,
  requireSession,
  type ReplicaPutPayload,
} from "./replica"

const entry = {
  note: { id: "note-a", content: "- Hi [[note-b]]\n  id:: blk_aaaaaaaaaa\n", updated_at: 123 },
  blocks: [
    { id: "blk_aaaaaaaaaa", note_id: "note-a", parent_id: null, position: 0, content: "- Hi" },
  ],
  links: [{ from_block: "blk_aaaaaaaaaa", to_note: "note-b", to_block: null, kind: "wikilink" }],
  view_state: ["blk_aaaaaaaaaa"],
}

describe("parseReplicaPayload", () => {
  it("accepts a well-formed payload", () => {
    const payload = parseReplicaPayload({ notes: [entry], deletes: ["old"], cursor: "abc123" })
    expect(payload).toEqual({ notes: [entry], deletes: ["old"], cursor: "abc123" })
  })

  it("accepts an empty batch and omitted optionals", () => {
    expect(parseReplicaPayload({ notes: [] })).toEqual({
      notes: [],
      deletes: undefined,
      cursor: undefined,
    })
  })

  it("rejects non-objects and missing notes", () => {
    expect(parseReplicaPayload(null)).toBeNull()
    expect(parseReplicaPayload("hi")).toBeNull()
    expect(parseReplicaPayload({})).toBeNull()
  })

  it("rejects a block row belonging to a different note", () => {
    const bad = {
      ...entry,
      blocks: [{ ...entry.blocks[0], note_id: "other" }],
    }
    expect(parseReplicaPayload({ notes: [bad] })).toBeNull()
  })

  it("rejects an unknown link kind", () => {
    const bad = { ...entry, links: [{ ...entry.links[0], kind: "hyperlink" }] }
    expect(parseReplicaPayload({ notes: [bad] })).toBeNull()
  })

  it("rejects malformed view_state, deletes, and cursor", () => {
    expect(parseReplicaPayload({ notes: [{ ...entry, view_state: "blk_a" }] })).toBeNull()
    expect(parseReplicaPayload({ notes: [], deletes: [1] })).toBeNull()
    expect(parseReplicaPayload({ notes: [], cursor: 7 })).toBeNull()
  })

  it("strips unknown properties from rows", () => {
    const payload = parseReplicaPayload({
      notes: [{ ...entry, note: { ...entry.note, sneaky: "x" } }],
    })
    expect(payload?.notes[0].note).toEqual(entry.note)
  })
})

describe("planReplicaPut", () => {
  it("plans a per-note replace: upsert note, drop old graph, insert rows", () => {
    const statements = planReplicaPut({ notes: [entry as ReplicaPutPayload["notes"][0]] })
    expect(statements.map((s) => s.sql.split(" ").slice(0, 4).join(" "))).toEqual([
      "INSERT INTO notes (id,",
      "DELETE FROM links WHERE",
      "DELETE FROM blocks WHERE",
      "INSERT INTO blocks (id,",
      "INSERT OR IGNORE INTO",
      "INSERT INTO view_state (note_id,",
    ])
    expect(statements[0].params).toEqual(["note-a", entry.note.content, 123])
    expect(statements[3].params).toEqual(["blk_aaaaaaaaaa", "note-a", null, 0, "- Hi"])
    expect(statements[4].params).toEqual(["blk_aaaaaaaaaa", "note-b", null, "wikilink"])
  })

  it("stores view state canonically (sorted, de-duplicated JSON)", () => {
    const statements = planReplicaPut({
      notes: [
        {
          ...(entry as ReplicaPutPayload["notes"][0]),
          view_state: ["blk_b", "blk_a", "blk_b"],
        },
      ],
    })
    const viewState = statements.find((s) => s.sql.startsWith("INSERT INTO view_state"))
    expect(viewState?.params).toEqual(["note-a", '["blk_a","blk_b"]'])
  })

  it("clears the view-state row when nothing is collapsed", () => {
    const statements = planReplicaPut({
      notes: [{ ...(entry as ReplicaPutPayload["notes"][0]), view_state: [] }],
    })
    expect(statements.at(-1)?.sql).toBe("DELETE FROM view_state WHERE note_id = ?1")
  })

  it("plans deletes across all four tables", () => {
    const statements = planReplicaPut({ notes: [], deletes: ["gone"] })
    expect(statements.map((s) => s.sql.split(" ")[2])).toEqual([
      "links",
      "blocks",
      "notes",
      "view_state",
    ])
    for (const s of statements) expect(s.params).toEqual(["gone"])
  })

  it("updates the replica cursor only when provided", () => {
    expect(planReplicaPut({ notes: [] })).toEqual([])
    const statements = planReplicaPut({ notes: [], cursor: "sha-1234" })
    expect(statements).toEqual([
      { sql: "UPDATE meta SET value = ?1 WHERE key = 'replica_cursor'", params: ["sha-1234"] },
    ])
  })
})

describe("requireSession", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://example.com/api/replica/status", { headers })

  it("rejects a request without the session cookie", async () => {
    const response = await requireSession(request({ Authorization: "Bearer tok" }))
    expect(response?.status).toBe(401)
  })

  it("rejects a request without a bearer token", async () => {
    const response = await requireSession(request({ Cookie: "gh_refresh=abc" }))
    expect(response?.status).toBe(401)
  })

  it("rejects a token GitHub does not accept", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }))
    const response = await requireSession(
      request({ Cookie: "gh_refresh=abc", Authorization: "Bearer bad" }),
      fetchImpl as unknown as typeof fetch,
    )
    expect(response?.status).toBe(401)
  })

  it("passes a request with a session cookie and a GitHub-validated token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }))
    const response = await requireSession(
      request({ Cookie: "gh_refresh=abc", Authorization: "Bearer good" }),
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
