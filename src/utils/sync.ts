/**
 * Small pure helpers behind the sync state machine's retry/loop-cap logic and
 * the empty-commit guard. Extracted from the machine so they can be unit-tested
 * without interpreting it.
 */

import { Errors } from "isomorphic-git"

/**
 * Max pull→push attempts per sync cycle. A rejected push (someone else pushed
 * first) transitions back to pulling at most this many times before the cycle
 * gives up with an error; the counter resets when a cycle starts fresh
 * (debouncing) or ends (success/error).
 */
export const MAX_SYNC_ATTEMPTS = 3

/** True while another pull→push attempt is still within the per-cycle budget. */
export function canRetrySync(attempts: number): boolean {
  return attempts < MAX_SYNC_ATTEMPTS
}

/**
 * Push rejections that a pull can fix: isomorphic-git's local non-fast-forward
 * check (`PushRejectedError`) and the server-side rejection (`GitPushError`,
 * e.g. the remote moved between our check and the push). Network/auth errors
 * are NOT matched — they surface as sync errors instead of burning retries.
 */
export function isPushRejectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = (error as { code?: unknown }).code
  return code === Errors.PushRejectedError.code || code === Errors.GitPushError.code
}

/**
 * `MergeNotSupportedError`: no single merge base — for us almost always a
 * shallow clone whose history doesn't reach the merge base. Recoverable by
 * deepening the fetch and retrying once.
 */
export function isMergeUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  return (error as { code?: unknown }).code === Errors.MergeNotSupportedError.code
}

/**
 * The git identity to commit with. GitHub's `name` can be null, which older
 * sessions stored as the literal string "null" — fall back to the login so
 * commits never carry a bogus name.
 */
export function gitUserName(user: { name: string | null | undefined; login: string }): string {
  const name = typeof user.name === "string" ? user.name.trim() : ""
  return name && name !== "null" ? name : user.login
}

/**
 * One row of `git.statusMatrix`: [filepath, HEAD status, workdir status, stage
 * status]. HEAD is 0 (absent) or 1 (present); stage is 0 (absent), 1 (same as
 * HEAD), 2 (different from HEAD), 3 (different from HEAD and workdir).
 */
export type StatusRow = [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3]

/** True when the staged (index) state of the row differs from HEAD. */
export function isStagedChange(row: StatusRow): boolean {
  const [, head, , stage] = row
  return head === 1 ? stage !== 1 : stage !== 0
}

/** True when any row has staged changes — i.e. a commit would not be empty. */
export function hasStagedChanges(rows: StatusRow[]): boolean {
  return rows.some(isStagedChange)
}
