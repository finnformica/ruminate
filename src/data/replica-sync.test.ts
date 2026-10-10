// @vitest-environment jsdom
import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  parseReplicaPayload,
  type LinkRow,
  type NodeRow,
  type ViewRow,
} from "../../worker/handlers/replica-payload"
import {
  EVENT_VERSION,
  linkEntityId,
  parseEventsPayload,
  type EventsPutResult,
  type RuminateEvent,
} from "./events"
import {
  isReplicaDrasticallyBehind,
  startReplicaSync,
  type ReplicaSyncHandle,
} from "./replica-sync"
import { storageDiagnosticsAtom } from "./storage-diagnostics"

/**
 * Unit tests for the D1 replication loop. The fake Worker below takes events
 * (`PUT /api/replica/events`) and rows (`PUT /api/replica/notes`, the full
 * push), folds what it is sent into a row map so `/api/replica/status`
 * returns live-ish counts, and validates every body with the real parsers
 * from the Worker — the payloads the client builds must be the payloads the
 * Worker accepts. The fake store below is the queue: events it holds without
 * a `seq` are unpushed, and an acknowledgement stamps them.
 */

interface RecordedRequest {
  url: string
  method: string
  authorization: string | null
  keepalive: boolean
  rows: ReturnType<typeof parseReplicaPayload> | null
  events: ReturnType<typeof parseEventsPayload> | null
}

