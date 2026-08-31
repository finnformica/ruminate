import { atom, getDefaultStore } from "jotai"

/**
 * Sticky "the server refused this account" status for the replica API —
 * the honest-refusal counterpart of `sessionExpiredAtom`
 * (src/utils/github-session.ts).
 *
 * A user turned away by the signup gate (403 `signup_closed`, a `blocked`
 * user, or the legacy `forbidden`/`owner_not_configured` denials —
 * worker/handlers/tenancy.ts) used to experience a working-looking local-only
 * app whose pushes and pulls silently failed into the diagnostics panel. The
 * push and pull fetch paths (`replica-sync.ts`, `d1-note-source.ts`) report
 * every replica response here; a 403 with a tenancy denial sets the status,
 * and any successful replica response clears it (admission is exactly a
 * request starting to succeed). The page layout renders it as a full-width
 * notice.
 *
 * Editing stays fully allowed — the app is local-first, and the push queue's
 * retry loop means everything written while refused syncs automatically if
 * the account is admitted later.
 */

export type ReplicaAccessDenial = "signup_closed" | "blocked" | "forbidden"

/** Null = no known denial. Sticky across retries until a replica request
 * succeeds (or the runtime resets it on sign-out). */
export const replicaAccessDeniedAtom = atom<ReplicaAccessDenial | null>(null)

const DENIALS: Record<string, ReplicaAccessDenial> = {
  signup_closed: "signup_closed",
  blocked: "blocked",
  forbidden: "forbidden",
  owner_not_configured: "forbidden",
}

export function resetReplicaAccess() {
  getDefaultStore().set(replicaAccessDeniedAtom, null)
}

/**
 * Record one replica API response. Call with the response of every push/pull
 * before its ok-check; never throws and never consumes the caller's body (a
 * 403 body is read from a clone).
 */
export async function trackReplicaAccess(response: Response): Promise<void> {
  const store = getDefaultStore()
  if (response.ok) {
    if (store.get(replicaAccessDeniedAtom) !== null) store.set(replicaAccessDeniedAtom, null)
    return
  }
  if (response.status !== 403) return
  let error: unknown
  try {
    error = ((await response.clone().json()) as { error?: unknown } | null)?.error
  } catch {
    return
  }
  const denial = typeof error === "string" ? DENIALS[error] : undefined
  if (denial) store.set(replicaAccessDeniedAtom, denial)
}
