// @vitest-environment jsdom
import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  emptyGraphDiff,
  parseReplicaPayload,
  type GraphDiff,
  type LinkRow,
  type NodeRow,
} from "../../worker/handlers/replica-payload"
import {
  isReplicaDrasticallyBehind,
  startReplicaSync,
  type ReplicaSyncHandle,
} from "./replica-sync"
import { storageDiagnosticsAtom } from "./storage-diagnostics"

/**
 * Unit tests for the D1 replication queue. The fake Worker below remembers
 * which rows have been pushed so `/api/replica/status` returns live-ish
 * counts; every PUT body is validated with the real `parseReplicaPayload`
 * from the Worker — the payloads the client builds must be the payloads the
 * Worker accepts.
 */

interface RecordedRequest {
  url: string
  method: string
  authorization: string | null
  keepalive: boolean
  body: ReturnType<typeof parseReplicaPayload> | null
}

const node = (id: string, text = id): NodeRow => ({
  id,
  type: id.startsWith("blk_") ? "text" : "page",
  text,
  props: null,
  updated_at: 1,
})

const link = (source: string, destination: string, sortKey = "a0"): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: "child",
  sort_key: sortKey,
  updated_at: 1,
})

const diffOf = (partial: Partial<GraphDiff>): GraphDiff => ({ ...emptyGraphDiff(), ...partial })