let minted = 0
/** A block's create, as the runtime would make it. */
const create = (id: string, text = id, at = 1): RuminateEvent => ({
  id: `evt_${(minted += 1)}`,
  entity: "block",
  entity_id: id,
  action: "create",
  patch: { type: id.startsWith("blk_") ? "text" : "note", text, props: null, notes_id: null },
  batch: `bat_${minted}`,
  device: "dev.tab",
  at,
  v: EVENT_VERSION,
})
const edit = (id: string, text: string, at = 1): RuminateEvent => ({
  id: `evt_${(minted += 1)}`,
  entity: "block",
  entity_id: id,
  action: "update",
  patch: { text },
  batch: `bat_${minted}`,
  device: "dev.tab",
  at,
  v: EVENT_VERSION,
})
const node = (id: string, text = id): NodeRow => ({
  id,
  type: id.startsWith("blk_") ? "text" : "note",
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

function createTestServer() {
  const requests: RecordedRequest[] = []
  const remoteNodes = new Map<string, NodeRow>()
  const remoteLinks = new Map<string, LinkRow>()
  const remoteViews = new Map<string, ViewRow>()
  /** The log: every event id the fake has taken, with its seq. */
  const log = new Map<string, number>()
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
      rows: null,
      events: null,
    }

    if (url === "/api/replica/events" && method === "PUT") {
      const failure = failNext.shift()
      if (failure === "network") {
        requests.push(record)
        throw new TypeError("Failed to fetch")
      }
      const payload = parseEventsPayload(JSON.parse(String(init?.body)))
      record.events = payload
      requests.push(record)
      if (failure !== undefined) return new Response("{}", { status: failure })
      if (!payload) return new Response("{}", { status: 400 })
      let appended = 0
      for (const event of payload.events) {
        if (!log.has(event.id)) {
          log.set(event.id, log.size + 1)
          appended += 1
        }
        if (event.entity !== "block") continue
        const held = remoteNodes.get(event.entity_id)
        const patch = event.patch as Partial<NodeRow>
        remoteNodes.set(event.entity_id, {
          ...(held ?? node(event.entity_id)),
          ...patch,
          updated_at: event.at,
        } as NodeRow)
      }
      if (payload.cursor !== undefined) remoteCursor = payload.cursor
      const result: EventsPutResult = {
        ok: true,
        appended,
        stale: 0,
        seqs: payload.events.map((event) => [event.id, log.get(event.id) as number]),
        cursor: payload.cursor ?? null,
      }
      return new Response(JSON.stringify(result), { status: 200 })
    }

    if (url === "/api/replica/notes" && method === "PUT") {
      const failure = failNext.shift()
      if (failure === "network") {
        requests.push(record)
        throw new TypeError("Failed to fetch")
      }
      const payload = parseReplicaPayload(JSON.parse(String(init?.body)))
      record.rows = payload
      requests.push(record)
      if (failure !== undefined) return new Response("{}", { status: failure })
      if (!payload) return new Response("{}", { status: 400 })
      for (const row of payload.nodes) remoteNodes.set(row.id, row)
      for (const row of payload.links) {
        remoteLinks.set(linkEntityId(row.source_id, row.destination_id, row.kind), row)
      }
      for (const row of payload.views ?? []) remoteViews.set(row.id, row)
      if (payload.cursor !== undefined) remoteCursor = payload.cursor
      // The real Worker echoes the cursor the batch committed — that is how
      // the client confirms it without a second request.
      return new Response(
        JSON.stringify({
          ok: true,
          nodes: payload.nodes.length,
          links: payload.links.length,
          deletes: 0,
          cursor: payload.cursor ?? null,
        }),
        { status: 200 },
      )
    }

    if (url === "/api/replica/status" && method === "GET") {
      requests.push(record)
      const pages = [...remoteNodes.values()].filter((row) => row.type === "note").length
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
    remoteViews,
    log,
    failNext,
    puts: () => requests.filter((r) => r.url === "/api/replica/events"),
    rowPuts: () => requests.filter((r) => r.url === "/api/replica/notes"),
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

/** The store's log, as the loop sees it: unpushed until stamped. */
function createTestStore() {
  const events: { event: RuminateEvent; seq: number | null }[] = []
  const stamped: [string, number][] = []
  return {
    events,
    stamped,
    getUnpushedEvents: async () => events.filter((e) => e.seq === null).map((e) => e.event),
    markEventsPushed: async (seqs: readonly (readonly [string, number])[]) => {
      for (const [id, seq] of seqs) {
        stamped.push([id, seq])
        const held = events.find((e) => e.event.id === id)
        if (held) held.seq = seq
      }
    },
    /** What the runtime does after a flush: the events are in the log. */
    add: (...made: RuminateEvent[]) => {
      for (const event of made) events.push({ event, seq: null })
    },
    unpushed: () => events.filter((e) => e.seq === null).map((e) => e.event.id),
  }
}

const DEBOUNCE = 2_000

function createTestSync(
  initialFiles: Record<string, string>,
  allRows: { nodes: NodeRow[]; links: LinkRow[]; views: ViewRow[] } = {
    nodes: [],
    links: [],
    views: [],
  },
  overrides: Partial<Parameters<typeof startReplicaSync>[0]> = {},
) {
  const server = createTestServer()
  const auth = createTestAuth()
  const store = createTestStore()
  let files = { ...initialFiles }
  const handle = startReplicaSync({
    getNoteCount: () => Object.keys(files).length,
    getAllRows: async () => allRows,
    getUnpushedEvents: store.getUnpushedEvents,
    markEventsPushed: store.markEventsPushed,
    fetchImpl: server.fetchImpl,
    auth,
    ...overrides,
  })
  handles.push(handle)
  /** A flush landed: these events are in the log, and these notes/views touched. */
  const save = (noteIds: string[], events: RuminateEvent[], viewIds: string[] = []) => {
    store.add(...events)
    handle.notifyChange(noteIds, viewIds)
  }
  return {
    handle,
    server,
    auth,
    store,
    save,
    setFiles: (next: Record<string, string>) => {
      files = { ...next }
    },
  }
}

const replicaDiagnostics = () => getDefaultStore().get(storageDiagnosticsAtom).replica!

/** Pretend the browser is (or is not) offline — `navigator.onLine`. */
function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online })
}

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
  delete (window.navigator as { onLine?: boolean }).onLine
  const store = getDefaultStore()
  store.set(storageDiagnosticsAtom, { ...store.get(storageDiagnosticsAtom), replica: null })
})

const sent = (request: RecordedRequest) => request.events?.events.map((event) => event.id) ?? []

