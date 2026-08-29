import { describe, expect, it, vi } from "vitest"
import type { ReplicaPullNote } from "../../worker/handlers/replica-payload"
import { SINCE_OVERLAP_MS, createD1NoteSource, planPullApplication } from "./d1-note-source"

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

const pullNote = (id: string, content: string, updated_at: number | null = null) => ({
  note: { id, content, updated_at },
  view_state: [] as string[],
})

describe("createD1NoteSource", () => {
  it("pullFull GETs the corpus with cookie credentials and a Bearer token", async () => {
    const body = { notes: [pullNote("a", "- A\n", 1)], cursor: "77" }
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
    const body = { changed: [], ids: [], cursor: "9000000000" }
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
    const body = { notes: [], cursor: null }
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

describe("planPullApplication", () => {
  const base = {
    local: { a: "- old A\n", b: "- B\n", gone: "- deleted remotely\n" },
    localViewStates: { a: ["blk_1"] } as Record<string, string[]>,
    pending: new Set<string>(),
  }

  it("writes changed notes, deletes notes absent from the remote id list", () => {
    const pulled: ReplicaPullNote[] = [pullNote("a", "- new A\n"), pullNote("b", "- B\n")]
    const plan = planPullApplication({
      ...base,
      localViewStates: { a: [], b: [] },
      pulled,
      remoteIds: ["a", "b"],
    })
    expect(plan.notes).toEqual({ a: "- new A\n", gone: null })
    expect(plan.viewStates).toEqual({})
  })

  it("a full pull is 'everything changed' with its own ids — new notes included", () => {
    const pulled: ReplicaPullNote[] = [pullNote("a", "- old A\n"), pullNote("fresh", "- hi\n")]
    const plan = planPullApplication({
      local: { a: "- old A\n" },
      localViewStates: { a: [] },
      pulled,
      remoteIds: pulled.map((entry) => entry.note.id),
      pending: new Set(),
    })
    expect(plan.notes).toEqual({ fresh: "- hi\n" })
  })

  it("applies view-state-only changes without rewriting the note", () => {
    const plan = planPullApplication({
      ...base,
      pulled: [
        { note: { id: "a", content: "- old A\n", updated_at: null }, view_state: ["blk_2"] },
      ],
      remoteIds: ["a", "b", "gone"],
    })
    expect(plan.notes).toEqual({})
    expect(plan.viewStates).toEqual({ a: ["blk_2"] })
  })

  it("never touches pending notes — in either direction", () => {
    const plan = planPullApplication({
      // "created" exists only locally and is queued for push; "a" has a queued
      // local edit the pull would otherwise revert.
      local: { a: "- local edit\n", created: "- brand new\n" },
      localViewStates: {},
      pulled: [pullNote("a", "- remote A\n")],
      remoteIds: ["a"],
      pending: new Set(["a", "created"]),
    })
    expect(plan.notes).toEqual({})
    expect(plan.viewStates).toEqual({})
  })

  it("skips notes whose content and view state already match", () => {
    const plan = planPullApplication({
      local: { a: "- A\n" },
      localViewStates: { a: ["blk_1"] },
      pulled: [{ note: { id: "a", content: "- A\n", updated_at: 5 }, view_state: ["blk_1"] }],
      remoteIds: ["a"],
      pending: new Set(),
    })
    expect(plan.notes).toEqual({})
    expect(plan.viewStates).toEqual({})
  })
})
