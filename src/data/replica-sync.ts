import { getDefaultStore } from "jotai"
import {
  isEmptyGraphDiff,
  linkKeyOf,
  type GraphDiff,
  type LinkKey,
  type LinkRow,
  type NodeRow,
  type ReplicaPutPayload,
  type ReplicaStatusBody,
} from "../../worker/handlers/replica-payload"
import type { NoteId } from "../schema"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"
import { trackReplicaAccess } from "./replica-access"
import {
  storageDiagnosticsAtom,
  type ReplicaDiagnostics,
  type StorageDiagnostics,
} from "./storage-diagnostics"

/**
 * Write-behind replication of the node/link graph into the D1 database behind
 * the Worker (`PUT /api/replica/notes`). Started by the database runtime
 * (`database-mode.ts`); the local store never waits on it — a push failure
 * can only ever produce a diagnostic and a retry, never a blocked or lost
 * local write.
 *
 * Design:
 * - **Row diffs, coalesced + debounced.** Saves hand over the exact row diff
 *   the local store produced (changed nodes + changed links + deletes, never
 *   a whole-note replace); diffs accumulate keyed by row, a push is scheduled
 *   ~2s out, and everything dirty by then coalesces into one request. The
 *   Worker applies rows with per-row last-writer-wins on `updated_at`.
 * - **Flush on hide.** `visibilitychange → hidden` / `pagehide` push
 *   immediately with `fetch keepalive`, so closing or backgrounding the tab
 *   inside the debounce window doesn't strand the last save.
 * - **Chunking.** Full-corpus pushes send all node rows before any link rows
 *   (links reference nodes) in chunks, staying under the Worker body cap and
 *   D1 batch limits. The cursor rides only the final chunk — it means "the
 *   replica reflects local state as of this push".
 * - **Every tab pushes its own writes.** Last-writer-wins per row at the
 *   replica makes concurrent tab pushes safe.
 * - **Auth.** Same-origin fetch so the `gh_refresh` cookie rides along, plus
 *   the current GitHub access token as a Bearer header (`ensureFreshToken` /
 *   `withAuthRetry`; a 401 refreshes once and retries).
 * - **Resilience.** A failed push merges its rows back into the pending diff
 *   (newer queued rows win) and retries with exponential backoff (2s → 60s);
 *   the browser's `online` event short-circuits the wait.
 * - **Cursor.** A monotonic ms-timestamp cursor is sent with each push and
 *   confirmed via `GET /api/replica/status`, which also supplies the remote
 *   row counts — and triggers an automatic full push when the replica is
 *   drastically behind.
 */

const DEBOUNCE_MS = 2_000
const CHUNK_ROWS = 500
const BACKOFF_START_MS = 2_000
const BACKOFF_MAX_MS = 60_000
/** Minimum gap between automatic drastically-behind full pushes. */
const AUTO_FULL_PUSH_COOLDOWN_MS = 5 * 60_000
/** `fetch keepalive` bodies are capped around 64 KB; larger flushes go out as
 * ordinary requests and take their chances with the unload. */
const KEEPALIVE_BODY_LIMIT = 60_000

const INITIAL_REPLICA_DIAGNOSTICS: ReplicaDiagnostics = {
  lastPushAt: null,
  lastPushNotes: 0,
  pendingNotes: 0,
  pendingDeletes: 0,
  fullPushPending: false,
  cursor: null,
  cursorConfirmed: false,
  lastError: null,
  errorCount: 0,
  remote: null,
}

interface ReplicaAuth {
  ensureFreshToken(): Promise<void>
  getAccessToken(): string | undefined
  withAuthRetry<T>(operation: () => Promise<T>): Promise<T>
}

export interface ReplicaSyncOptions {
  /** The current files map (path → content) — local corpus size for the
   * drastically-behind check. */
  getFiles: () => Record<string, string>
  /** Every current row of both tables — the full-push source (the store). */
  getAllRows: () => Promise<{ nodes: NodeRow[]; links: LinkRow[] }>
  /** Injectable for tests; default global fetch (same-origin URLs). */
  fetchImpl?: typeof fetch
  /** Injectable for tests; default the real github-session helpers. */
  auth?: ReplicaAuth
  debounceMs?: number
  chunkRows?: number
  backoffStartMs?: number
  backoffMaxMs?: number
}

