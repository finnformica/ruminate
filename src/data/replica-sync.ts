import { getDefaultStore } from "jotai"
import { REPLICA_PROTOCOL_HEADERS } from "../../worker/handlers/replica-payload"
import { MAX_KEY_EVENTS_PER_PUT, type KeyEvent, type KeyEventsPutResult } from "./key-events"
import { writerHeaders } from "./writer-identity"
import type { NoteId } from "../schema"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"
import { isBrowserOffline } from "../utils/network"
import { trackReplicaAccess } from "./replica-access"
import {
  storageDiagnosticsAtom,
  type ReplicaDiagnostics,
  type StorageDiagnostics,
} from "./storage-diagnostics"

/**
 * Write-behind replication into the D1 database behind the Worker. Started by
 * the database runtime (`database-mode.ts`); the local store never waits on
 * it — a push failure can only ever produce a diagnostic and a retry, never
 * a blocked or lost local write.
 *
 * Design:
 * - **The queue is the store's log.** Every edit lands in the local store as
 *   the events it amounts to (docs/event-sourcing.md), and the ones the
 *   replica has not acknowledged are the queue (`getUnpushedEvents`): durable
 *   across reloads, with nothing to merge back after a failure. A push sends
 *   them in the order they were made (`PUT /api/replica/events`), and the
 *   response's `seq` per event marks them pushed (`markEventsPushed`).
 * - **Events, and nothing else** (docs/events-log-cache.md, "Sync is the log,
 *   and nothing else"). There is no push of rows and no full push: a repair
 *   rebuilds the device's cache from its own log, and the unpushed tail of
 *   that log is what reaches the replica.
 * - **Debounced.** Saves notify the loop; a push is scheduled ~2s out, and
 *   everything unpushed by then goes in one request.
 * - **Flush on hide.** `visibilitychange → hidden` / `pagehide` push
 *   immediately with `fetch keepalive`, so closing or backgrounding the tab
 *   inside the debounce window doesn't strand the last save.
 * - **Every tab pushes its own writes.** Last-writer-wins per key at the
 *   replica makes concurrent tab pushes safe.
 * - **Auth.** Same-origin fetch so the `gh_refresh` cookie rides along, plus
 *   the current GitHub access token as a Bearer header (`ensureFreshToken` /
 *   `withAuthRetry`; a 401 refreshes once and retries).
 * - **Resilience.** A failed push leaves the events where they were and
 *   retries with exponential backoff (2s → 60s); the browser's `online` event
 *   short-circuits the wait. While the browser says it is offline
 *   (`navigator.onLine === false`) no push is attempted at all — the events
 *   wait for the `online` event, and nothing is recorded as an error, because
 *   nothing failed.
 * - **Cursor.** A monotonic ms-timestamp cursor is sent with each push and
 *   confirmed by the push's own response, which echoes the cursor the batch
 *   committed. No second request: `GET /api/replica/status` is not fetched
 *   here any more (it reads the whole corpus, for counts nothing acts on).
 */

const DEBOUNCE_MS = 2_000
const CHUNK_EVENTS = 500
const BACKOFF_START_MS = 2_000
const BACKOFF_MAX_MS = 60_000
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
  /** The store's unpushed events, oldest first — the queue. */
  getUnpushedEvents: () => Promise<KeyEvent[]>
  /** Stamp pushed events with the `seq` the replica gave each. */
  markEventsPushed: (seqs: readonly (readonly [id: string, seq: number])[]) => Promise<void>
  /** Injectable for tests; default global fetch (same-origin URLs). */
  fetchImpl?: typeof fetch
  /** Injectable for tests; default the real github-session helpers. */
  auth?: ReplicaAuth
  debounceMs?: number
  /** How many events one request carries, at most (`MAX_KEY_EVENTS_PER_PUT`
   * caps it; the replica cuts a run by bytes as well, `planKeyAppend`). */
  chunkEvents?: number
  backoffStartMs?: number
  backoffMaxMs?: number
}

export interface ReplicaSyncHandle {
  /** The store took a write: its events are in the queue. `noteIds` are the
   * notes it touched, for the pull guards below. */
  notifyChange(noteIds: NoteId[]): void
  /**
   * Note ids with local changes/deletes not yet confirmed pushed (queued or
   * in flight). The pull side consults this before applying a pull, so a
   * remote pull can never clobber a local edit that is still on its way out
   * (last-writer-wins is decided by push order, not pull timing).
   * (Optional so stub handles in tests remain assignable; the real
   * implementation always provides it.)
   */
  pendingNoteIds?(): Set<NoteId>
  /** The ids of events in a push that has not finished: the store must not
   * coalesce a typing run into one of these (`NoteStore.applyEvents`), or
   * the replica would hold an event this device's log no longer does. */
  inFlightEventIds?(): Set<string>
  stop(): void
  /** Wait for all queued replication work — tests only. */
  flush(): Promise<void>
}

