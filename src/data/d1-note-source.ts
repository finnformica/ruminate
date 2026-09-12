import {
  REPLICA_PROTOCOL_HEADERS,
  emptyGraphDiff,
  linkKeyOf,
  type GraphDiff,
  type LinkKey,
  type LinkRow,
  type NodeRow,
  type ReplicaChangesBody,
  type ReplicaCorpusBody,
} from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"
import { CHILD_KIND } from "./graph"
import { trackReplicaAccess } from "./replica-access"

/**
 * The client half of the corpus pull API (`GET /api/replica/notes`) — the
 * boot + cross-device sync source of database-authoritative mode
 * (docs/graph-storage.md). Pulls the D1 node + link rows behind the Worker,
 * either in full or incrementally via a `since` cursor, using the exact same
 * authenticated-fetch pattern as the push side (`replica-sync.ts`): the
 * same-origin `gh_refresh` cookie rides along, the GitHub access token goes in
 * a Bearer header (`ensureFreshToken` proactively, `withAuthRetry` refreshing
 * once and retrying on 401).
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

export interface D1NoteSource {
  /** The full corpus: every node + link row, plus the replica cursor. */
  pullFull(): Promise<ReplicaCorpusBody>
  /**
   * Rows with a sequence above `cursor`, and the sequence they reach — the
   * same shape as a full pull, with fewer rows. Exact: no overlap window, no
   * clock comparison. Deletions are among those rows, carrying `deleted_at`.
   * A null cursor back means nothing was newer; keep the one you had.
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
    pullFull: async () => {
      const response = await authorizedGet("/api/replica/notes")
      return (await response.json()) as ReplicaCorpusBody
    },

    pullSince: async (cursor) => {
      // Straight through: `cursor` is a server-assigned sequence, so there is
      // nothing to compensate for. It used to be a device timestamp minus a
      // ten-minute skew window (migrations/0005 retired both).
      const response = await authorizedGet(`/api/replica/notes?since=${cursor}`)
      return (await response.json()) as ReplicaChangesBody
    },
  }
}

const linkKeyString = (key: LinkKey) => key.join("\x1f")

/**
 * The node ids "owned" by a set of notes with unpushed local changes: each
 * pending page id plus everything reachable from it over local child links. A
 * pull must not touch these rows in either direction — last-writer-wins is
 * decided by push order at the replica, not by pull timing.
 */
export function expandPendingNodeIds(
  pendingNoteIds: Set<NoteId>,
  localLinks: LinkRow[],
): Set<string> {
  const childrenBySource = new Map<string, string[]>()
  for (const link of localLinks) {
    if (link.kind !== CHILD_KIND) continue
    const list = childrenBySource.get(link.source_id)
    if (list) list.push(link.destination_id)
    else childrenBySource.set(link.source_id, [link.destination_id])
  }
  const pending = new Set<string>()
  const queue = [...pendingNoteIds]
  while (queue.length > 0) {
    const id = queue.pop() as string
    if (pending.has(id)) continue
    pending.add(id)
    queue.push(...(childrenBySource.get(id) ?? []))
  }
  return pending
}

/**
 * Plan how a pull lands in the local store — pure, unit-tested, shared by the
 * full and since pulls (a full pull is just "everything changed").
 * Per-row last-writer-wins:
 *
 * - A remote row lands only when it is strictly newer than the local copy (or
 *   the local copy is missing) — re-applying identical rows is a no-op, so
 *   the overlap window churns nothing.
 * - **A deletion is a row, not an absence.** A deleted row arrives carrying
 *   `deleted_at` and lands like any other change; the store then hides it
 *   from the rollup. There is no deletion-by-absence step any more: it
 *   required every pull to carry the whole corpus's key list, and tombstones
 *   made it redundant (docs/graph-storage.md).
 * - Rows owned by pending notes (see `expandPendingNodeIds`) are NEVER
 *   touched: a queued local edit outruns the pull that would revert it, and a
 *   locally created note that hasn't pushed yet must not be reverted for
 *   being unknown remotely. Links are owned by their source node.
 */
export function planPullApplication(params: {
  localNodes: NodeRow[]
  localLinks: LinkRow[]
  remoteNodes: NodeRow[]
  remoteLinks: LinkRow[]
  /** Node ids with unpushed local changes (pages + their subtrees). */
  pendingNodeIds: Set<string>
}): GraphDiff {
  const { localNodes, localLinks, remoteNodes, remoteLinks, pendingNodeIds } = params
  const plan = emptyGraphDiff()

  const localNodeById = new Map(localNodes.map((node) => [node.id, node]))
  const localLinkByKey = new Map(localLinks.map((link) => [linkKeyString(linkKeyOf(link)), link]))

  for (const node of remoteNodes) {
    if (pendingNodeIds.has(node.id)) continue
    const local = localNodeById.get(node.id)
    if (local && local.updated_at >= node.updated_at) continue
    plan.nodes.push(node)
  }

  for (const link of remoteLinks) {
    if (pendingNodeIds.has(link.source_id)) continue
    const local = localLinkByKey.get(linkKeyString(linkKeyOf(link)))
    if (local && local.updated_at >= link.updated_at) continue
    plan.links.push(link)
  }

  return plan
}
