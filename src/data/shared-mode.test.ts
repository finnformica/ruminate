// @vitest-environment jsdom
import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import type { ReceivedShareSummary, SliceBody } from "../../worker/shares/wire"
import { clearSession, seedSession } from "../utils/github-session"
import { buildGraphSnapshot, noteDoc } from "./graph"
import type { Op } from "./ops"
import {
  asNotes,
  flushSharedMode,
  mergeSnapshots,
  receivedSharesAtom,
  recordedEmailAtom,
  requestSharesRefresh,
  sharedGraphAtom,
  sharedModeStatusAtom,
  sharedOriginAtom,
  startSharedMode,
  stopSharedMode,
  touchesShared,
} from "./shared-mode"

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
  rootIds: ["blk_note"],
  createdAt: 1,
}

const SLICE: SliceBody = {
  nodes: [node("blk_note", "Plan", "note"), node("blk_a", "one", "ul", "blk_note")],
  links: [link("blk_note", "blk_a")],
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
})

describe("asNotes", () => {
  it("presents a block root as a note and leaves everything else alone", () => {
    const rows = [node("blk_note", "Plan", "note"), node("blk_a", "one"), node("blk_b", "two")]
    const out = asNotes(rows, ["blk_note", "blk_a"])
    expect(out.map((row) => row.type)).toEqual(["note", "note", "ul"])
    expect(out[1].text).toBe("one")
    expect(rows[1].type).toBe("ul")
  })
})

describe("touchesShared", () => {
  const origin = new Map([
    ["blk_note", "shr_1"],
    ["blk_a", "shr_1"],
  ])

  it("is false for a batch naming only the user's own ids", () => {
    expect(touchesShared([{ op: "setText", id: "blk_mine", text: "x" }], origin)).toBe(false)
    expect(touchesShared([], origin)).toBe(false)
    expect(touchesShared([{ op: "setText", id: "blk_a", text: "x" }], new Map())).toBe(false)
  })

  it("is true for an edit, a link or a delete on a shared node", () => {
    const edits: Op[][] = [
      [{ op: "setText", id: "blk_a", text: "x" }],
      [{ op: "link", source: "blk_mine", destination: "blk_a", sortKey: "a0" }],
      [{ op: "unlink", source: "blk_note", destination: "blk_a" }],
      [{ op: "delete", id: "blk_note" }],
      [
        { op: "create", id: "blk_new", type: "ul", text: "n", props: null, notesId: "blk_note" },
        { op: "link", source: "blk_a", destination: "blk_new", sortKey: "a0" },
      ],
    ]
    for (const ops of edits) expect(touchesShared(ops, origin)).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// The runtime
// -----------------------------------------------------------------------------

interface Stub {
  fetch: typeof fetch
  calls: { method: string; url: string }[]
  received: ReceivedShareSummary[]
}

function stubServer(): Stub {
  const stub: Stub = {
    calls: [],
    received: [SHARE],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      stub.calls.push({ method, url })
      if (url === "/api/shares" && method === "GET") {
        return Response.json({
          me: { email: "bob@example.com" },
          given: [],
          received: stub.received,
        })
      }
      if (url === "/api/shares/shr_1/notes" && method === "GET") return Response.json(SLICE)
      return Response.json({ error: "not_found" }, { status: 404 })
    }) as typeof fetch,
  }
  return stub
}

const store = getDefaultStore()

describe("shared mode", () => {
  beforeEach(() => {
    seedSession({ token: "t", login: "bob", name: "Bob", email: "bob@example.com" })
  })

  afterEach(() => {
    stopSharedMode()
    clearSession()
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
    // Read-only: nothing is ever pushed.
    expect(stub.calls.every((call) => call.method === "GET")).toBe(true)
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

  it("reports a failed refresh without dropping what it had", async () => {
    const stub = stubServer()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()

    stub.fetch = (async () => {
      throw new TypeError("Failed to fetch")
    }) as typeof fetch
    stopSharedMode()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()
    expect(store.get(sharedModeStatusAtom)).toEqual({
      status: "error",
      lastError: "Failed to fetch",
    })
  })

  it("clears everything when stopped", async () => {
    const stub = stubServer()
    startSharedMode({ fetchImpl: stub.fetch })
    await flushSharedMode()
    stopSharedMode()
    expect(store.get(sharedGraphAtom).nodes.size).toBe(0)
    expect(store.get(sharedOriginAtom).size).toBe(0)
    expect(store.get(recordedEmailAtom)).toBeNull()
    expect(store.get(sharedModeStatusAtom).status).toBe("off")
  })
})