export interface ReplicaSyncHandle {
  /** Queue one save's row diff (with the note ids it touched) for replication. */
  notifyGraphChange(noteIds: NoteId[], diff: GraphDiff): void
  /**
   * Note ids with local changes/deletes not yet confirmed pushed (queued or
   * in flight). The pull side consults this before applying a pull, so a
   * remote pull can never clobber a local edit that is still on its way out
   * (last-writer-wins is decided by push order, not pull timing).
   * (Optional so stub handles in tests remain assignable; the real
   * implementation always provides it.)
   */
  pendingNoteIds?(): Set<NoteId>
  /** Queue a full-corpus push (after a repair, or from the Settings action). */
  requestFullPush(): void
  /** Fetch `GET /api/replica/status` into the diagnostics (any tab). */
  refreshRemoteStatus(): void
  stop(): void
  /** Wait for all queued replication work — tests only. */
  flush(): Promise<void>
}

/** Is the replica missing enough pages that only a full push can be trusted to
 * catch it up? (Empty while notes exist locally, or missing more than ~10% of
 * the corpus — lost pushes rather than ordinary write-behind lag.) */
export function isReplicaDrasticallyBehind(localNotes: number, remotePages: number): boolean {
  if (localNotes === 0) return false
  if (remotePages <= 0) return true
  return localNotes - remotePages > Math.max(3, Math.ceil(localNotes * 0.1))
}

const countLocalNotes = (files: Record<string, string>): number => {
  let count = 0
  for (const filepath in files) if (filepath.endsWith(".md")) count += 1
  return count
}

const linkKeyString = (key: LinkKey) => key.join("\x1f")

/** The pending row-diff accumulator: latest row state per key; upserts and
 * deletes cancel each other. */
interface PendingDiff {
  nodes: Map<string, NodeRow>
  links: Map<string, LinkRow>
  deleteNodes: Set<string>
  deleteLinks: Map<string, LinkKey>
}

const emptyPending = (): PendingDiff => ({
  nodes: new Map(),
  links: new Map(),
  deleteNodes: new Set(),
  deleteLinks: new Map(),
})

const pendingIsEmpty = (pending: PendingDiff) =>
  pending.nodes.size === 0 &&
  pending.links.size === 0 &&
  pending.deleteNodes.size === 0 &&
  pending.deleteLinks.size === 0

function mergeDiffInto(pending: PendingDiff, diff: GraphDiff) {
  for (const node of diff.nodes) {
    pending.deleteNodes.delete(node.id)
    pending.nodes.set(node.id, node)
  }
  for (const link of diff.links) {
    const key = linkKeyString(linkKeyOf(link))
    pending.deleteLinks.delete(key)
    pending.links.set(key, link)
  }
  for (const id of diff.deleteNodes) {
    pending.nodes.delete(id)
    pending.deleteNodes.add(id)
  }
  for (const key of diff.deleteLinks) {
    const keyString = linkKeyString(key)
    pending.links.delete(keyString)
    pending.deleteLinks.set(keyString, key)
  }
}

/** Merge a failed push's snapshot back, without clobbering rows queued since. */
function restoreSnapshot(pending: PendingDiff, snapshot: PendingDiff) {
  for (const [id, node] of snapshot.nodes) {
    if (!pending.nodes.has(id) && !pending.deleteNodes.has(id)) pending.nodes.set(id, node)
  }
  for (const [key, link] of snapshot.links) {
    if (!pending.links.has(key) && !pending.deleteLinks.has(key)) pending.links.set(key, link)
  }
  for (const id of snapshot.deleteNodes) {
    if (!pending.nodes.has(id)) pending.deleteNodes.add(id)
  }
  for (const [key, linkKey] of snapshot.deleteLinks) {
    if (!pending.links.has(key)) pending.deleteLinks.set(key, linkKey)
  }
}

