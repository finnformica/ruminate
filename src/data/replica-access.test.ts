import { getDefaultStore } from "jotai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createD1NoteSource } from "./d1-note-source"
import { replicaAccessDeniedAtom, resetReplicaAccess, trackReplicaAccess } from "./replica-access"
import { startReplicaSync } from "./replica-sync"

const store = getDefaultStore()

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const stubAuth = {
  ensureFreshToken: async () => {},
  getAccessToken: () => "tok",
  withAuthRetry: <T>(operation: () => Promise<T>) => operation(),
}

beforeEach(() => resetReplicaAccess())

describe("trackReplicaAccess", () => {
  it("sets the sticky denial for the tenancy 403s and maps legacy denials to forbidden", async () => {
    for (const [error, expected] of [
      ["signup_closed", "signup_closed"],
      ["blocked", "blocked"],
      ["forbidden", "forbidden"],
      ["owner_not_configured", "forbidden"],
    ] as const) {
      resetReplicaAccess()
      await trackReplicaAccess(jsonResponse({ error }, 403))
      expect(store.get(replicaAccessDeniedAtom), error).toBe(expected)
    }
  })

  it("ignores non-tenancy failures (401, 500, unknown 403 bodies)", async () => {
    await trackReplicaAccess(jsonResponse({ error: "unauthenticated" }, 401))
    await trackReplicaAccess(jsonResponse({ error: "kaboom" }, 500))
    await trackReplicaAccess(jsonResponse({ error: "some_new_thing" }, 403))
    await trackReplicaAccess(new Response("not json", { status: 403 }))
    expect(store.get(replicaAccessDeniedAtom)).toBeNull()
  })

  it("is sticky across failures and clears on the next success (admission)", async () => {
    await trackReplicaAccess(jsonResponse({ error: "signup_closed" }, 403))
    await trackReplicaAccess(jsonResponse({ error: "kaboom" }, 500))
    expect(store.get(replicaAccessDeniedAtom)).toBe("signup_closed")
    await trackReplicaAccess(jsonResponse({ ok: true }))
    expect(store.get(replicaAccessDeniedAtom)).toBeNull()
  })

  it("does not consume the caller's response body", async () => {
    const response = jsonResponse({ error: "blocked" }, 403)
    await trackReplicaAccess(response)
    expect(response.bodyUsed).toBe(false)
  })
})

describe("denial plumbing through the real fetch paths", () => {
  it("a refused pull sets the status; an admitted pull clears it", async () => {
    const responses = [
      jsonResponse({ error: "signup_closed" }, 403),
      jsonResponse({ nodes: [], links: [], cursor: null }),
    ]
    const fetchImpl = vi.fn(async () => responses.shift() as Response)
    const source = createD1NoteSource({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      auth: stubAuth,
    })

    await expect(source.pullFull()).rejects.toThrow("403")
    expect(store.get(replicaAccessDeniedAtom)).toBe("signup_closed")

    await source.pullFull()
    expect(store.get(replicaAccessDeniedAtom)).toBeNull()
  })

  it("a refused push sets the status and the queue keeps the rows for retry", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "blocked" }, 403))
    const handle = startReplicaSync({
      getFiles: () => ({}),
      getAllRows: async () => ({ nodes: [], links: [] }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      auth: stubAuth,
      debounceMs: 0,
      backoffStartMs: 60_000,
    })
    try {
      handle.notifyGraphChange(["a"], {
        nodes: [{ id: "a", type: "page", text: "a", props: null, updated_at: 1 }],
        links: [],
        deleteNodes: [],
        deleteLinks: [],
      })
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled())
      await handle.flush()
      expect(store.get(replicaAccessDeniedAtom)).toBe("blocked")
      // Local-first: the write stays queued (retry syncs it after admission).
      expect(handle.pendingNoteIds?.()).toEqual(new Set(["a"]))
    } finally {
      handle.stop()
    }
  })
})
