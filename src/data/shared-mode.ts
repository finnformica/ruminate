import { atom, getDefaultStore } from "jotai"
import { NOTE_TYPE, buildGraphSnapshot, type GraphSnapshot } from "./graph"
import type { NodeRow } from "../../worker/handlers/replica-payload"
import type { Op } from "./ops"
import { listShares, pullShare, type ReceivedShareSummary } from "./shares"

/**
 * The shared runtime (docs/sharing.md): the notes other people have shared
 * with the signed-in user, held in memory beside their own corpus.
 *
 * A share is a **view** of a slice of someone else's partition, computed by
 * the Worker on every request. Nothing about it belongs in the local SQL
 * store — that store is a cache of the user's OWN partition, owner-bound and
 * replicated back to it — so a slice lives here, as a `GraphSnapshot` per
 * share, fetched whole:
 *
 *   boot    list the shares addressed to me → pull each slice → publish
 *   sync    the same ambient triggers the replica pull uses (visibility,
 *           focus, online) re-pull every slice, coalesced
 *
 * Shares are read-only: the write seam (`store.ts`) refuses a batch of ops
 * that names a shared node, so nothing here ever pushes.
 *
 * **A shared block is a note here.** A root may be a block (shared from its
 * right-click menu), and a block has no page of its own to open. The slice
 * arrives as the owner's rows; on the way into the snapshot a root that is
 * not a note is given the note type, so it lists in the sidebar, opens at
 * `/notes/<id>` with its text as the title and its children as the outline,
 * and searches like any note. Nothing is pushed, so the owner's row is never
 * touched by it.
 *
 * **Whole-slice pulls, deliberately.** A since-cursor cannot describe a
 * slice: a block leaves it by being UNLINKED (a change to a link row, not to
 * the block), and a since-pull scoped to the closure would never mention a
 * row that is no longer in the closure. A slice is small — a handful of
 * notes — so pulling it whole is cheap and always right.
 *
 * **How the UI sees it.** `sharedGraphAtom` is the union of every slice, and
 * `graphSnapshotAtom` (global-state.ts) merges it with the user's own graph,
 * so the editor, search, hover cards and the notes list read shared notes
 * exactly as they read the user's own. `sharedOriginAtom` says which share a
 * node came from, which is how the write seam tells a shared node from an
 * own one, and how the sidebar groups shared notes under their owner.
 */

const EMPTY: GraphSnapshot = buildGraphSnapshot([], [])
const EMPTY_ORIGIN: ReadonlyMap<string, string> = new Map()

/** Every received slice, as one graph. Empty signed out or with no shares. */
export const sharedGraphAtom = atom<GraphSnapshot>(EMPTY)

/** Node id → the id of the share it came from. */
export const sharedOriginAtom = atom<ReadonlyMap<string, string>>(EMPTY_ORIGIN)

/** The shares addressed to me, as the server describes them. */
export const receivedSharesAtom = atom<ReceivedShareSummary[]>([])

/**
 * The address shares reach me at, as the server has it recorded
 * (`users.email`) — not the copy the sign-in left in localStorage. Null
 * until the first refresh lands.
 */
export const recordedEmailAtom = atom<string | null>(null)

export interface SharedModeStatus {
  status: "off" | "loading" | "ready" | "error"
  lastError: string | null
}

const OFF_STATUS: SharedModeStatus = { status: "off", lastError: null }

export const sharedModeStatusAtom = atom<SharedModeStatus>(OFF_STATUS)

/** Minimum gap between ambient re-pulls (same reasoning as the replica's). */
const AMBIENT_REFRESH_MS = 30_000

interface Slice {
  share: ReceivedShareSummary
  graph: GraphSnapshot
}

interface SharedRuntime {
  slices: Map<string, Slice>
  refreshTimer: ReturnType<typeof setTimeout> | null
  lastRefreshAt: number
  refreshing: Promise<void> | null
  fetchImpl: typeof fetch | undefined
}

let runtime: SharedRuntime | null = null

const jotai = () => getDefaultStore()

// -----------------------------------------------------------------------------
// Pure helpers (unit-tested)
// -----------------------------------------------------------------------------

/**
 * Two snapshots as one. Ids are minted at random on every device, so the
 * user's own rows and a slice of someone else's cannot share one; where they
 * ever did, `b` wins, which keeps the merge a pure function of its inputs.
 */
export function mergeSnapshots(a: GraphSnapshot, b: GraphSnapshot): GraphSnapshot {
  if (b.nodes.size === 0 && b.childLinks.size === 0) return a
  if (a.nodes.size === 0 && a.childLinks.size === 0) return b
  return {
    nodes: new Map([...a.nodes, ...b.nodes]),
    childLinks: new Map([...a.childLinks, ...b.childLinks]),
  }
}

/** Does a batch of ops name a node that came from a share? A `create` names
 * a node no origin knows yet, so it never does on its own. */
export function touchesShared(ops: readonly Op[], origin: ReadonlyMap<string, string>): boolean {
  if (origin.size === 0) return false
  for (const op of ops) {
    if (op.op === "create") continue
    if (op.op === "link" || op.op === "unlink") {
      if (origin.has(op.source) || origin.has(op.destination)) return true
    } else if (origin.has(op.id)) return true
  }
  return false
}

