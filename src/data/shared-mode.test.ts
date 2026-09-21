// @vitest-environment jsdom
import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import type { ReceivedShareSummary, SliceBody } from "../../worker/shares/wire"
import { clearSession, seedSession } from "../utils/github-session"
import { buildGraphSnapshot, noteDoc } from "./graph"
import type { Op } from "./ops"
import {
  asNotes,
  flushSharedMode,
  mergeDiffs,
  mergeSnapshots,
  namesOwnNodes,
  receivedSharesAtom,
  recordedEmailAtom,
  requestSharesRefresh,
  routeOps,
  sharedApplyOps,
  sharedGraphAtom,
  sharedModeStatusAtom,
  sharedOriginAtom,
  startSharedMode,
  stopSharedMode,
} from "./shared-mode"

const toasts: string[] = []
vi.mock("sonner", () => ({ toast: (message: string) => toasts.push(message) }))

const node = (id: string, text: string, type = "ul", notesId?: string): NodeRow => ({
  id,
  type,
  text,
  props: null,
  updated_at: 1,
  ...(notesId ? { notes_id: notesId } : {}),
})
const link = (source: string, destination: string, sortKey = "a0"): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: "child",
  sort_key: sortKey,
  updated_at: 1,
})

const SHARE: ReceivedShareSummary = {
  id: "shr_1",
  owner: { login: "ada", name: "Ada" },
  view: { id: "blk_note", rootId: "blk_note", filter: null, sort: null },
  permissions: ["read", "write"],
  createdAt: 1,
}

const SLICE: SliceBody = {
  nodes: [node("blk_note", "Plan", "note"), node("blk_a", "one", "ul", "blk_note")],
  links: [link("blk_note", "blk_a")],
  view: SHARE.view,
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

describe("mergeSnapshots", () => {
  it("is the union, and returns an input untouched when the other is empty", () => {
    const own = buildGraphSnapshot([node("blk_x", "x", "note")], [])
    const shared = buildGraphSnapshot(SLICE.nodes, SLICE.links)
    const empty = buildGraphSnapshot([], [])
    expect(mergeSnapshots(own, empty)).toBe(own)
    expect(mergeSnapshots(empty, shared)).toBe(shared)
    const merged = mergeSnapshots(own, shared)
    expect([...merged.nodes.keys()].sort()).toEqual(["blk_a", "blk_note", "blk_x"])
    expect(merged.childLinks.get("blk_note")).toHaveLength(1)
  })

  it("indexes parents across the seam: a shared block the user also holds has both", () => {
    // The user linked a shared block into their own note, so it is held on
    // both sides; a merge by key would keep one parent, a rebuild keeps both.
    const own = buildGraphSnapshot([node("blk_x", "x", "note")], [link("blk_x", "blk_a")])
    const shared = buildGraphSnapshot(SLICE.nodes, SLICE.links)
    const merged = mergeSnapshots(own, shared)
    expect(
      merged.parentLinks
        .get("blk_a")!
        .map((l) => l.source_id)
        .sort(),
    ).toEqual(["blk_note", "blk_x"])
  })
})

describe("asNotes", () => {
  it("presents a block root as a note and leaves everything else alone", () => {
    const rows = [node("blk_note", "Plan", "note"), node("blk_a", "one"), node("blk_b", "two")]
    const out = asNotes(rows, ["blk_note", "blk_a"])
    expect(out.map((row) => row.type)).toEqual(["note", "note", "ul"])
    expect(rows[1].type).toBe("ul")
  })
})

describe("routeOps", () => {
  const origin = new Map([
    ["blk_note", "shr_1"],
    ["blk_a", "shr_1"],
    ["blk_z", "shr_2"],
  ])

  it("sends a batch naming only unknown ids to the own corpus", () => {
    expect(routeOps([{ op: "setText", id: "blk_mine", text: "x" }], origin)).toEqual({
      kind: "own",
    })
    expect(routeOps([], origin)).toEqual({ kind: "own" })
  })

  it("sends a batch on one share's nodes, creates included, to that share", () => {
    const ops: Op[] = [
      { op: "create", id: "blk_new", type: "ul", text: "n", props: null, notesId: "blk_note" },
      { op: "link", source: "blk_a", destination: "blk_new", sortKey: "a0" },
    ]
    expect(routeOps(ops, origin)).toEqual({ kind: "shared", shareId: "shr_1" })
  })

  it("refuses a batch spanning two shares", () => {
    expect(
      routeOps([{ op: "link", source: "blk_a", destination: "blk_z", sortKey: "a0" }], origin),
    ).toEqual({ kind: "mixed" })
  })

  it("tells a batch that also names the user's own nodes", () => {
    const own = buildGraphSnapshot([node("blk_mine", "m", "note")], [])
    const ops: Op[] = [{ op: "link", source: "blk_mine", destination: "blk_a", sortKey: "a0" }]
    expect(routeOps(ops, origin)).toEqual({ kind: "shared", shareId: "shr_1" })
    expect(namesOwnNodes(ops, origin, own)).toBe(true)
    expect(namesOwnNodes([{ op: "setText", id: "blk_a", text: "x" }], origin, own)).toBe(false)
  })
})

describe("mergeDiffs", () => {
  it("keeps one row per key, the later winning", () => {
    const merged = mergeDiffs(
      {
        nodes: [node("blk_a", "old")],
        links: [link("blk_note", "blk_a", "a0")],
        views: [],
        deleteNodes: [],
        deleteLinks: [],
      },
      {
        nodes: [node("blk_a", "new"), node("blk_b", "b")],
        links: [link("blk_note", "blk_a", "a1")],
        views: [],
        deleteNodes: [],
        deleteLinks: [],
      },
    )
    expect(merged.nodes.map((row) => `${row.id}:${row.text}`)).toEqual(["blk_a:new", "blk_b:b"])
    expect(merged.links.map((row) => row.sort_key)).toEqual(["a1"])
  })
})

// -----------------------------------------------------------------------------
// The runtime
// -----------------------------------------------------------------------------

interface Stub {
  fetch: typeof fetch
  calls: { method: string; url: string; body: unknown }[]
  slice: SliceBody
  received: ReceivedShareSummary[]
  /** Answer the next PUT with this status and body. */
  refuse: { status: number; body: unknown } | null
}

function stubServer(): Stub {
  const stub: Stub = {
    calls: [],
    slice: SLICE,
    received: [SHARE],
    refuse: null,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = (init?.body ? JSON.parse(String(init.body)) : undefined) as
        { nodes: NodeRow[]; links: LinkRow[] } | undefined
      stub.calls.push({ method, url, body })
      if (url === "/api/shares" && method === "GET") {
        return Response.json({
          me: { email: "bob@example.com" },
          given: [],
          received: stub.received,
        })
      }
      if (url === "/api/shares/shr_1/notes" && method === "GET") return Response.json(stub.slice)
      if (url === "/api/shares/shr_1/notes" && method === "PUT") {
        if (stub.refuse) return Response.json(stub.refuse.body, { status: stub.refuse.status })
        return Response.json({ ok: true, nodes: body?.nodes.length, links: body?.links.length })
      }
      return Response.json({ error: "not_found" }, { status: 404 })
    }) as typeof fetch,
  }
  return stub
}

