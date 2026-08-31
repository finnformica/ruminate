import { describe, expect, it, vi } from "vitest"
import type { LinkRow, NodeRow } from "../../worker/handlers/replica-payload"
import {
  SINCE_OVERLAP_MS,
  createD1NoteSource,
  expandPendingNodeIds,
  planPullApplication,
} from "./d1-note-source"

/** Fake auth mirroring the real helpers: `withAuthRetry` refreshes once and
 * retries when the operation throws a 401-shaped error. */
function fakeAuth(tokens: string[]) {
  let index = 0
  const refresh = vi.fn(() => {
    index = Math.min(index + 1, tokens.length - 1)
  })
  return {
    refresh,
    auth: {
      ensureFreshToken: vi.fn(async () => {}),
      getAccessToken: () => tokens[index],
      withAuthRetry: async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation()
        } catch (error) {
          if ((error as { status?: number }).status !== 401) throw error
          refresh()
          return await operation()
        }
      },
    },
  }
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const node = (id: string, updated_at = 0, text = id): NodeRow => ({
  id,
  type: id.startsWith("blk_") ? "text" : "page",
  text,
  props: null,
  updated_at,
})

const link = (source: string, destination: string, updated_at = 0, sortKey = "a0"): LinkRow => ({
  source_id: source,
  destination_id: destination,
  kind: "child",
  sort_key: sortKey,
  updated_at,
})

