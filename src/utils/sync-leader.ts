/**
 * Multi-tab sync coordination: one tab (the *leader*) runs the sync region's
 * network work; the others (followers) forward their sync requests to it and
 * refresh their in-memory notes from the shared worktree when the leader
 * broadcasts that a sync finished.
 *
 * - Leadership = holding the exclusive `ruminate-sync-leader` Web Lock. The
 *   lock is held for the tab's lifetime, so when the leader closes, the next
 *   queued tab is promoted automatically.
 * - Messages ride BroadcastChannel("ruminate-sync"): followers post
 *   `request-sync` (the leader reacts by syncing); the leader posts `synced`
 *   (followers re-walk the shared worktree into memory).
 *
 * Fail-open by design: without BroadcastChannel or navigator.locks (jsdom,
 * old browsers), every tab stays its own leader and behaves exactly as
 * before. A brand-new tab also *starts* as leader until it observes that
 * another tab already holds the lock — a brief overlap of two leaders is safe
 * (the cross-tab git mutex in utils/mutex.ts serializes actual git work), and
 * this way a single tab's very first sync never skips the network.
 */

const SYNC_CHANNEL_NAME = "ruminate-sync"
const LEADER_LOCK_NAME = "ruminate-sync-leader"

type SyncLeaderCallbacks = {
  /** Leader only: another tab asked for a sync (it committed local work). */
  onSyncRequested: () => void
  /** Followers only: the leader finished a sync — refresh from the worktree. */
  onLeaderSynced: () => void
}

let leader = true
let channel: BroadcastChannel | null = null

/** Is this tab currently responsible for the sync network work? */
export function isSyncLeader(): boolean {
  return leader
}

/** Follower → leader: ask the leader tab to run a sync. No-op when this tab is
 * the leader or when coordination is unavailable. */
export function requestLeaderSync() {
  if (leader) return
  channel?.postMessage({ type: "request-sync" })
}

/** Leader → followers: a sync cycle just completed. No-op for followers. */
export function broadcastSynced() {
  if (!leader) return
  channel?.postMessage({ type: "synced" })
}

/**
 * Start leader election + message handling. Returns a cleanup function that
 * releases leadership and closes the channel (used on unmount; in practice the
 * lock is otherwise held until the tab closes).
 */
export function startSyncLeaderElection(callbacks: SyncLeaderCallbacks): () => void {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  if (typeof BroadcastChannel === "undefined" || !locks) {
    // No coordination available — every tab syncs for itself (fail open).
    leader = true
    return () => {}
  }

  let closed = false
  let releaseHold: (() => void) | null = null
  const hold = () =>
    new Promise<void>((resolve) => {
      releaseHold = resolve
    })

  const ownChannel = new BroadcastChannel(SYNC_CHANNEL_NAME)
  channel = ownChannel
  ownChannel.onmessage = (event: MessageEvent) => {
    const type =
      event.data && typeof event.data === "object"
        ? (event.data as { type?: unknown }).type
        : undefined
    if (type === "request-sync" && leader) callbacks.onSyncRequested()
    if (type === "synced" && !leader) callbacks.onLeaderSynced()
  }

  // Try to take the lock immediately. If another tab already holds it, demote
  // to follower and queue a blocking request so this tab is promoted when the
  // current leader closes.
  let tookLock = false
  locks
    .request(LEADER_LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock || closed) return
      tookLock = true
      leader = true
      await hold()
    })
    .then(() => {
      // Resolves immediately when the lock was unavailable (another tab is
      // the leader), or only at release time when this tab took it.
      if (tookLock || closed) return
      leader = false
      return locks.request(LEADER_LOCK_NAME, async () => {
        if (closed) return
        leader = true
        await hold()
      })
    })
    .catch(() => {
      // Locks misbehaving — fail open.
      leader = true
    })

  return () => {
    closed = true
    releaseHold?.()
    leader = true
    ownChannel.close()
    if (channel === ownChannel) channel = null
  }
}
