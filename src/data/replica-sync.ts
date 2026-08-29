import { getDefaultStore } from "jotai"
import type {
  ReplicaNoteEntry,
  ReplicaPutPayload,
  ReplicaStatusBody,
} from "../../worker/handlers/replica-payload"
import { parse } from "../blocks/parse"
import type { NoteId } from "../schema"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"
import { isSyncLeader } from "../utils/sync-leader"
import { docToRows, frontmatterUpdatedAt } from "./doc-to-rows"
import {
  storageDiagnosticsAtom,
  type ReplicaDiagnostics,
  type StorageDiagnostics,
} from "./storage-mirror"
import { readNoteViewState } from "./view-state-parse"

/**
 * Write-behind replication of the note graph into the D1 database behind the
 * Worker (`PUT /api/replica/notes` — graph storage, phase 3). Started by the
 * storage mirror while the "database store" flag is on; git/markdown remains
 * canonical and the replica is derived — a push failure never blocks (or even
 * reaches) the local write path.
 *
 * Design:
 * - **Dirty-set + debounce.** Mirror writes and reconciles mark note ids dirty;
 *   a push is scheduled ~2s out and everything dirty by then coalesces into one
 *   push. Work arriving mid-push is picked up by the next tick.
 * - **Chunking.** Full-corpus pushes are split into chunks of ~50 notes so a
 *   single request stays well under the Worker's body cap and D1's batch
 *   limits. The cursor rides only the final chunk — it means "the replica
 *   reflects local state as of this push", which is only true once every chunk
 *   has landed.
 * - **Leader-only.** Only the sync-leader tab (`utils/sync-leader.ts`) talks to
 *   the network; follower tabs keep accumulating dirty ids and re-check on an
 *   interval in case they get promoted. (Follower edits also reach the leader
 *   tab through the ordinary git sync, whose verify pass marks them dirty
 *   there — this is the main replication path for multi-tab use.)
 * - **Auth.** Same-origin fetch so the `gh_refresh` cookie rides along, plus
 *   the current GitHub access token as a Bearer header — obtained and
 *   refreshed exactly like the git layer does (`ensureFreshToken` /
 *   `withAuthRetry` from `utils/github-session.ts`; a 401 refreshes once and
 *   retries).
 * - **Resilience.** A failed push puts its notes back in the dirty set and
 *   retries with exponential backoff (2s → 60s); the browser's `online` event
 *   short-circuits the wait. Failures are recorded in the storage diagnostics.
 * - **Cursor.** A monotonic ms-timestamp cursor is sent with each push and
 *   confirmed via `GET /api/replica/status`, which also supplies the remote
 *   row counts for the Settings panel — and triggers an automatic full push
 *   when the replica is drastically behind.
 */

const DEBOUNCE_MS = 2_000
const CHUNK_SIZE = 50
const BACKOFF_START_MS = 2_000
const BACKOFF_MAX_MS = 60_000
/** How often a follower tab with pending work re-checks for leadership. */
const FOLLOWER_RECHECK_MS = 30_000
/** Minimum gap between automatic drastically-behind full pushes. */
const AUTO_FULL_PUSH_COOLDOWN_MS = 5 * 60_000

const INITIAL_REPLICA_DIAGNOSTICS: ReplicaDiagnostics = {
  leader: true,
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
  /** Current repo files (path → content) — git is what gets replicated. */
  getFiles: () => Record<string, string>
  /** Injectable for tests; default global fetch (same-origin URLs). */
  fetchImpl?: typeof fetch
  /** Injectable for tests; default `isSyncLeader`. */
  isLeader?: () => boolean
  /** Injectable for tests; default the real github-session helpers. */
  auth?: ReplicaAuth
  debounceMs?: number
  chunkSize?: number
  backoffStartMs?: number
  backoffMaxMs?: number
}