/** The slice's rows with every root that is a block presented as a note. */
export function asNotes(nodes: NodeRow[], rootIds: readonly string[]): NodeRow[] {
  const roots = new Set(rootIds)
  return nodes.map((node) =>
    roots.has(node.id) && node.type !== NOTE_TYPE ? { ...node, type: NOTE_TYPE } : node,
  )
}

// -----------------------------------------------------------------------------
// Publishing
// -----------------------------------------------------------------------------

function publish(activation: SharedRuntime) {
  if (runtime !== activation) return
  let graph = EMPTY
  const origin = new Map<string, string>()
  for (const [shareId, slice] of activation.slices) {
    graph = mergeSnapshots(graph, slice.graph)
    for (const id of slice.graph.nodes.keys()) origin.set(id, shareId)
  }
  const store = jotai()
  store.set(sharedGraphAtom, graph)
  store.set(sharedOriginAtom, origin)
  store.set(
    receivedSharesAtom,
    [...activation.slices.values()].map((slice) => slice.share),
  )
}

function patchStatus(patch: Partial<SharedModeStatus>) {
  const store = jotai()
  store.set(sharedModeStatusAtom, { ...store.get(sharedModeStatusAtom), ...patch })
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

export interface SharedModeOptions {
  /** Injectable for tests; default global fetch. */
  fetchImpl?: typeof fetch
}

/** Start the shared runtime. Idempotent per activation. */
export function startSharedMode(options: SharedModeOptions = {}) {
  if (runtime) return
  const activation: SharedRuntime = {
    slices: new Map(),
    refreshTimer: null,
    lastRefreshAt: 0,
    refreshing: null,
    fetchImpl: options.fetchImpl,
  }
  runtime = activation
  jotai().set(sharedModeStatusAtom, { status: "loading", lastError: null })
  void refresh(activation)
}

/** Stop the runtime: shared notes disappear from the graph at once. */
export function stopSharedMode() {
  const stopped = runtime
  if (!stopped) return
  runtime = null
  if (stopped.refreshTimer !== null) clearTimeout(stopped.refreshTimer)
  const store = jotai()
  store.set(sharedGraphAtom, EMPTY)
  store.set(sharedOriginAtom, EMPTY_ORIGIN)
  store.set(receivedSharesAtom, [])
  store.set(recordedEmailAtom, null)
  store.set(sharedModeStatusAtom, OFF_STATUS)
}

// -----------------------------------------------------------------------------
// Pulls
// -----------------------------------------------------------------------------

/** Re-list my shares and re-pull every slice — now. For deliberate acts (a
 * share was just created or revoked in Settings, the sync button). */
export function requestSharesRefresh(): Promise<void> {
  const activation = runtime
  if (!activation) return Promise.resolve()
  if (activation.refreshTimer !== null) {
    clearTimeout(activation.refreshTimer)
    activation.refreshTimer = null
  }
  return refresh(activation)
}

/** Re-pull from an ambient trigger (visibility, focus, online), coalescing
 * bursts to one refresh per `AMBIENT_REFRESH_MS`. */
export function requestAmbientSharesRefresh() {
  const activation = runtime
  if (!activation || activation.refreshTimer !== null) return
  const wait = AMBIENT_REFRESH_MS - (Date.now() - activation.lastRefreshAt)
  if (wait <= 0) {
    void refresh(activation)
    return
  }
  activation.refreshTimer = setTimeout(() => {
    activation.refreshTimer = null
    if (runtime === activation) void refresh(activation)
  }, wait)
}

function refresh(activation: SharedRuntime): Promise<void> {
  if (activation.refreshing) return activation.refreshing
  activation.lastRefreshAt = Date.now()
  const run = pullAll(activation).finally(() => {
    if (activation.refreshing === run) activation.refreshing = null
  })
  activation.refreshing = run
  return run
}

async function pullAll(activation: SharedRuntime): Promise<void> {
  try {
    const { received, me } = await listShares(activation.fetchImpl)
    if (runtime !== activation) return
    jotai().set(recordedEmailAtom, me.email)
    const next = new Map<string, Slice>()
    await Promise.all(
      received.map(async (share) => {
        const rows = await pullShare(share.id, activation.fetchImpl)
        next.set(share.id, {
          share,
          graph: buildGraphSnapshot(asNotes(rows.nodes, share.rootIds), rows.links),
        })
      }),
    )
    if (runtime !== activation) return
    activation.slices = next
    publish(activation)
    patchStatus({ status: "ready", lastError: null })
  } catch (error) {
    if (runtime !== activation) return
    const message = error instanceof Error ? error.message : String(error)
    console.error("[ruminate] shares refresh failed:", error)
    patchStatus({
      status: activation.slices.size > 0 ? "ready" : "error",
      lastError: message,
    })
  }
}

/** Wait for the refresh in flight, if any — tests only. */
export async function flushSharedMode(): Promise<void> {
  await runtime?.refreshing
}
