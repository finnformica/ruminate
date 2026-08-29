import type {
  ReplicaChangesBody,
  ReplicaCorpusBody,
  ReplicaPullNote,
} from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"

/**
 * The client half of the corpus pull API (`GET /api/replica/notes`) — the
 * boot + cross-device sync source of database-authoritative mode
 * (docs/graph-storage.md). Pulls the D1 corpus behind the Worker, either in
 * full or incrementally via a `since` cursor, using the exact same
 * authenticated-fetch pattern as the push side (`replica-sync.ts`): the
 * same-origin `gh_refresh` cookie rides along, the GitHub access token goes in
 * a Bearer header (`ensureFreshToken` proactively, `withAuthRetry` refreshing
 * once and retrying on 401).
 *
 * Pulls are read-only, so unlike pushes they are NOT leader-gated — every tab
 * pulls for itself and converges on the same remote state.
 */

/** How far the since-pull reaches back behind the stored cursor. The server
 * compares `notes.updated_at` (a client-stamped save time) against the cursor
 * (minted on a possibly different device), so a slack window absorbs modest
 * clock skew; re-applying an unchanged note is idempotent, so overlap is
 * cheap. Changes missed beyond this window are caught by a full pull. */
export const SINCE_OVERLAP_MS = 10 * 60_000

interface D1NoteSourceAuth {
  ensureFreshToken(): Promise<void>
  getAccessToken(): string | undefined
  withAuthRetry<T>(operation: () => Promise<T>): Promise<T>
}

export interface D1NoteSourceOptions {
  /** Injectable for tests; default global fetch (same-origin URLs). */
  fetchImpl?: typeof fetch
  /** Injectable for tests; default the real github-session helpers. */
  auth?: D1NoteSourceAuth
}

export interface D1NoteSource {
  /** The full corpus: every note row + view state, plus the replica cursor. */
  pullFull(): Promise<ReplicaCorpusBody>
  /**
   * Changes since `cursor` (minus the overlap window), plus the full remote
   * id list for deletion detection and the new cursor.
   */
  pullSince(cursor: string): Promise<ReplicaChangesBody>
}

export function createD1NoteSource(options: D1NoteSourceOptions = {}): D1NoteSource {
  const fetchImpl = options.fetchImpl ?? fetch
  const auth = options.auth ?? { ensureFreshToken, getAccessToken, withAuthRetry }

  /** Same auth dance as the push side: proactive refresh, Bearer + cookie,
   * refresh-and-retry-once on 401. */
  async function authorizedGet(url: string): Promise<Response> {
    await auth.ensureFreshToken()
    if (!auth.getAccessToken()) throw new Error("Replica pull skipped: not signed in")
    const response = await auth.withAuthRetry(async () => {
      const token = auth.getAccessToken()
      if (!token) throw new Error("Replica pull skipped: not signed in")
      const res = await fetchImpl(url, {
        method: "GET",
        credentials: "same-origin",
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        // Shaped so `isAuthError` recognizes it → one refresh + retry.
        throw Object.assign(new Error("Replica pull rejected (401)"), { status: 401 })
      }
      return res
    })
    if (!response.ok) throw new Error(`Replica pull failed (${response.status})`)
    return response
  }

  return {
    pullFull: async () => {
      const response = await authorizedGet("/api/replica/notes")
      return (await response.json()) as ReplicaCorpusBody
    },

    pullSince: async (cursor) => {
      const since = Math.max(0, Number(cursor) - SINCE_OVERLAP_MS)
      const response = await authorizedGet(`/api/replica/notes?since=${since}`)
      return (await response.json()) as ReplicaChangesBody
    },
  }
}

/** The store writes one pull application boils down to. */
export interface PullApplication {
  /** Note contents to write (`null` deletes) — remote wins, minus `pending`. */
  notes: Record<NoteId, string | null>
  /** Per-note collapsed sets to persist for the written notes. */
  viewStates: Record<NoteId, string[]>
}

/**
 * Plan how a pull lands in the local store — pure, unit-tested, shared by the
 * full and since pulls (a full pull is just "everything changed" with
 * `ids` = the pulled set).
 *
 * - A pulled note whose content matches the local copy is skipped entirely
 *   (its view state too — pulls should not churn the store or the UI).
 * - A local note absent from `ids` was deleted remotely → delete it locally.
 * - `pending` ids (queued or in-flight local pushes) are NEVER touched, in
 *   either direction: a queued local edit outruns the pull that would revert
 *   it, and a locally created note that hasn't pushed yet must not be
 *   "deleted" for being unknown remotely. Last-writer-wins is decided by push
 *   order at the replica, not by pull timing.
 */
export function planPullApplication(params: {
  local: Record<NoteId, string>
  localViewStates: Record<NoteId, string[]>
  pulled: ReplicaPullNote[]
  /** Every remote note id (full pulls: the pulled ids themselves). */
  remoteIds: string[]
  /** Note ids with unpushed local changes (see `ReplicaSyncHandle.pendingNoteIds`). */
  pending: Set<NoteId>
}): PullApplication {
  const { local, localViewStates, pulled, remoteIds, pending } = params
  const notes: Record<NoteId, string | null> = {}
  const viewStates: Record<NoteId, string[]> = {}

  for (const entry of pulled) {
    const id = entry.note.id
    if (pending.has(id)) continue
    const sameContent = local[id] === entry.note.content
    const sameViewState = sameIdSet(localViewStates[id] ?? [], entry.view_state)
    if (sameContent && sameViewState) continue
    if (!sameContent) notes[id] = entry.note.content
    if (!sameViewState) viewStates[id] = entry.view_state
  }

  const remote = new Set(remoteIds)
  for (const id of Object.keys(local)) {
    if (remote.has(id) || pending.has(id)) continue
    notes[id] = null
  }

  return { notes, viewStates }
}

const sameIdSet = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((id) => setA.has(id))
}
