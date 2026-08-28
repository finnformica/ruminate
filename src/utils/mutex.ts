/**
 * A single exclusive lock serializing every git operation (commit path and
 * pull/push) so the state machine's parallel `change` and `sync` regions can
 * never interleave filesystem/index mutations — lightning-fs's internal lock
 * releases between network round-trips, so a commit could otherwise land in
 * the middle of a pull's merge/checkout.
 *
 * Uses the Web Locks API when available, which also spans tabs (a free partial
 * multi-tab fix). Environments without `navigator.locks` (jsdom/tests) fall
 * back to a trivial in-process promise-chain mutex.
 */

const GIT_LOCK_NAME = "ruminate-git"

/** In-process fallback: a promise chain that runs callbacks one at a time. */
let fallbackTail: Promise<unknown> = Promise.resolve()

function withFallbackLock<T>(callback: () => Promise<T>): Promise<T> {
  const run = fallbackTail.then(callback, callback)
  // Keep the chain alive whether or not the callback rejects.
  fallbackTail = run.catch(() => undefined)
  return run
}

/** Run `callback` while holding the exclusive git lock. */
export function withGitLock<T>(callback: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined
  if (!locks) return withFallbackLock(callback)
  return locks.request(GIT_LOCK_NAME, { mode: "exclusive" }, () => callback()) as Promise<T>
}