export interface ReplicaSyncHandle {
  /** Queue notes for replication (content read from git at push time). */
  notifyNotesChanged(ids: NoteId[]): void
  /** Queue note deletions for replication. */
  notifyNotesDeleted(ids: NoteId[]): void
  /** Queue a full-corpus push (after ingest, or from the Settings action). */
  requestFullPush(): void
  /** Fetch `GET /api/replica/status` into the diagnostics (any tab). */
  refreshRemoteStatus(): void
  stop(): void
  /** Wait for all queued replication work — tests only. */
  flush(): Promise<void>
}

/**
 * Build one note's replica entry from the repo file map — the client half of
 * the wire format `parseReplicaPayload` accepts on the Worker. Rows come from
 * the same `docToRows` transform the local SQL store ingests through, so the
 * replica and the local store can never derive different graphs. Returns null
 * when the note does not exist (it belongs in `deletes` instead).
 */
export function buildReplicaNoteEntry(
  files: Record<string, string>,
  id: NoteId,
): ReplicaNoteEntry | null {
  const content = files[`${id}.md`]
  if (content === undefined) return null
  const { blocks, links } = docToRows(id, parse(content))
  return {
    note: { id, content, updated_at: frontmatterUpdatedAt(content) },
    blocks,
    links,
    view_state: readNoteViewState(files, id),
  }
}

/** Is the replica missing enough notes that only a full push can be trusted to
 * catch it up? (Empty while notes exist locally, or missing more than ~10% of
 * the corpus — lost pushes rather than ordinary write-behind lag.) */
export function isReplicaDrasticallyBehind(localNotes: number, remoteNotes: number): boolean {
  if (localNotes === 0) return false
  if (remoteNotes <= 0) return true
  return localNotes - remoteNotes > Math.max(3, Math.ceil(localNotes * 0.1))
}

/** All note ids present in the repo file map. */
function noteIdsFromFiles(files: Record<string, string>): NoteId[] {
  const ids: NoteId[] = []
  for (const filepath in files) {
    if (filepath.endsWith(".md")) ids.push(filepath.replace(/\.md$/, ""))
  }
  return ids
}

