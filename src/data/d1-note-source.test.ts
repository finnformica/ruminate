import { describe, expect, it, vi } from "vitest"
import { REPLICA_PROTOCOL_HEADERS } from "../../worker/handlers/replica-payload"
import { createD1NoteSource } from "./d1-note-source"

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

const page = {
  rows: [
    {
      entity: "block",
      entity_id: "a",
      key: "text",
      value: '"A"',
      hlc: "000000000000001-0000-x",
      seq: 1,
      updated_at: 1,
    },
  ],
  seq: 7,
  cursor: ["block", "a", "text"],
}

describe("createD1NoteSource", () => {
  it("pullCache GETs the first page of the cache with cookie credentials and a Bearer token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(page))
    const { auth } = fakeAuth(["tok-1"])
    const source = createD1NoteSource({ fetchImpl: fetchImpl as unknown as typeof fetch, auth })

    await expect(source.pullCache(null, 20_000)).resolves.toEqual(page)
    expect(fetchImpl).toHaveBeenCalledWith("/api/replica/cache?limit=20000", {
      method: "GET",
      credentials: "same-origin",
      headers: { ...REPLICA_PROTOCOL_HEADERS, Authorization: "Bearer tok-1" },
    })
  })

  it("pullCache asks for the next page after the cursor the last one answered with", async () => {
    const fetchImpl = vi.fn(async (_url: string) => jsonResponse({ ...page, cursor: null }))
    const { auth } = fakeAuth(["tok-1"])
    const source = createD1NoteSource({ fetchImpl: fetchImpl as unknown as typeof fetch, auth })

    const next = await source.pullCache(["link", "a|b|child", "sort_key"], 500)
    expect(next.cursor).toBeNull()
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `/api/replica/cache?after=${encodeURIComponent('["link","a|b|child","sort_key"]')}&limit=500`,
    )
  })

  it("pullEvents asks for the per-key log past a seq, bounded", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ events: [{ id: "evt_1", seq: 7 }], cursor: 7, replica_id: "production" }),
    )
    const { auth } = fakeAuth(["tok-1"])
    const source = createD1NoteSource({ fetchImpl: fetchImpl as unknown as typeof fetch, auth })
    const body = await source.pullEvents(6, 500)
    expect(fetchImpl).toHaveBeenCalledWith("/api/replica/events-log?since=6&limit=500", {
      method: "GET",
      credentials: "same-origin",
      headers: { ...REPLICA_PROTOCOL_HEADERS, Authorization: "Bearer tok-1" },
    })
    expect(body.cursor).toBe(7)
    expect(body.events).toHaveLength(1)
    expect(body.replica_id).toBe("production")
  })

  it("a 401 refreshes the token once and retries", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const token = (init?.headers as Record<string, string>).Authorization
      return token === "Bearer tok-2" ? jsonResponse(page) : jsonResponse({}, 401)
    })
    const { auth, refresh } = fakeAuth(["tok-1", "tok-2"])
    const source = createD1NoteSource({ fetchImpl: fetchImpl as unknown as typeof fetch, auth })

    await expect(source.pullCache(null, 20_000)).resolves.toEqual(page)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("a non-401 failure throws (and is not retried)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500))
    const { auth } = fakeAuth(["tok-1"])
    const source = createD1NoteSource({ fetchImpl: fetchImpl as unknown as typeof fetch, auth })

    await expect(source.pullEvents(0, 2_000)).rejects.toThrow("Replica pull failed (500)")
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
    await expect(source.pullCache(null, 20_000)).rejects.toThrow("not signed in")
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