/** Start the replication loop. Returns a handle the database runtime drives. */
export function startReplicaSync(options: ReplicaSyncOptions): ReplicaSyncHandle {
  const fetchImpl = options.fetchImpl ?? fetch
  const auth: ReplicaAuth = options.auth ?? { ensureFreshToken, getAccessToken, withAuthRetry }
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS
  const chunkRows = options.chunkRows ?? CHUNK_ROWS
  const backoffStartMs = options.backoffStartMs ?? BACKOFF_START_MS
  const backoffMaxMs = options.backoffMaxMs ?? BACKOFF_MAX_MS

  let pending = emptyPending()
  const dirtyNoteIds = new Set<NoteId>()
  /** Ids snapshotted into a push that has not finished yet (see `pendingNoteIds`). */
  let inFlightNoteIds = new Set<NoteId>()
  let fullPushRequested = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Current retry delay after a failure; null while healthy. */
  let backoffMs: number | null = null
  /** The next push should use `fetch keepalive` (tab going away). */
  let useKeepalive = false
  let lastCursorMs = 0
  let lastSentCursor: string | null = null
  let lastAutoFullPushAt = 0
  /** Serialize all pushes/status fetches; one task's failure never breaks it. */
  let queue: Promise<void> = Promise.resolve()

  function patchDiagnostics(patch: Partial<ReplicaDiagnostics>) {
    const store = getDefaultStore()
    const prev: StorageDiagnostics = store.get(storageDiagnosticsAtom)
    store.set(storageDiagnosticsAtom, {
      ...prev,
      replica: { ...(prev.replica ?? INITIAL_REPLICA_DIAGNOSTICS), ...patch },
    })
  }

  function reportPending() {
    patchDiagnostics({
      pendingNotes: dirtyNoteIds.size,
      pendingDeletes: pending.deleteNodes.size,
      fullPushPending: fullPushRequested,
    })
  }

  function recordError(error: unknown) {
    const store = getDefaultStore()
    const prev = store.get(storageDiagnosticsAtom).replica ?? INITIAL_REPLICA_DIAGNOSTICS
    patchDiagnostics({
      lastError: {
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      },
      errorCount: prev.errorCount + 1,
    })
  }

  const hasWork = () => fullPushRequested || !pendingIsEmpty(pending)

  /** Schedule the next queue tick. Schedule-once: events arriving while a tick
   * is already pending coalesce into it (never postponing it — a steady stream
   * of saves still pushes every `debounceMs`). */
  function schedule(delayMs: number) {
    if (stopped || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      queue = queue.then(runPush).catch(recordError)
    }, delayMs)
  }

  /** Cancel the debounce and push right now (hide/pagehide flush). */
  function flushNow() {
    if (stopped || !hasWork()) return
    useKeepalive = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    schedule(0)
  }

  /** A fetch that authenticates the way the git layer did: proactive refresh,
   * Bearer token + same-origin cookie, refresh-and-retry-once on 401. */
  async function authorizedFetch(doFetch: (token: string) => Promise<Response>): Promise<Response> {
    await auth.ensureFreshToken()
    if (!auth.getAccessToken()) throw new Error("Replica push skipped: not signed in")
    const response = await auth.withAuthRetry(async () => {
      const token = auth.getAccessToken()
      if (!token) throw new Error("Replica push skipped: not signed in")
      const res = await doFetch(token)
      if (res.status === 401) {
        // Shaped so `isAuthError` recognizes it → one refresh + retry.
        throw Object.assign(new Error("Replica request rejected (401)"), { status: 401 })
      }
      return res
    })
    // Surface tenancy refusals (signup_closed/blocked/forbidden) honestly —
    // sticky status the page layout renders (replica-access.ts).
    await trackReplicaAccess(response)
    if (!response.ok) throw new Error(`Replica request failed (${response.status})`)
    return response
  }

  async function putPayload(payload: ReplicaPutPayload, keepalive: boolean): Promise<void> {
    const body = JSON.stringify(payload)
    const response = await authorizedFetch((token) =>
      fetchImpl("/api/replica/notes", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body,
        ...(keepalive && body.length <= KEEPALIVE_BODY_LIMIT ? { keepalive: true } : {}),
      }),
    )
    // Drain the (tiny) body so the connection can be reused.
    await response.json().catch(() => {})
  }

  async function fetchRemoteStatus(): Promise<void> {
    const response = await authorizedFetch((token) =>
      fetchImpl("/api/replica/status", {
        method: "GET",
        credentials: "same-origin",
        headers: { Authorization: `Bearer ${token}` },
      }),
    )
    const body = (await response.json()) as ReplicaStatusBody
    patchDiagnostics({
      remote: {
        pages: body.counts.pages,
        nodes: body.counts.nodes,
        links: body.counts.links,
        cursor: body.replica_cursor,
        fetchedAt: Date.now(),
      },
      cursorConfirmed: lastSentCursor !== null && body.replica_cursor === lastSentCursor,
    })

    // Counts drastically behind → the replica missed pushes (another device,
    // an old bug, a wiped database): schedule a self-healing full push.
    const localNotes = countLocalNotes(options.getFiles())
    const now = Date.now()
    if (
      isReplicaDrasticallyBehind(localNotes, body.counts.pages) &&
      now - lastAutoFullPushAt > AUTO_FULL_PUSH_COOLDOWN_MS
    ) {
      lastAutoFullPushAt = now
      fullPushRequested = true
      reportPending()
      schedule(debounceMs)
    }
  }

  /** Monotonic per-client cursor (ms timestamp, bumped on collision). */
  function nextCursor(): string {
    lastCursorMs = Math.max(Date.now(), lastCursorMs + 1)
    return String(lastCursorMs)
  }

  /** Split rows into payload chunks: every node row precedes every link row
   * (links reference nodes), deletes ride the first chunk, cursor the last. */
  function buildPayloads(
    nodes: NodeRow[],
    links: LinkRow[],
    deleteNodes: string[],
    deleteLinks: LinkKey[],
    cursor: string,
  ): ReplicaPutPayload[] {
    const payloads: ReplicaPutPayload[] = []
    let nodeIndex = 0
    let linkIndex = 0
    do {
      const chunkNodes = nodes.slice(nodeIndex, nodeIndex + chunkRows)
      nodeIndex += chunkNodes.length
      const room = chunkRows - chunkNodes.length
      const chunkLinks = nodeIndex >= nodes.length ? links.slice(linkIndex, linkIndex + room) : []
      linkIndex += chunkLinks.length
      payloads.push({ nodes: chunkNodes, links: chunkLinks })
    } while (nodeIndex < nodes.length || linkIndex < links.length)

    if (deleteNodes.length > 0) payloads[0].deleteNodes = deleteNodes
    if (deleteLinks.length > 0) payloads[0].deleteLinks = deleteLinks
    payloads[payloads.length - 1].cursor = cursor
    return payloads
  }

  async function runPush(): Promise<void> {
    if (stopped || !hasWork()) return

    // Snapshot and clear the pending state; a failure merges it back.
    const wasFullPush = fullPushRequested
    fullPushRequested = false
    const snapshot = pending
    pending = emptyPending()
    const snapshotNoteIds = new Set(dirtyNoteIds)
    dirtyNoteIds.clear()
    inFlightNoteIds = snapshotNoteIds
    const keepalive = useKeepalive
    useKeepalive = false
    reportPending()

    try {
      let nodes = [...snapshot.nodes.values()]
      let links = [...snapshot.links.values()]
      if (wasFullPush) {
        const all = await options.getAllRows()
        nodes = all.nodes
        links = all.links
      }
      const cursor = nextCursor()
      const payloads = buildPayloads(
        nodes,
        links,
        [...snapshot.deleteNodes],
        [...snapshot.deleteLinks.values()],
        cursor,
      )
      for (const payload of payloads) await putPayload(payload, keepalive)

      inFlightNoteIds = new Set()
      lastSentCursor = cursor
      backoffMs = null
      patchDiagnostics({
        lastPushAt: Date.now(),
        lastPushNotes: snapshotNoteIds.size,
        cursor,
        cursorConfirmed: false,
        lastError: null,
      })
      // Confirm the cursor + refresh the remote counts (best-effort).
      await fetchRemoteStatus().catch(recordError)
    } catch (error) {
      // Merge the snapshot back and retry with backoff. Never touches the
      // local store.
      inFlightNoteIds = new Set()
      if (wasFullPush) fullPushRequested = true
      restoreSnapshot(pending, snapshot)
      for (const id of snapshotNoteIds) dirtyNoteIds.add(id)
      reportPending()
      recordError(error)
      backoffMs = backoffMs === null ? backoffStartMs : Math.min(backoffMs * 2, backoffMaxMs)
      schedule(backoffMs)
      return
    }

    // Work that accumulated while pushing gets its own (debounced) tick.
    if (hasWork()) schedule(debounceMs)
  }

  const onOnline = () => {
    if (!hasWork()) return
    // Back online — retry immediately instead of waiting out the backoff.
    backoffMs = null
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    schedule(0)
  }
  const onHidden = () => {
    if (document.visibilityState === "hidden") flushNow()
  }
  const onPageHide = () => flushNow()
  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline)
    window.addEventListener("pagehide", onPageHide)
    document.addEventListener("visibilitychange", onHidden)
  }

  patchDiagnostics({ ...INITIAL_REPLICA_DIAGNOSTICS })

  return {
    notifyGraphChange(noteIds, diff) {
      if (stopped || isEmptyGraphDiff(diff)) return
      mergeDiffInto(pending, diff)
      for (const id of noteIds) dirtyNoteIds.add(id)
      reportPending()
      schedule(debounceMs)
    },
    requestFullPush() {
      if (stopped) return
      fullPushRequested = true
      reportPending()
      schedule(debounceMs)
    },
    pendingNoteIds() {
      return new Set([...dirtyNoteIds, ...inFlightNoteIds])
    },
    refreshRemoteStatus() {
      if (stopped) return
      queue = queue.then(() => fetchRemoteStatus()).catch(recordError)
    },
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline)
        window.removeEventListener("pagehide", onPageHide)
        document.removeEventListener("visibilitychange", onHidden)
      }
    },
    flush() {
      return queue
    },
  }
}
