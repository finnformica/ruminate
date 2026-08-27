import { afterEach, describe, expect, it, vi } from "vitest"
import {
  broadcastSynced,
  isSyncLeader,
  requestLeaderSync,
  startSyncLeaderElection,
} from "./sync-leader"

/** In-memory BroadcastChannel: delivery to every *other* instance, like the
 * real one. */
class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false

  constructor(readonly name: string) {
    MockBroadcastChannel.instances.push(this)
  }

  postMessage(data: unknown) {
    for (const other of MockBroadcastChannel.instances) {
      if (other === this || other.closed || other.name !== this.name) continue
      other.onmessage?.({ data } as MessageEvent)
    }
  }

  close() {
    this.closed = true
  }
}

/** A LockManager stub where the test controls whether the lock is available
 * and when a queued request is granted. */
function mockLocks({ available }: { available: boolean }) {
  let queued: (() => Promise<void>) | null = null
  const locks = {
    request: vi.fn(
      (name: string, optionsOrCb: unknown, maybeCb?: (lock: unknown) => Promise<unknown>) => {
        const callback = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as (
          lock: unknown,
        ) => Promise<unknown>
        const options = (typeof optionsOrCb === "function" ? {} : optionsOrCb) as {
          ifAvailable?: boolean
        }
        if (options.ifAvailable) {
          return Promise.resolve(callback(available ? { name } : null))
        }
        // Blocking request: held until the test grants it.
        return new Promise((resolve) => {
          queued = async () => {
            await callback({ name })
            resolve(undefined)
          }
        })
      },
    ),
    grantQueued: () => {
      const grant = queued
      queued = null
      void grant?.()
    },
  }
  return locks
}

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
  MockBroadcastChannel.instances = []
  vi.unstubAllGlobals()
})

describe("sync leader election", () => {
  it("fails open (leader) when BroadcastChannel/locks are unavailable", () => {
    vi.stubGlobal("BroadcastChannel", undefined)
    vi.stubGlobal("navigator", {})
    cleanup = startSyncLeaderElection({
      onSyncRequested: vi.fn(),
      onLeaderSynced: vi.fn(),
    })
    expect(isSyncLeader()).toBe(true)
  })

  it("becomes leader when the lock is free and reacts to forwarded sync requests", async () => {
    const locks = mockLocks({ available: true })
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel)
    vi.stubGlobal("navigator", { locks })

    const onSyncRequested = vi.fn()
    const onLeaderSynced = vi.fn()
    cleanup = startSyncLeaderElection({ onSyncRequested, onLeaderSynced })
    await flushMicrotasks()

    expect(isSyncLeader()).toBe(true)

    // A follower tab posts a request-sync — the leader reacts.
    const followerChannel = new MockBroadcastChannel("ruminate-sync")
    followerChannel.postMessage({ type: "request-sync" })
    expect(onSyncRequested).toHaveBeenCalledTimes(1)

    // A "synced" broadcast from elsewhere is ignored by the leader.
    followerChannel.postMessage({ type: "synced" })
    expect(onLeaderSynced).not.toHaveBeenCalled()

    // The leader's own broadcasts reach other tabs.
    const received: unknown[] = []
    followerChannel.onmessage = (event) => received.push(event.data)
    broadcastSynced()
    expect(received).toEqual([{ type: "synced" }])
  })

  it("demotes to follower when the lock is held, forwards syncs, refreshes on 'synced'", async () => {
    const locks = mockLocks({ available: false })
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel)
    vi.stubGlobal("navigator", { locks })

    const onSyncRequested = vi.fn()
    const onLeaderSynced = vi.fn()
    cleanup = startSyncLeaderElection({ onSyncRequested, onLeaderSynced })
    await flushMicrotasks()

    expect(isSyncLeader()).toBe(false)

    // Follower forwards its sync request over the channel.
    const leaderChannel = new MockBroadcastChannel("ruminate-sync")
    const received: unknown[] = []
    leaderChannel.onmessage = (event) => received.push(event.data)
    requestLeaderSync()
    expect(received).toEqual([{ type: "request-sync" }])

    // Follower never broadcasts "synced".
    broadcastSynced()
    expect(received).toEqual([{ type: "request-sync" }])

    // The leader's "synced" broadcast refreshes the follower.
    leaderChannel.postMessage({ type: "synced" })
    expect(onLeaderSynced).toHaveBeenCalledTimes(1)
    // But a request-sync from another tab is the leader's job, not ours.
    leaderChannel.postMessage({ type: "request-sync" })
    expect(onSyncRequested).not.toHaveBeenCalled()
  })

  it("is promoted to leader when the previous leader releases the lock", async () => {
    const locks = mockLocks({ available: false })
    vi.stubGlobal("BroadcastChannel", MockBroadcastChannel)
    vi.stubGlobal("navigator", { locks })

    cleanup = startSyncLeaderElection({ onSyncRequested: vi.fn(), onLeaderSynced: vi.fn() })
    await flushMicrotasks()
    expect(isSyncLeader()).toBe(false)

    // The old leader closes — the queued request is granted.
    locks.grantQueued()
    await flushMicrotasks()
    expect(isSyncLeader()).toBe(true)
  })
})
