import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseReplicaPayload } from "../../worker/handlers/replica-payload"
import {
  buildReplicaNoteEntry,
  isReplicaDrasticallyBehind,
  startReplicaSync,
  type ReplicaSyncHandle,
} from "./replica-sync"
import { storageDiagnosticsAtom } from "./storage-mirror"

/**
 * Unit tests for the D1 replication queue. The fake Worker below remembers
 * which note ids have been pushed so `/api/replica/status` returns live-ish
 * counts; every PUT body is validated with the real `parseReplicaPayload`
 * from the Worker — the payloads the client builds must be the payloads the
 * Worker accepts.
 */

interface RecordedRequest {
  url: string
  method: string
  authorization: string | null
  body: ReturnType<typeof parseReplicaPayload> | null
}

function createTestServer() {
  const requests: RecordedRequest[] = []
  const remoteNotes = new Set<string>()
  let remoteCursor: string | null = null
  /** Next PUT responses to force (status codes); empty → succeed. */
  const failNext: (number | "network")[] = []

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const headers = (init?.headers ?? {}) as Record<string, string>
    const record: RecordedRequest = {
      url,
      method,
      authorization: headers["Authorization"] ?? null,
      body: null,
    }

    if (url === "/api/replica/notes" && method === "PUT") {
      const failure = failNext.shift()
      if (failure === "network") {
        requests.push(record)
        throw new TypeError("Failed to fetch")
      }
      const payload = parseReplicaPayload(JSON.parse(String(init?.body)))
      record.body = payload
      requests.push(record)
      if (failure !== undefined) return new Response("{}", { status: failure })
      if (!payload) return new Response("{}", { status: 400 })
      for (const entry of payload.notes) remoteNotes.add(entry.note.id)
      for (const id of payload.deletes ?? []) remoteNotes.delete(id)
      if (payload.cursor !== undefined) remoteCursor = payload.cursor
      return new Response(JSON.stringify({ ok: true, notes: payload.notes.length }), {
        status: 200,
      })
    }

    if (url === "/api/replica/status" && method === "GET") {
      requests.push(record)
      return new Response(
        JSON.stringify({
          counts: { notes: remoteNotes.size, blocks: 0, links: 0, view_state: 0 },
          schema_version: "1",
          replica_cursor: remoteCursor,
        }),
        { status: 200 },
      )
    }

    throw new Error(`Unexpected request: ${method} ${url}`)
  }) as typeof fetch

  return {
    fetchImpl,
    requests,
    remoteNotes,
    failNext,
    puts: () => requests.filter((r) => r.url === "/api/replica/notes"),
    statuses: () => requests.filter((r) => r.url === "/api/replica/status"),
  }
}

function createTestAuth() {
  const auth = {
    token: "tok-1" as string | undefined,
    refreshes: 0,
    async ensureFreshToken() {},
    getAccessToken() {
      return auth.token
    },
    async withAuthRetry<T>(operation: () => Promise<T>): Promise<T> {
      try {
        return await operation()
      } catch (error) {
        if ((error as { status?: number }).status !== 401) throw error
        auth.refreshes += 1
        auth.token = `tok-${auth.refreshes + 1}`
        return await operation()
      }
    },
  }
  return auth
}

const DEBOUNCE = 2_000

function createTestSync(
  initialFiles: Record<string, string>,
  overrides: Partial<Parameters<typeof startReplicaSync>[0]> = {},
) {
  const server = createTestServer()
  const auth = createTestAuth()
  let files = { ...initialFiles }
  let leader = true
  const handle = startReplicaSync({
    getFiles: () => ({ ...files }),
    fetchImpl: server.fetchImpl,
    isLeader: () => leader,
    auth,
    ...overrides,
  })
  handles.push(handle)
  return {
    handle,
    server,
    auth,
    setFiles: (next: Record<string, string>) => {
      files = { ...next }
    },
    setLeader: (next: boolean) => {
      leader = next
    },
  }
}

const replicaDiagnostics = () => getDefaultStore().get(storageDiagnosticsAtom).replica!

/** Fire due timers, then settle the sync's promise queue. */
async function advance(handle: ReplicaSyncHandle, ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  await handle.flush()
}