function createTestServer() {
  const requests: RecordedRequest[] = []
  const remoteNodes = new Map<string, NodeRow>()
  const remoteLinks = new Map<string, LinkRow>()
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
      keepalive: (init as { keepalive?: boolean } | undefined)?.keepalive === true,
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
      for (const row of payload.nodes) remoteNodes.set(row.id, row)
      for (const row of payload.links) {
        remoteLinks.set(`${row.source_id}|${row.destination_id}|${row.kind}`, row)
      }
      for (const id of payload.deleteNodes ?? []) remoteNodes.delete(id)
      for (const [s, d, k] of payload.deleteLinks ?? []) remoteLinks.delete(`${s}|${d}|${k}`)
      if (payload.cursor !== undefined) remoteCursor = payload.cursor
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    if (url === "/api/replica/status" && method === "GET") {
      requests.push(record)
      const pages = [...remoteNodes.values()].filter((row) => row.type === "page").length
      return new Response(
        JSON.stringify({
          counts: { nodes: remoteNodes.size, links: remoteLinks.size, pages },
          schema_version: "2",
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
    remoteNodes,
    remoteLinks,
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
  allRows: { nodes: NodeRow[]; links: LinkRow[] } = { nodes: [], links: [] },
  overrides: Partial<Parameters<typeof startReplicaSync>[0]> = {},
) {
  const server = createTestServer()
  const auth = createTestAuth()
  let files = { ...initialFiles }
  const handle = startReplicaSync({
    getFiles: () => ({ ...files }),
    getAllRows: async () => allRows,
    fetchImpl: server.fetchImpl,
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
  it("coalesces rapid diffs into one debounced push and confirms via status", async () => {
    const { handle, server } = createTestSync({ "a.md": "A\n", "b.md": "B\n" })
    handle.notifyGraphChange(["a"], diffOf({ nodes: [node("a"), node("blk_a1", "v1")] }))
    handle.notifyGraphChange(["b"], diffOf({ nodes: [node("b")] }))
    handle.notifyGraphChange(["a"], diffOf({ nodes: [node("blk_a1", "v2")] }))
    expect(replicaDiagnostics().pendingNotes).toBe(2)

    await advance(handle, DEBOUNCE)

    expect(server.puts()).toHaveLength(1)
    expect(server.statuses()).toHaveLength(1)
    // Coalesced by row key: the later blk_a1 wins; one row each otherwise.
    expect(server.puts()[0].body?.nodes.map((row) => `${row.id}:${row.text}`)).toEqual([
      "a:a",
      "blk_a1:v2",
      "b:b",
    ])
    const diag = replicaDiagnostics()
    expect(diag.pendingNotes).toBe(0)
    expect(diag.lastPushAt).not.toBeNull()
    expect(diag.lastPushNotes).toBe(2)
    expect(diag.cursorConfirmed).toBe(true)
    expect(diag.remote?.pages).toBe(2)
  })

  it("upserts cancel deletes (and vice versa) within the pending diff", async () => {
    const { handle, server } = createTestSync({ "a.md": "A\n" })
    handle.notifyGraphChange(
      ["a"],
      diffOf({ deleteNodes: ["blk_x"], deleteLinks: [["a", "blk_x", "child"]] }),
    )
    handle.notifyGraphChange(["a"], diffOf({ nodes: [node("blk_x")], links: [link("a", "blk_x")] }))
    await advance(handle, DEBOUNCE)

    const body = server.puts()[0].body!
    expect(body.nodes.map((row) => row.id)).toEqual(["blk_x"])
    expect(body.links).toHaveLength(1)
    expect(body.deleteNodes).toBeUndefined()
    expect(body.deleteLinks).toBeUndefined()
  })

  it("sends deletes on the first chunk and the cursor on the last", async () => {
    const rows = {
      nodes: Array.from({ length: 5 }, (_, i) => node(`note-${i}`)),
      links: [link("note-0", "note-1")], // shape only — content irrelevant
    }
    const { handle, server } = createTestSync({ "a.md": "A\n" }, rows, { chunkRows: 2 })
    handle.notifyGraphChange(["gone"], diffOf({ deleteNodes: ["gone"] }))
    handle.requestFullPush()
    await advance(handle, DEBOUNCE)

    const puts = server.puts()
    // 5 nodes + 1 link in chunks of 2 rows → 3 payloads, links after all nodes.
    expect(puts.map((p) => p.body?.nodes.length)).toEqual([2, 2, 1])
    expect(puts.map((p) => p.body?.links.length)).toEqual([0, 0, 1])
    expect(puts.map((p) => p.body?.deleteNodes)).toEqual([["gone"], undefined, undefined])
    expect(puts.map((p) => p.body?.cursor !== undefined)).toEqual([false, false, true])
    expect(server.remoteNodes.size).toBe(5)
  })

  it("refreshes the session and retries once on a 401", async () => {
    const { handle, server, auth } = createTestSync({ "a.md": "A\n" })
    server.failNext.push(401)
    handle.notifyGraphChange(["a"], diffOf({ nodes: [node("a")] }))
    await advance(handle, DEBOUNCE)

    expect(auth.refreshes).toBe(1)
    const puts = server.puts()
    expect(puts).toHaveLength(2)
    expect(puts[0].authorization).toBe("Bearer tok-1")
    expect(puts[1].authorization).toBe("Bearer tok-2")
    expect(replicaDiagnostics().errorCount).toBe(0)
    expect(server.remoteNodes.has("a")).toBe(true)
  })

  it("keeps failed pushes pending and retries with exponential backoff", async () => {
    const { handle, server } = createTestSync(
      { "a.md": "A\n" },
      { nodes: [], links: [] },
      { backoffStartMs: 1_000, backoffMaxMs: 4_000 },
    )
    server.failNext.push("network", 500, "network", "network", "network")
    handle.notifyGraphChange(["a"], diffOf({ nodes: [node("a")] }))

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
    expect(server.remoteNodes.has("a")).toBe(true) // eventually lands
    expect(replicaDiagnostics().pendingNotes).toBe(0)
    expect(replicaDiagnostics().lastError).toBeNull()
    expect(replicaDiagnostics().errorCount).toBe(5)
  })

  it("a failed push's rows do not clobber newer rows queued during the flight", async () => {
    const { handle, server } = createTestSync({ "a.md": "A\n" })
    server.failNext.push("network")
    handle.notifyGraphChange(["a"], diffOf({ nodes: [node("blk_a1", "old")] }))
    await advance(handle, DEBOUNCE)
    // While the failure is pending retry, a newer save arrives.
    handle.notifyGraphChange(["a"], diffOf({ nodes: [node("blk_a1", "new")] }))
    await advance(handle, DEBOUNCE)

    const successful = server.puts().filter((p) => p.body !== null)
    const lastBody = successful[successful.length - 1].body!
    expect(lastBody.nodes.map((row) => `${row.id}:${row.text}`)).toEqual(["blk_a1:new"])
    expect(server.remoteNodes.get("blk_a1")?.text).toBe("new")
  })

  it("auto-requests a full push when status shows the replica drastically behind", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`note-${i}.md`, `Note ${i}\n`]),
    )
    const rows = { nodes: Array.from({ length: 20 }, (_, i) => node(`note-${i}`)), links: [] }
    const { handle, server } = createTestSync(files, rows)

    handle.refreshRemoteStatus() // remote is empty → drastically behind
    await handle.flush()
    expect(replicaDiagnostics().fullPushPending).toBe(true)

    await advance(handle, DEBOUNCE)
    expect(server.remoteNodes.size).toBe(20)
    expect(replicaDiagnostics().fullPushPending).toBe(false)
  })

  it("flushes immediately with keepalive when the tab is hidden", async () => {
    const { handle, server } = createTestSync({ "a.md": "A\n" })
    handle.notifyGraphChange(["a"], diffOf({ nodes: [node("a")] }))
    expect(server.puts()).toHaveLength(0)

    // No visibilitychange in the node test env — pagehide covers the path.
    window.dispatchEvent(new Event("pagehide"))
    await advance(handle, 0)

    expect(server.puts()).toHaveLength(1)
    expect(server.puts()[0].keepalive).toBe(true)
    expect(server.remoteNodes.has("a")).toBe(true)
  })

  it("does nothing after stop", async () => {
    const { handle, server } = createTestSync({ "a.md": "A\n" })
    handle.notifyGraphChange(["a"], diffOf({ nodes: [node("a")] }))
    handle.stop()
    await advance(handle, DEBOUNCE)
    handle.notifyGraphChange(["a"], diffOf({ nodes: [node("a")] }))
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