/** Start the replication loop. Returns a handle the storage mirror drives. */
export function startReplicaSync(options: ReplicaSyncOptions): ReplicaSyncHandle {
  const fetchImpl = options.fetchImpl ?? fetch
  const isLeader = options.isLeader ?? isSyncLeader
  const auth: ReplicaAuth = options.auth ?? { ensureFreshToken, getAccessToken, withAuthRetry }
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS
  const chunkSize = options.chunkSize ?? CHUNK_SIZE
  const backoffStartMs = options.backoffStartMs ?? BACKOFF_START_MS
  const backoffMaxMs = options.backoffMaxMs ?? BACKOFF_MAX_MS

  const dirtyNotes = new Set<NoteId>()
  const dirtyDeletes = new Set<NoteId>()
  let fullPushRequested = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Current retry delay after a failure; null while healthy. */
  let backoffMs: number | null = null
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
      pendingNotes: dirtyNotes.size,
      pendingDeletes: dirtyDeletes.size,
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

  const hasWork = () => fullPushRequested || dirtyNotes.size > 0 || dirtyDeletes.size > 0

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

  /** A fetch that authenticates the way the git layer does: proactive refresh,
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
    if (!response.ok) throw new Error(`Replica request failed (${response.status})`)
    return response
  }

  async function putPayload(payload: ReplicaPutPayload): Promise<void> {
    const response = await authorizedFetch((token) =>
      fetchImpl("/api/replica/notes", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
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
        notes: body.counts.notes,
        blocks: body.counts.blocks,
        links: body.counts.links,
        viewState: body.counts.view_state,
        cursor: body.replica_cursor,
        fetchedAt: Date.now(),
      },
      cursorConfirmed: lastSentCursor !== null && body.replica_cursor === lastSentCursor,
    })

    // Counts drastically behind → the replica missed pushes (another device,
    // an old bug, a wiped database): schedule a self-healing full push.
    const localNotes = noteIdsFromFiles(options.getFiles()).length
    const now = Date.now()
    if (
      isLeader() &&
      isReplicaDrasticallyBehind(localNotes, body.counts.notes) &&
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

  async function runPush(): Promise<void> {
    if (stopped || !hasWork()) return
    if (!isLeader()) {
      // Keep the pending work; re-check in case this tab gets promoted. The
      // normal path is that the leader tab replicates these notes itself once
      // git sync lands them there.
      patchDiagnostics({ leader: false })
      reportPending()
      schedule(FOLLOWER_RECHECK_MS)
      return
    }
    patchDiagnostics({ leader: true })

    // Snapshot and clear the dirty state; a failure puts it back.
    const files = options.getFiles()
    const wasFullPush = fullPushRequested
    fullPushRequested = false
    const snapshotNotes = wasFullPush ? noteIdsFromFiles(files) : [...dirtyNotes]
    const snapshotDeletes = new Set(dirtyDeletes)
    // A dirty note that no longer exists in git was deleted before we pushed.
    for (const id of snapshotNotes) {
      if (files[`${id}.md`] === undefined) snapshotDeletes.add(id)
    }
    dirtyNotes.clear()
    dirtyDeletes.clear()
    reportPending()

    try {
      const entries: ReplicaNoteEntry[] = []
      for (const id of snapshotNotes) {
        const entry = buildReplicaNoteEntry(files, id)
        if (entry) entries.push(entry)
      }
      const chunks: ReplicaNoteEntry[][] = []
      for (let i = 0; i < entries.length; i += chunkSize) {
        chunks.push(entries.slice(i, i + chunkSize))
      }
      if (chunks.length === 0) chunks.push([]) // deletes/cursor-only push

      const cursor = nextCursor()
      for (let i = 0; i < chunks.length; i++) {
        const payload: ReplicaPutPayload = { notes: chunks[i] }
        if (i === 0 && snapshotDeletes.size > 0) payload.deletes = [...snapshotDeletes]
        if (i === chunks.length - 1) payload.cursor = cursor
        await putPayload(payload)
      }

      lastSentCursor = cursor
      backoffMs = null
      patchDiagnostics({
        lastPushAt: Date.now(),
        lastPushNotes: entries.length,
        cursor,
        cursorConfirmed: false,
        lastError: null,
      })
      // Confirm the cursor + refresh the remote counts (best-effort).
      await fetchRemoteStatus().catch(recordError)
    } catch (error) {
      // Put the snapshot back and retry with backoff. Never touches git.
      if (wasFullPush) fullPushRequested = true
      else for (const id of snapshotNotes) dirtyNotes.add(id)
      for (const id of snapshotDeletes) dirtyDeletes.add(id)
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
  if (typeof window !== "undefined") window.addEventListener("online", onOnline)

  patchDiagnostics({ ...INITIAL_REPLICA_DIAGNOSTICS, leader: isLeader() })

  return {
    notifyNotesChanged(ids) {
      if (stopped || ids.length === 0) return
      for (const id of ids) {
        dirtyNotes.add(id)
        dirtyDeletes.delete(id)
      }
      reportPending()
      schedule(debounceMs)
    },
    notifyNotesDeleted(ids) {
      if (stopped || ids.length === 0) return
      for (const id of ids) {
        dirtyDeletes.add(id)
        dirtyNotes.delete(id)
      }
      reportPending()
      schedule(debounceMs)
    },
    requestFullPush() {
      if (stopped) return
      fullPushRequested = true
      reportPending()
      schedule(debounceMs)
    },
    refreshRemoteStatus() {
      if (stopped) return
      queue = queue.then(() => fetchRemoteStatus()).catch(recordError)
    },
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline)
    },
    flush() {
      return queue
    },
  }
}