const store = getDefaultStore()
const puts = (stub: Stub) => stub.calls.filter((call) => call.method === "PUT")

describe("shared mode", () => {
  beforeEach(() => {
    toasts.length = 0
    seedSession({ token: "t", login: "bob", name: "Bob", email: "bob@example.com" })
  })

  afterEach(() => {
    stopSharedMode()
    clearSession()
    vi.useRealTimers()
  })

  it("lists my shares, pulls each slice and publishes it with its origin", async () => {
    const stub = stubServer()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()

    expect(store.get(sharedModeStatusAtom).status).toBe("ready")
    expect(store.get(receivedSharesAtom)).toEqual([SHARE])
    expect(store.get(recordedEmailAtom)).toBe("bob@example.com")
    const graph = store.get(sharedGraphAtom)
    expect(noteDoc("blk_note", graph)?.rootBlockIds).toEqual(["blk_a"])
    expect(store.get(sharedOriginAtom).get("blk_a")).toBe("shr_1")
    expect(store.get(sharedOriginAtom).get("blk_note")).toBe("shr_1")
  })

  it("applies an edit at once and pushes the row diff after a moment", async () => {
    vi.useFakeTimers()
    const stub = stubServer()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()

    sharedApplyOps("shr_1", [{ op: "setText", id: "blk_a", text: "changed" }])
    expect(store.get(sharedGraphAtom).nodes.get("blk_a")?.text).toBe("changed")
    expect(puts(stub)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_500)
    expect(puts(stub)).toHaveLength(1)
    const pushed = puts(stub)[0].body as { nodes: NodeRow[]; links: LinkRow[] }
    expect(pushed.nodes.map((row) => [row.id, row.text])).toEqual([["blk_a", "changed"]])
    expect(pushed.links).toEqual([])
    expect("cursor" in pushed).toBe(false)
  })

  it("pushes a block root back with its own type, not the note it is shown as", async () => {
    vi.useFakeTimers()
    const stub = stubServer()
    stub.received = [{ ...SHARE, view: { id: "blk_a", rootId: "blk_a", filter: null, sort: null } }]
    stub.slice = {
      nodes: [node("blk_a", "one", "ul")],
      links: [],
      view: { id: "blk_a", rootId: "blk_a", filter: null, sort: null },
    }
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()
    expect(store.get(sharedGraphAtom).nodes.get("blk_a")?.type).toBe("note")

    sharedApplyOps("shr_1", [{ op: "setText", id: "blk_a", text: "changed" }])
    await vi.advanceTimersByTimeAsync(1_500)
    const pushed = puts(stub)[0].body as { nodes: NodeRow[] }
    expect(pushed.nodes).toEqual([
      expect.objectContaining({ id: "blk_a", type: "ul", text: "changed" }),
    ])
  })

  it("coalesces a run of edits into one push", async () => {
    vi.useFakeTimers()
    const stub = stubServer()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()

    sharedApplyOps("shr_1", [{ op: "setText", id: "blk_a", text: "c" }])
    await vi.advanceTimersByTimeAsync(400)
    sharedApplyOps("shr_1", [{ op: "setText", id: "blk_a", text: "ch" }])
    await vi.advanceTimersByTimeAsync(1_500)
    expect(puts(stub)).toHaveLength(1)
    expect((puts(stub)[0].body as { nodes: NodeRow[] }).nodes[0].text).toBe("ch")
  })

  it("refuses an edit on a read-only share before anything changes", async () => {
    const stub = stubServer()
    stub.received = [{ ...SHARE, permissions: ["read"] }]
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()

    sharedApplyOps("shr_1", [{ op: "setText", id: "blk_a", text: "changed" }])
    expect(store.get(sharedGraphAtom).nodes.get("blk_a")?.text).toBe("one")
    expect(toasts).toHaveLength(1)
    await flushSharedMode()
    expect(puts(stub)).toHaveLength(0)
  })

  it("refuses a delete without the delete verb", async () => {
    const stub = stubServer()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()
    sharedApplyOps("shr_1", [{ op: "delete", id: "blk_a" }])
    expect(store.get(sharedGraphAtom).nodes.has("blk_a")).toBe(true)
    expect(toasts[0]).toMatch(/delete/)
  })

  it("reverts to the owner's rows when the server refuses a push", async () => {
    vi.useFakeTimers()
    const stub = stubServer()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()

    stub.refuse = { status: 403, body: { error: "outside_share", detail: "Nope." } }
    sharedApplyOps("shr_1", [{ op: "setText", id: "blk_a", text: "changed" }])
    await vi.advanceTimersByTimeAsync(1_500)
    expect(puts(stub)).toHaveLength(1)
    expect(toasts[0]).toMatch(/refused: Nope/)
    expect(store.get(sharedGraphAtom).nodes.get("blk_a")?.text).toBe("one")
    // No retry: the server will say the same thing again.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(puts(stub)).toHaveLength(1)
  })

  it("keeps the rows and retries when the network fails", async () => {
    vi.useFakeTimers()
    const stub = stubServer()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()

    const good = stub.fetch
    let failures = 0
    stub.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT" && failures < 1) {
        failures += 1
        throw new TypeError("Failed to fetch")
      }
      return good(input, init)
    }) as typeof fetch
    stopSharedMode()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()

    sharedApplyOps("shr_1", [{ op: "setText", id: "blk_a", text: "changed" }])
    await vi.advanceTimersByTimeAsync(1_500)
    expect(failures).toBe(1)
    expect(store.get(sharedGraphAtom).nodes.get("blk_a")?.text).toBe("changed")
    await vi.advanceTimersByTimeAsync(3_000)
    expect(puts(stub)).toHaveLength(1)
  })

  it("drops a share that is no longer addressed to me on refresh", async () => {
    const stub = stubServer()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()
    expect(store.get(sharedGraphAtom).nodes.size).toBe(2)

    stub.received = []
    await requestSharesRefresh()
    expect(store.get(sharedGraphAtom).nodes.size).toBe(0)
    expect(store.get(receivedSharesAtom)).toEqual([])
  })

  it("clears everything when stopped", async () => {
    const stub = stubServer()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()
    stopSharedMode()
    expect(store.get(sharedGraphAtom).nodes.size).toBe(0)
    expect(store.get(sharedOriginAtom).size).toBe(0)
    expect(store.get(sharedModeStatusAtom).status).toBe("off")
  })
})

describe("mergeDiffs, views", () => {
  it("keeps queued views, the later state of a key winning", () => {
    const view = (id: string, pinned: boolean, updated_at: number) => ({
      id,
      root_id: "blk_a",
      filter: null,
      sort: null,
      pinned,
      sort_key: null,
      updated_at,
    })
    const merged = mergeDiffs(
      {
        nodes: [],
        links: [],
        views: [view("v1", true, 1), view("v2", true, 1)],
        deleteNodes: [],
        deleteLinks: [],
      },
      { nodes: [], links: [], views: [view("v1", false, 2)], deleteNodes: [], deleteLinks: [] },
    )
    // Before this, a merge rebuilt the diff from nodes and links alone and a
    // queued pin was silently dropped on coalesce.
    expect(merged.views.map((v) => [v.id, v.pinned, v.updated_at])).toEqual([
      ["v1", false, 2],
      ["v2", true, 1],
    ])
  })
})