describe("replica sync queue", () => {
  it("pushes everything unpushed in one debounced request, in the order made, and stamps what landed", async () => {
    const { handle, server, store, save } = createTestSync({ "a.md": "A\n", "b.md": "B\n" })
    const [a, a1, b, a1v2] = [
      create("a"),
      create("blk_a1", "v1"),
      create("b"),
      edit("blk_a1", "v2"),
    ]
    save(["a"], [a, a1])
    save(["b"], [b])
    save(["a"], [a1v2])
    expect(replicaDiagnostics().pendingNotes).toBe(2)

    await advance(handle, DEBOUNCE)

    expect(server.puts()).toHaveLength(1)
    expect(server.statuses()).toHaveLength(1)
    expect(sent(server.puts()[0])).toEqual([a.id, a1.id, b.id, a1v2.id])
    expect(server.remoteNodes.get("blk_a1")?.text).toBe("v2")
    // Acknowledged: the store stamped each with the replica's seq.
    expect(store.stamped).toEqual([
      [a.id, 1],
      [a1.id, 2],
      [b.id, 3],
      [a1v2.id, 4],
    ])
    expect(store.unpushed()).toEqual([])
    const diag = replicaDiagnostics()
    expect(diag.pendingNotes).toBe(0)
    expect(diag.lastPushAt).not.toBeNull()
    expect(diag.lastPushNotes).toBe(2)
    expect(diag.cursorConfirmed).toBe(true)
    expect(diag.remote?.pages).toBe(2)
  })

  it("pushes what a previous session left unpushed, with nothing to prompt it", async () => {
    const { handle, server, store } = createTestSync({ "a.md": "A\n" })
    store.add(create("a"))
    await advance(handle, DEBOUNCE)
    expect(server.puts()).toHaveLength(1)
    expect(store.unpushed()).toEqual([])
    // And nothing more: an empty queue is not a push.
    await advance(handle, DEBOUNCE * 5)
    expect(server.puts()).toHaveLength(1)
  })

  it("reads the status endpoint once per session, not once per save", async () => {
    // `GET /api/replica/status` scans the tenant's rows; running it after
    // every push is what burned through the D1 read budget. The cursor is
    // confirmed by the push's own response instead.
    const { handle, server, save } = createTestSync({ "a.md": "A\n", "b.md": "B\n" })
    save(["a"], [create("a")])
    await advance(handle, DEBOUNCE)
    expect(server.statuses()).toHaveLength(1)

    for (const id of ["b", "c", "d"]) {
      save([id], [create(id)])
      await advance(handle, DEBOUNCE)
    }

    expect(server.puts()).toHaveLength(4)
    expect(server.statuses()).toHaveLength(1)
    // Every push still knows its cursor landed.
    expect(replicaDiagnostics().cursorConfirmed).toBe(true)
  })

  it("a push whose cursor the replica did not commit is not marked confirmed", async () => {
    // A replica that answers 200 without committing the cursor (an older
    // Worker, a proxy) must not be reported as confirmed.
    const server = createTestServer()
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await server.fetchImpl(input, init)
      if ((init?.method ?? "GET") !== "PUT") return response
      // Either door: the answer carries no cursor.
      const body = (await response.json()) as EventsPutResult
      return new Response(JSON.stringify({ ...body, cursor: null }), { status: 200 })
    }) as typeof fetch
    const { handle, save } = createTestSync(
      { "a.md": "A\n" },
      { nodes: [], links: [], views: [] },
      { fetchImpl },
    )

    // Spend the session's one status check up front (as opening the Settings
    // panel does), so what the push reports comes from the push alone.
    handle.refreshRemoteStatus()
    save(["a"], [create("a")])
    await advance(handle, DEBOUNCE)

    expect(replicaDiagnostics().cursor).not.toBeNull()
    expect(replicaDiagnostics().cursorConfirmed).toBe(false)
  })

  it("a long queue goes out in runs, in order, with the cursor on the last", async () => {
    const { handle, server, store, save } = createTestSync(
      { "a.md": "A\n" },
      { nodes: [], links: [], views: [] },
      { chunkRows: 2 },
    )
    const events = Array.from({ length: 5 }, (_, i) => create(`note-${i}`))
    save(["a"], events)
    await advance(handle, DEBOUNCE)

    const puts = server.puts()
    expect(puts.map((p) => p.events?.events.length)).toEqual([2, 2, 1])
    expect(puts.flatMap(sent)).toEqual(events.map((event) => event.id))
    expect(puts.map((p) => p.events?.cursor !== undefined)).toEqual([false, false, true])
    expect(store.unpushed()).toEqual([])
    expect(replicaDiagnostics().cursorConfirmed).toBe(true)
  })

  it("a full push sends every row, nodes before links, in chunks, cursor on the last", async () => {
    const rows = {
      nodes: Array.from({ length: 5 }, (_, i) => node(`note-${i}`)),
      links: [link("note-0", "note-1")], // shape only — content irrelevant
      views: [],
    }
    const { handle, server } = createTestSync({ "a.md": "A\n" }, rows, { chunkRows: 2 })
    handle.requestFullPush()
    await advance(handle, DEBOUNCE)

    const puts = server.rowPuts()
    // 5 nodes + 1 link in chunks of 2 rows → 3 payloads, links after all nodes.
    expect(puts.map((p) => p.rows?.nodes.length)).toEqual([2, 2, 1])
    expect(puts.map((p) => p.rows?.links.length)).toEqual([0, 0, 1])
    expect(puts.map((p) => p.rows?.cursor !== undefined)).toEqual([false, false, true])
    expect(server.remoteNodes.size).toBe(5)
    expect(server.puts()).toHaveLength(0)
  })

  it("refreshes the session and retries once on a 401", async () => {
    const { handle, server, auth, save } = createTestSync({ "a.md": "A\n" })
    server.failNext.push(401)
    save(["a"], [create("a")])
    await advance(handle, DEBOUNCE)

    expect(auth.refreshes).toBe(1)
    const puts = server.puts()
    expect(puts).toHaveLength(2)
    expect(puts[0].authorization).toBe("Bearer tok-1")
    expect(puts[1].authorization).toBe("Bearer tok-2")
    expect(replicaDiagnostics().errorCount).toBe(0)
    expect(server.remoteNodes.has("a")).toBe(true)
  })

  it("keeps failed pushes queued and retries with exponential backoff", async () => {
    const { handle, server, store, save } = createTestSync(
      { "a.md": "A\n" },
      { nodes: [], links: [], views: [] },
      { backoffStartMs: 1_000, backoffMaxMs: 4_000 },
    )
    server.failNext.push("network", 500, "network", "network", "network")
    const a = create("a")
    save(["a"], [a])

    await advance(handle, DEBOUNCE)
    expect(server.puts()).toHaveLength(1)
    expect(replicaDiagnostics().pendingNotes).toBe(1) // restored after failure
    expect(replicaDiagnostics().lastError?.message).toMatch(/Failed to fetch/)
    expect(store.unpushed()).toEqual([a.id]) // never stamped by a failure

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
    expect(store.unpushed()).toEqual([])
    expect(replicaDiagnostics().pendingNotes).toBe(0)
    expect(replicaDiagnostics().lastError).toBeNull()
    expect(replicaDiagnostics().errorCount).toBe(5)
  })

  it("offline, nothing is attempted: the events wait, and the online event pushes them", async () => {
    // `navigator.onLine === false` means there is no network at all, so a
    // push would only fail and read as "Sync failed" in the sidebar. Skip it:
    // the events stay queued (the status reads "Offline"), no error is
    // recorded, and `online` pushes them at once.
    const { handle, server, save } = createTestSync({ "a.md": "A\n" })
    setOnline(false)
    save(["a"], [create("a")])

    await advance(handle, DEBOUNCE)
    expect(server.puts()).toHaveLength(0)
    expect(replicaDiagnostics().pendingNotes).toBe(1)
    expect(replicaDiagnostics().lastError).toBeNull()
    // The backstop re-check does not turn into an attempt while still offline.
    await advance(handle, 60_000)
    expect(server.puts()).toHaveLength(0)

    setOnline(true)
    window.dispatchEvent(new Event("online"))
    await advance(handle, 0)
    expect(server.puts()).toHaveLength(1)
    expect(server.remoteNodes.has("a")).toBe(true)
    expect(replicaDiagnostics().pendingNotes).toBe(0)
    expect(replicaDiagnostics().errorCount).toBe(0)
  })

  it("after a failed push, the retry carries the old events and the new ones, in order", async () => {
    const { handle, server, save } = createTestSync({ "a.md": "A\n" })
    server.failNext.push("network")
    const old = edit("blk_a1", "old")
    save(["a"], [old])
    await advance(handle, DEBOUNCE)
    // While the failure is pending retry, a newer save arrives.
    const fresh = edit("blk_a1", "new", 2)
    save(["a"], [fresh])
    await advance(handle, DEBOUNCE)

    const successful = server.puts().filter((p) => p.events !== null)
    expect(sent(successful[successful.length - 1])).toEqual([old.id, fresh.id])
    expect(server.remoteNodes.get("blk_a1")?.text).toBe("new")
  })

  it("names the events of a push in flight until it settles", async () => {
    let handle: ReplicaSyncHandle | null = null
    const seen: Set<string>[] = []
    const inner = createTestServer()
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") seen.push(handle!.inFlightEventIds!())
      return inner.fetchImpl(input, init)
    }) as typeof fetch
    const sync = createTestSync(
      { "a.md": "A\n" },
      { nodes: [], links: [], views: [] },
      { fetchImpl },
    )
    handle = sync.handle
    const a = create("a")
    sync.save(["a"], [a])
    expect(handle.inFlightEventIds!()).toEqual(new Set())

    await advance(handle, DEBOUNCE)

    // While the request was out, the store was told to leave `a` alone.
    expect(seen).toEqual([new Set([a.id])])
    expect(handle.inFlightEventIds!()).toEqual(new Set())
  })

  it("auto-requests a full push when status shows the replica drastically behind", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`note-${i}.md`, `Note ${i}\n`]),
    )
    const rows = {
      nodes: Array.from({ length: 20 }, (_, i) => node(`note-${i}`)),
      links: [],
      views: [],
    }
    const { handle, server } = createTestSync(files, rows)

    handle.refreshRemoteStatus() // remote is empty → drastically behind
    await handle.flush()
    expect(replicaDiagnostics().fullPushPending).toBe(true)

    await advance(handle, DEBOUNCE)
    expect(server.remoteNodes.size).toBe(20)
    expect(replicaDiagnostics().fullPushPending).toBe(false)
  })

  it("flushes immediately with keepalive when the tab is hidden", async () => {
    const { handle, server, save } = createTestSync({ "a.md": "A\n" })
    save(["a"], [create("a")])
    expect(server.puts()).toHaveLength(0)

    // No visibilitychange in the node test env — pagehide covers the path.
    window.dispatchEvent(new Event("pagehide"))
    await advance(handle, 0)

    expect(server.puts()).toHaveLength(1)
    expect(server.puts()[0].keepalive).toBe(true)
    expect(server.remoteNodes.has("a")).toBe(true)
  })

  it("does nothing after stop", async () => {
    const { handle, server, save } = createTestSync({ "a.md": "A\n" })
    save(["a"], [create("a")])
    handle.stop()
    await advance(handle, DEBOUNCE)
    save(["a"], [create("a")])
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

describe("views ride the push", () => {
  const view: ViewRow = {
    id: "view_1",
    root_id: "blk_a",
    filter: "type:todo",
    sort: null,
    pinned: true,
    sort_key: "a0",
    updated_at: 100,
  }
  const viewEvent = (action: "create" | "update", patch: object, at = 100): RuminateEvent =>
    ({
      id: `evt_${(minted += 1)}`,
      entity: "view",
      entity_id: view.id,
      action,
      patch,
      batch: `bat_${minted}`,
      device: "dev.tab",
      at,
      v: EVENT_VERSION,
    }) as RuminateEvent

  it("pushes a queued view's event like any other", async () => {
    const { handle, server, save } = createTestSync({})
    const made = viewEvent("create", {
      root_id: view.root_id,
      filter: view.filter,
      sort: view.sort,
      pinned: view.pinned,
      sort_key: view.sort_key,
    })
    save([], [made], [view.id])
    await advance(handle, DEBOUNCE)
    expect(sent(server.puts().at(-1)!)).toEqual([made.id])
  })

  it("a full push carries every view the store holds", async () => {
    const { handle, server } = createTestSync({}, { nodes: [], links: [], views: [view] })
    handle.requestFullPush()
    await advance(handle, DEBOUNCE)
    expect(server.rowPuts().at(-1)?.rows?.views).toEqual([view])
  })

  it("two changes to one view are two events, in the order made", async () => {
    const { handle, server, save } = createTestSync({})
    const first = viewEvent("update", { pinned: true }, 1)
    const second = viewEvent("update", { pinned: false }, 2)
    save([], [first], [view.id])
    save([], [second], [view.id])
    await advance(handle, DEBOUNCE)
    expect(sent(server.puts().at(-1)!)).toEqual([first.id, second.id])
  })
})

describe("pendingViewIds", () => {
  it("names a queued view until its push is confirmed, then forgets it", async () => {
    const { handle, save } = createTestSync({})
    expect(handle.pendingViewIds!()).toEqual(new Set())
    save([], [create("view_1")], ["view_1"])
    // Queued: the pull side must leave it alone.
    expect(handle.pendingViewIds!()).toEqual(new Set(["view_1"]))
    await advance(handle, DEBOUNCE)
    expect(handle.pendingViewIds!()).toEqual(new Set())
  })

  it("keeps naming a view whose push failed — it is still on its way out", async () => {
    const { handle, server, save } = createTestSync({})
    server.failNext.push(500)
    save([], [create("view_1")], ["view_1"])
    await advance(handle, DEBOUNCE)
    expect(handle.pendingViewIds!()).toEqual(new Set(["view_1"]))
  })
})
