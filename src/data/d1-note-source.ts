import {
  REPLICA_PROTOCOL_HEADERS,
  type CachePageBody,
  type CachePageCursor,
} from "../../worker/handlers/replica-payload"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"
import type { LoggedKeyEvent } from "./key-events"
import { trackReplicaAccess } from "./replica-access"

/**
 * The client half of the replica's reads (docs/events-log-cache.md, "Sync
 * is the log, and nothing else"): the per-key log past a seq
 * (`GET /api/replica/events-log`), and — once, for a device whose cache is
 * empty — the replica's cache, page by page (`GET /api/replica/cache`).
 * The same authenticated-fetch pattern as the push side (`replica-sync.ts`):
 * the same-origin `gh_refresh` cookie rides along, the GitHub access token
 * goes in a Bearer header (`ensureFreshToken` proactively, `withAuthRetry`
 * refreshing once and retrying on 401).
 *
 * Pulls are read-only, so unlike pushes they are NOT leader-gated — every tab
 * pulls for itself and converges on the same remote state.
 */

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

/** The body of one page of the log. */
interface EventsPageBody {
  events: LoggedKeyEvent[]
  /** The last event's `seq`, or null when nothing was newer. */
  cursor: number | null
  /** Which database answered (`ReplicaCorpusBody.replica_id`). */
  replica_id?: string
}

export interface D1NoteSource {
  /**
   * One page of the replica's cache of the log, in primary-key order after
   * `after` (the `cursor` the page before answered with; null for the
   * first), at most `limit` rows: what a device whose cache is empty takes
   * before it pulls the log.
   */
  pullCache(after: CachePageCursor | null, limit: number): Promise<CachePageBody>
  /**
   * The tenant's per-key event log past `since` (its own `seq`), oldest
   * first, at most `limit` of them (docs/event-sourcing.md, "Per-key
   * events"): what the device's own log is brought up to date from, and
   * its cache folded from.
   */
  pullEvents(since: number, limit: number): Promise<EventsPageBody>
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
        headers: { ...REPLICA_PROTOCOL_HEADERS, Authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        // Shaped so `isAuthError` recognizes it → one refresh + retry.
        throw Object.assign(new Error("Replica pull rejected (401)"), { status: 401 })
      }
      return res
    })
    // Surface tenancy refusals (signup_closed/blocked/forbidden) honestly —
    // sticky status the page layout renders (replica-access.ts).
    await trackReplicaAccess(response)
    if (!response.ok) throw new Error(`Replica pull failed (${response.status})`)
    return response
  }

  return {
    pullCache: async (after, limit) => {
      const query =
        after === null
          ? `limit=${limit}`
          : `after=${encodeURIComponent(JSON.stringify(after))}&limit=${limit}`
      const response = await authorizedGet(`/api/replica/cache?${query}`)
      return (await response.json()) as CachePageBody
    },

    pullEvents: async (since, limit) => {
      const response = await authorizedGet(`/api/replica/events-log?since=${since}&limit=${limit}`)
      return (await response.json()) as EventsPageBody
    },
  }
}
