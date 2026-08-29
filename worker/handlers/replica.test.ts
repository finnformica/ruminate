import { describe, expect, it, vi } from "vitest"
import {
  buildPullNotes,
  parseReplicaPayload,
  parseSinceCursor,
  planReplicaPut,
  type NoteRow,
  type ReplicaPutPayload,
  type ViewStateRow,
} from "./replica-payload"
import { replica, replicaPull, requireSession } from "./replica"
import type { Env } from "../types"

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

describe("buildPullNotes", () => {
  const noteRows: NoteRow[] = [
    { id: "note-a", content: "- Hi\n", updated_at: 123 },
    { id: "note-b", content: "- Yo\n", updated_at: null },
  ]

  it("joins view state onto note rows, defaulting to empty", () => {
    const viewRows: ViewStateRow[] = [{ note_id: "note-a", collapsed: '["blk_a","blk_b"]' }]
    expect(buildPullNotes(noteRows, viewRows)).toEqual([
      { note: noteRows[0], view_state: ["blk_a", "blk_b"] },
      { note: noteRows[1], view_state: [] },
    ])
  })

  it("degrades malformed collapsed JSON to an empty set", () => {
    const viewRows: ViewStateRow[] = [
      { note_id: "note-a", collapsed: "not json" },
      { note_id: "note-b", collapsed: '{"nope":1}' },
    ]
    expect(buildPullNotes(noteRows, viewRows).map((entry) => entry.view_state)).toEqual([[], []])
  })
})

/**
 * Minimal fake D1 for `replicaPull`: dispatches on the handful of fixed SQL
 * strings the handler issues. Anything unexpected throws, so a new query
 * cannot silently return empty results in tests.
 */
function fakePullDb(data: {
  notes: NoteRow[]
  viewState?: ViewStateRow[]
  cursor?: string | null
}): D1Database {
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
        if (sql.includes("FROM view_state")) return { results: data.viewState ?? [] }
        if (sql.includes("updated_at > ?1")) {
          const since = Number(bound[0])
          return {
            results: data.notes.filter(
              (note) => note.updated_at !== null && note.updated_at > since,
            ),
          }
        }
        if (sql.startsWith("SELECT id, content, updated_at FROM notes")) {
          return { results: data.notes }
        }
        if (sql === "SELECT id FROM notes") {
          return { results: data.notes.map((note) => ({ id: note.id })) }
        }
        throw new Error(`Unexpected all(): ${sql}`)
      },
    }
    return statement
  }
  return { prepare } as unknown as D1Database
}

describe("replicaPull", () => {
  const notes: NoteRow[] = [
    { id: "note-a", content: "- A\n", updated_at: 100 },
    { id: "note-b", content: "- B\n", updated_at: 300 },
    { id: "note-c", content: "- C\n", updated_at: null },
  ]
  const viewState: ViewStateRow[] = [{ note_id: "note-b", collapsed: '["blk_x"]' }]
  const pull = (path: string, db: D1Database) =>
    replicaPull(new Request(`https://example.com${path}`), db)

  it("returns the full corpus (note rows + view state + cursor) without ?since", async () => {
    const response = await pull(
      "/api/replica/notes",
      fakePullDb({ notes, viewState, cursor: "42" }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      notes: [
        { note: notes[0], view_state: [] },
        { note: notes[1], view_state: ["blk_x"] },
        { note: notes[2], view_state: [] },
      ],
      cursor: "42",
    })
  })

  it("returns only newer-than-since notes, plus ALL ids for deletion detection", async () => {
    const response = await pull(
      "/api/replica/notes?since=200",
      fakePullDb({ notes, viewState, cursor: "301" }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      changed: [{ note: notes[1], view_state: ["blk_x"] }],
      // note-a (older) and note-c (null updated_at) still appear here — a
      // client deletes local notes absent from this list.
      ids: ["note-a", "note-b", "note-c"],
      cursor: "301",
    })
  })

  it("since equal to the newest updated_at returns no changes (strict >)", async () => {
    const response = await pull("/api/replica/notes?since=300", fakePullDb({ notes }))
    const body = (await response.json()) as { changed: unknown[]; ids: string[] }
    expect(body.changed).toEqual([])
    expect(body.ids).toHaveLength(3)
  })

  it("rejects a malformed since cursor with 400", async () => {
    const response = await pull("/api/replica/notes?since=abc", fakePullDb({ notes }))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_since" })
  })

  it("null cursor (never pushed) comes back as null", async () => {
    const response = await pull("/api/replica/notes", fakePullDb({ notes: [] }))
    expect(await response.json()).toEqual({ notes: [], cursor: null })
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