describe("createD1NoteSource", () => {
  it("pullFull GETs the corpus with cookie credentials and a Bearer token", async () => {
    const body = { nodes: [node("a", 1)], links: [link("a", "blk_1", 1)], cursor: "77" }
    const fetchImpl = vi.fn(async () => jsonResponse(body))
    const { auth } = fakeAuth(["tok-1"])
    const source = createD1NoteSource({ fetchImpl: fetchImpl as unknown as typeof fetch, auth })

    await expect(source.pullFull()).resolves.toEqual(body)
    expect(fetchImpl).toHaveBeenCalledWith("/api/replica/notes", {
      method: "GET",
      credentials: "same-origin",
      headers: { Authorization: "Bearer tok-1" },
    })
  })

  it("pullSince subtracts the clock-skew overlap from the cursor (floored at 0)", async () => {
    const body = { nodes: [], links: [], nodeIds: [], linkKeys: [], cursor: "9000000000" }
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse(body))
    const { auth } = fakeAuth(["tok-1"])
    const source = createD1NoteSource({ fetchImpl: fetchImpl as unknown as typeof fetch, auth })

    await expect(source.pullSince("9000000000")).resolves.toEqual(body)
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `/api/replica/notes?since=${9000000000 - SINCE_OVERLAP_MS}`,
    )

    await source.pullSince("5")
    expect(fetchImpl.mock.calls[1][0]).toBe("/api/replica/notes?since=0")
  })

  it("a 401 refreshes the token once and retries", async () => {
    const body = { nodes: [], links: [], cursor: null }
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const token = (init?.headers as Record<string, string>).Authorization
      return token === "Bearer tok-2" ? jsonResponse(body) : jsonResponse({}, 401)
    })
    const { auth, refresh } = fakeAuth(["tok-1", "tok-2"])
    const source = createD1NoteSource({ fetchImpl: fetchImpl as unknown as typeof fetch, auth })

    await expect(source.pullFull()).resolves.toEqual(body)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("a non-401 failure throws (and is not retried)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500))
    const { auth } = fakeAuth(["tok-1"])
    const source = createD1NoteSource({ fetchImpl: fetchImpl as unknown as typeof fetch, auth })

    await expect(source.pullFull()).rejects.toThrow("Replica pull failed (500)")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("throws without fetching when not signed in", async () => {
    const fetchImpl = vi.fn()
    const source = createD1NoteSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      auth: {
        ensureFreshToken: async () => {},
        getAccessToken: () => undefined,
        withAuthRetry: (operation) => operation(),
      },
    })
    await expect(source.pullFull()).rejects.toThrow("not signed in")
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("expandPendingNodeIds", () => {
  it("expands pending note ids to their full local subtrees", () => {
    const links = [
      link("a", "blk_a1"),
      link("blk_a1", "blk_a2"),
      link("b", "blk_b1"),
      link("shared-source", "blk_a2"),
    ]
    expect(expandPendingNodeIds(new Set(["a"]), links)).toEqual(new Set(["a", "blk_a1", "blk_a2"]))
  })

  it("includes pending pages that have no local rows yet", () => {
    expect(expandPendingNodeIds(new Set(["created"]), [])).toEqual(new Set(["created"]))
  })
})

describe("planPullApplication", () => {
  it("upserts strictly newer remote rows only (per-row LWW)", () => {
    const plan = planPullApplication({
      localNodes: [node("a", 100), node("blk_1", 100)],
      localLinks: [link("a", "blk_1", 100)],
      remoteNodes: [node("a", 100), node("blk_1", 200, "newer")],
      remoteLinks: [link("a", "blk_1", 50, "z9")],
      remoteNodeIds: ["a", "blk_1"],
      remoteLinkKeys: [["a", "blk_1", "child"]],
      pendingNodeIds: new Set(),
    })
    expect(plan.nodes).toEqual([node("blk_1", 200, "newer")])
    expect(plan.links).toEqual([]) // remote link is older — local wins
    expect(plan.deleteNodes).toEqual([])
    expect(plan.deleteLinks).toEqual([])
  })

  it("a full pull is 'everything changed' with its own keys — new rows included", () => {
    const remoteNodes = [node("a", 1), node("fresh", 1)]
    const plan = planPullApplication({
      localNodes: [node("a", 1)],
      localLinks: [],
      remoteNodes,
      remoteLinks: [],
      remoteNodeIds: remoteNodes.map((row) => row.id),
      remoteLinkKeys: [],
      pendingNodeIds: new Set(),
    })
    expect(plan.nodes).toEqual([node("fresh", 1)])
  })

  it("deletes local rows absent from the remote key lists", () => {
    const plan = planPullApplication({
      localNodes: [node("keep", 1), node("gone", 1), node("blk_k", 1)],
      localLinks: [link("keep", "blk_k", 1), link("gone", "blk_k", 1)],
      remoteNodes: [],
      remoteLinks: [],
      remoteNodeIds: ["keep", "blk_k"],
      remoteLinkKeys: [["keep", "blk_k", "child"]],
      pendingNodeIds: new Set(),
    })
    expect(plan.deleteNodes).toEqual(["gone"])
    // gone's own link goes with its node delete; no redundant link delete.
    expect(plan.deleteLinks).toEqual([])
  })

  it("deletes a removed link whose source survives", () => {
    const plan = planPullApplication({
      localNodes: [node("a", 1), node("blk_1", 1)],
      localLinks: [link("a", "blk_1", 1)],
      remoteNodes: [],
      remoteLinks: [],
      remoteNodeIds: ["a", "blk_1"],
      remoteLinkKeys: [],
      pendingNodeIds: new Set(),
    })
    expect(plan.deleteNodes).toEqual([])
    expect(plan.deleteLinks).toEqual([["a", "blk_1", "child"]])
  })

  it("never touches rows owned by pending notes — in either direction", () => {
    const pending = expandPendingNodeIds(new Set(["a", "created"]), [link("a", "blk_a1", 1)])
    const plan = planPullApplication({
      // "created" exists only locally and is queued for push; "a" has a queued
      // local edit the pull would otherwise revert.
      localNodes: [node("a", 1), node("blk_a1", 1), node("created", 1)],
      localLinks: [link("a", "blk_a1", 1)],
      remoteNodes: [node("a", 999), node("blk_a1", 999)],
      remoteLinks: [link("a", "blk_a1", 999, "b0")],
      remoteNodeIds: ["a", "blk_a1"],
      remoteLinkKeys: [],
      pendingNodeIds: pending,
    })
    expect(plan).toEqual({ nodes: [], links: [], deleteNodes: [], deleteLinks: [] })
  })

  it("skips rows whose local copy already matches (equal updated_at)", () => {
    const plan = planPullApplication({
      localNodes: [node("a", 5)],
      localLinks: [link("a", "blk_1", 5)],
      remoteNodes: [node("a", 5)],
      remoteLinks: [link("a", "blk_1", 5)],
      remoteNodeIds: ["a"],
      remoteLinkKeys: [["a", "blk_1", "child"]],
      pendingNodeIds: new Set(),
    })
    expect(plan).toEqual({ nodes: [], links: [], deleteNodes: [], deleteLinks: [] })
  })
})