/** Start the replication loop. Returns a handle the database runtime drives. */
export function startReplicaSync(options: ReplicaSyncOptions): ReplicaSyncHandle {
  const fetchImpl = options.fetchImpl ?? fetch
  const auth: ReplicaAuth = options.auth ?? { ensureFreshToken, getAccessToken, withAuthRetry }
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS
  const chunkEvents = Math.min(options.chunkEvents ?? CHUNK_EVENTS, MAX_KEY_EVENTS_PER_PUT)
  const backoffStartMs = options.backoffStartMs ?? BACKOFF_START_MS
  const backoffMaxMs = options.backoffMaxMs ?? BACKOFF_MAX_MS

  /** Something may be unpushed: a write was notified, or nothing has been
   * checked yet this session (a previous session's leftovers). Cleared when a
   * push finds the queue empty. */
  let queued = true
  const dirtyNoteIds = new Set<NoteId>()
  /** Ids snapshotted into a push that has not finished yet (see `pendingNoteIds`). */
  let inFlightNoteIds = new Set<NoteId>()
  let inFlightEventIds = new Set<string>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Current retry delay after a failure; null while healthy. */
  let backoffMs: number | null = null
  /** The next push should use `fetch keepalive` (tab going away). */
  let useKeepalive = false
  let lastCursorMs = 0
  /** How many deletes the queue held when last read (diagnostics). */
  let queuedDeletes = 0
  /** Serialize all pushes; one task's failure never breaks it. */
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
    patchDiagnostics({ pendingNotes: dirtyNoteIds.size, pendingDeletes: queuedDeletes })
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

  const hasWork = () => queued

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

  /** PUT one JSON body to a replica route, with the writer's headers. */
  async function put(path: string, body: string, keepalive: boolean): Promise<Response> {
    return authorizedFetch((token) =>
      fetchImpl(path, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          ...REPLICA_PROTOCOL_HEADERS,
          ...writerHeaders(),
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body,
        ...(keepalive && body.length <= KEEPALIVE_BODY_LIMIT ? { keepalive: true } : {}),
      }),
    )
  }

  /** Push one run of events; returns what the replica said of them. */
  async function putEvents(
    events: KeyEvent[],
    cursor: string | undefined,
    keepalive: boolean,
  ): Promise<KeyEventsPutResult> {
    const body = JSON.stringify(cursor === undefined ? { events } : { events, cursor })
    const response = await put("/api/replica/events", body, keepalive)
    const result = (await response.json().catch(() => null)) as KeyEventsPutResult | null
    if (!result || !Array.isArray(result.seqs)) {
      throw new Error("Replica answered a push of events without saying what it held")
    }
    return result
  }

  /** Monotonic per-client cursor (ms timestamp, bumped on collision). */
  function nextCursor(): string {
    lastCursorMs = Math.max(Date.now(), lastCursorMs + 1)
    return String(lastCursorMs)
  }

  /** The queue, through the events door, in runs of `chunkEvents`. Returns
   * null when there was nothing to push. */
  async function pushEvents(
    events: KeyEvent[],
    keepalive: boolean,
  ): Promise<{ cursor: string; committed: boolean } | null> {
    if (events.length === 0) return null
    const cursor = nextCursor()
    const seqs: [string, number][] = []
    let committed: string | null = null
    for (let index = 0; index < events.length; index += chunkEvents) {
      const run = events.slice(index, index + chunkEvents)
      const last = index + chunkEvents >= events.length
      const result = await putEvents(run, last ? cursor : undefined, keepalive)
      seqs.push(...result.seqs)
      if (last) committed = result.cursor
    }
    // Acknowledged: stamped in the store, so the next read of the queue no
    // longer holds them. A failure here leaves them queued; the replica
    // ignores a re-sent event by id, so the retry is harmless.
    await options.markEventsPushed(seqs)
    return { cursor, committed: committed === cursor }
  }

  async function runPush(): Promise<void> {
    if (stopped || !hasWork()) return
    // No network, no attempt. The events stay queued (the status reads
    // "Offline", not "Sync failed") and the `online` event pushes them at
    // once; the re-check is a backstop for a flag that flips without one.
    if (isBrowserOffline()) {
      useKeepalive = false
      schedule(backoffMaxMs)
      return
    }

    // Snapshot and clear the pending state; a failure puts it back.
    queued = false
    const snapshotNoteIds = new Set(dirtyNoteIds)
    dirtyNoteIds.clear()
    inFlightNoteIds = snapshotNoteIds
    const keepalive = useKeepalive
    useKeepalive = false

    try {
      const events = await options.getUnpushedEvents()
      queuedDeletes = events.filter((event) => event.action === "delete").length
      inFlightEventIds = new Set(events.map((event) => event.id))
      reportPending()
      const pushed = await pushEvents(events, keepalive)

      inFlightNoteIds = new Set()
      inFlightEventIds = new Set()
      queuedDeletes = 0
      backoffMs = null
      if (pushed !== null) {
        patchDiagnostics({
          lastPushAt: Date.now(),
          lastPushNotes: snapshotNoteIds.size,
          cursor: pushed.cursor,
          cursorConfirmed: pushed.committed,
          lastError: null,
        })
      }
      reportPending()
    } catch (error) {
      // The events are still in the store's queue; put the guards back and
      // retry with backoff. Never touches the local rows.
      inFlightNoteIds = new Set()
      inFlightEventIds = new Set()
      queued = true
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
  // Whatever a previous session left unpushed goes first.
  schedule(debounceMs)

  return {
    notifyChange(noteIds) {
      if (stopped) return
      queued = true
      for (const id of noteIds) dirtyNoteIds.add(id)
      reportPending()
      schedule(debounceMs)
    },
    pendingNoteIds() {
      return new Set([...dirtyNoteIds, ...inFlightNoteIds])
    },
    inFlightEventIds() {
      return new Set(inFlightEventIds)
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