let handles: ReplicaSyncHandle[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(async () => {
  for (const handle of handles) handle.stop()
  handles = []
  vi.useRealTimers()
  const store = getDefaultStore()
  store.set(storageDiagnosticsAtom, { ...store.get(storageDiagnosticsAtom), replica: null })
})

describe("replica sync queue", () => {
  it("coalesces rapid changes into one debounced push and confirms via status", async () => {
    const { handle, server } = createTestSync({ "a.md": "A\n", "b.md": "B\n" })
    handle.notifyNotesChanged(["a"])
    handle.notifyNotesChanged(["b"])
    handle.notifyNotesChanged(["a"]) // dirty again — still one push
    expect(replicaDiagnostics().pendingNotes).toBe(2)

    await advance(handle, DEBOUNCE)

    expect(server.puts()).toHaveLength(1)
    expect(server.statuses()).toHaveLength(1)
    expect(server.puts()[0].body?.notes.map((n) => n.note.id)).toEqual(["a", "b"])
    expect([...server.remoteNotes]).toEqual(["a", "b"])
    const diag = replicaDiagnostics()
    expect(diag.pendingNotes).toBe(0)
    expect(diag.lastPushAt).not.toBeNull()
    expect(diag.lastPushNotes).toBe(2)
    expect(diag.cursorConfirmed).toBe(true)
    expect(diag.remote?.notes).toBe(2)
  })

  it("builds payloads the worker's parseReplicaPayload accepts, rows from docToRows", async () => {
    const files = {
      "a.md":
        "---\nupdated_at: 2026-08-29T00:00:00.000Z\n---\n\n- Hi [[b]] #tag\n  id:: blk_aaaaaaaaaa\n",
      ".ruminate/view-state/a.json": '["blk_aaaaaaaaaa"]',
    }
    const { handle, server } = createTestSync(files)
    handle.notifyNotesChanged(["a"])
    await advance(handle, DEBOUNCE)

    // The fake server already ran the real parseReplicaPayload; a null body
    // would have been rejected with a 400 above.
    const entry = server.puts()[0].body!.notes[0]
    expect(entry).toEqual(buildReplicaNoteEntry(files, "a"))
    expect(entry.note.updated_at).toBe(Date.parse("2026-08-29T00:00:00.000Z"))
    expect(entry.view_state).toEqual(["blk_aaaaaaaaaa"])
    expect(entry.blocks.map((b) => b.id)).toEqual(["blk_aaaaaaaaaa"])
    expect(entry.links.map((l) => `${l.kind}:${l.to_note}`).sort()).toEqual([
      "tag:tag",
      "wikilink:b",
    ])
  })

  it("chunks large pushes, cursor on the final chunk and deletes on the first", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`note-${i}.md`, `Note ${i}\n`]),
    )
    const { handle, server } = createTestSync(files, { chunkSize: 2 })
    handle.notifyNotesDeleted(["gone"])
    handle.requestFullPush()
    await advance(handle, DEBOUNCE)

    const puts = server.puts()
    expect(puts.map((p) => p.body?.notes.length)).toEqual([2, 2, 1])
    expect(puts.map((p) => p.body?.deletes)).toEqual([["gone"], undefined, undefined])
    expect(puts.map((p) => p.body?.cursor !== undefined)).toEqual([false, false, true])
    expect(server.remoteNotes.size).toBe(5)
    expect(replicaDiagnostics().cursorConfirmed).toBe(true)
  })

  it("treats a dirty note deleted before the push as a delete", async () => {
    const { handle, server, setFiles } = createTestSync({ "a.md": "A\n", "b.md": "B\n" })
    handle.notifyNotesChanged(["a", "b"])
    setFiles({ "a.md": "A\n" }) // b deleted between save and push
    await advance(handle, DEBOUNCE)

    const put = server.puts()[0]
    expect(put.body?.notes.map((n) => n.note.id)).toEqual(["a"])
    expect(put.body?.deletes).toEqual(["b"])
  })

  it("refreshes the session and retries once on a 401", async () => {
    const { handle, server, auth } = createTestSync({ "a.md": "A\n" })
    server.failNext.push(401)
    handle.notifyNotesChanged(["a"])
    await advance(handle, DEBOUNCE)

    expect(auth.refreshes).toBe(1)
    const puts = server.puts()
    expect(puts).toHaveLength(2)
    expect(puts[0].authorization).toBe("Bearer tok-1")
    expect(puts[1].authorization).toBe("Bearer tok-2")
    expect(replicaDiagnostics().errorCount).toBe(0)
    expect(server.remoteNotes.has("a")).toBe(true)
  })

  it("only the leader tab pushes; a promoted follower pushes its backlog", async () => {
    const { handle, server, setLeader } = createTestSync({ "a.md": "A\n" })
    setLeader(false)
    handle.notifyNotesChanged(["a"])
    await advance(handle, DEBOUNCE)

    expect(server.requests).toHaveLength(0)
    expect(replicaDiagnostics()).toMatchObject({ leader: false, pendingNotes: 1 })

    setLeader(true)
    await advance(handle, 30_000) // follower re-check interval
    expect(server.puts()).toHaveLength(1)
    expect(replicaDiagnostics()).toMatchObject({ leader: true, pendingNotes: 0 })
  })

  it("keeps failed pushes pending and retries with exponential backoff", async () => {
    const { handle, server } = createTestSync(
      { "a.md": "A\n" },
      { backoffStartMs: 1_000, backoffMaxMs: 4_000 },
    )
    server.failNext.push("network", 500, "network", "network", "network")
    handle.notifyNotesChanged(["a"])

    await advance(handle, DEBOUNCE)
    expect(server.puts()).toHaveLength(1)
    expect(replicaDiagnostics().pendingNotes).toBe(1) // restored after failure
    expect(replicaDiagnostics().lastError?.message).toMatch(/Failed to fetch/)

    await advance(handle, 999)
    expect(server.puts()).toHaveLength(1) // backoff not elapsed
    await advance(handle, 1)
    expect(server.puts()).toHaveLength(2) // retry at 1s
    expect(replicaDiagnostics().lastError?.message).toMatch(/500/)
    await advance(handle, 2_000)
    expect(server.puts()).toHaveLength(3) // 2s
    await advance(handle, 4_000)
    expect(server.puts()).toHaveLength(4) // 4s (capped)
    await advance(handle, 4_000)
    expect(server.puts()).toHaveLength(5) // still 4s — cap holds

    await advance(handle, 4_000)
    expect(server.remoteNotes.has("a")).toBe(true) // eventually lands
    expect(replicaDiagnostics().pendingNotes).toBe(0)
    expect(replicaDiagnostics().lastError).toBeNull()
    expect(replicaDiagnostics().errorCount).toBe(5)
  })

  it("auto-requests a full push when status shows the replica drastically behind", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`note-${i}.md`, `Note ${i}\n`]),
    )
    const { handle, server } = createTestSync(files)

    handle.refreshRemoteStatus() // remote is empty → drastically behind
    await handle.flush()
    expect(replicaDiagnostics().fullPushPending).toBe(true)

    await advance(handle, DEBOUNCE)
    expect(server.remoteNotes.size).toBe(20)
    expect(replicaDiagnostics().fullPushPending).toBe(false)
  })

  it("does nothing after stop", async () => {
    const { handle, server } = createTestSync({ "a.md": "A\n" })
    handle.notifyNotesChanged(["a"])
    handle.stop()
    await advance(handle, DEBOUNCE)
    handle.notifyNotesChanged(["a"])
    await advance(handle, DEBOUNCE)
    expect(server.requests).toHaveLength(0)
  })
})

describe("isReplicaDrasticallyBehind", () => {
  it("flags an empty or badly lagging replica, tolerates write-behind lag", () => {
    expect(isReplicaDrasticallyBehind(0, 0)).toBe(false)
    expect(isReplicaDrasticallyBehind(1, 0)).toBe(true)
    expect(isReplicaDrasticallyBehind(20, 0)).toBe(true)
    expect(isReplicaDrasticallyBehind(20, 17)).toBe(false) // small lag is normal
    expect(isReplicaDrasticallyBehind(20, 16)).toBe(true)
    expect(isReplicaDrasticallyBehind(1000, 900)).toBe(false)
    expect(isReplicaDrasticallyBehind(1000, 899)).toBe(true)
    expect(isReplicaDrasticallyBehind(10, 15)).toBe(false) // ahead ≠ behind
  })
})
