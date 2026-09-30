import { atom, getDefaultStore } from "jotai"
import { toast } from "sonner"
import {
  emptyGraphDiff,
  isEmptyGraphDiff,
  linkKeyOf,
  type GraphDiff,
  type NodeRow,
} from "../../worker/handlers/replica-payload"
import { NOTE_TYPE, buildGraphSnapshot, indexParents, type GraphSnapshot } from "./graph"
import { applyOps, type Op } from "./ops"
import { opsToRows } from "./ops-rows"
import {
  isSharesRefusal,
  listShares,
  pullShare,
  pushShare,
  type ReceivedShareSummary,
  type ShareView,
  type SharePermission,
} from "./shares"

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
 *   edits   ops on a shared note apply to that share's snapshot at once (the
 *           screen never waits), coalesce for a moment as a row diff, then
 *           push to the share's write endpoint — write-behind, like the
 *           replica queue, and per-row last-writer-wins at the owner's rows
 *   sync    the same ambient triggers the replica pull uses (visibility,
 *           focus, online) re-pull every slice, coalesced; a slice with a
 *           push in flight is left alone until it lands
 *
 * **A shared block is a note here.** A root may be a block (shared from its
 * right-click menu), and a block has no page of its own to open. The slice
 * arrives as the owner's rows; on the way into the snapshot a root that is
 * not a note is given the note type (`asNotes`), so it lists in the sidebar,
 * opens at `/views/<id>` with its text as the title and its children as the
 * outline, and searches like any note. A push puts the row's own type back
 * (`Slice.rootTypes`), so the owner's block never becomes a note.
 *
 * **Whole-slice pulls, deliberately.** A since-cursor cannot describe a
 * slice: a block leaves it by being UNLINKED (a change to a link row, not to
 * the block), and a since-pull scoped to the closure would never mention a
 * row that is no longer in the closure. A slice is small — a handful of
 * notes — so pulling it whole is cheap and always right.
 *
 * **How the UI sees it.** `sharedGraphAtom` is the union of every slice, and
 * `graphSnapshotAtom` (global-state.ts) merges it with the user's own graph,
 * so the editor, search, hover cards and the Views page read shared notes
 * exactly as they read the user's own. `sharedOriginAtom` says which share a
 * node came from, which is how the write seam (`store.ts`) routes a batch of
 * ops here rather than to the local store, and how the sidebar tells a
 * shared note from an own one.
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
 * The view each share opens its root with (docs/metadata.md, "Views"): the
 * OWNER's filter and sort, by root, for the note page to fall back on when
 * the reader has saved no view of their own. Presentation only — the slice
 * is the whole subtree either way.
 */
export const sharedViewByRootAtom = atom((get) => {
  const byRoot = new Map<string, ShareView>()
  for (const share of get(receivedSharesAtom)) {
    if (share.view.rootId !== "" && !byRoot.has(share.view.rootId)) {
      byRoot.set(share.view.rootId, share.view)
    }
  }
  return byRoot
})

/**
 * The address shares reach me at, as the server has it recorded
 * (`users.email`) — not the copy the sign-in left in localStorage. Null until
 * the first refresh lands, or when the server has none on record.
 */
export const recordedEmailAtom = atom<string | null>(null)

export interface SharedModeStatus {
  status: "off" | "loading" | "ready" | "error"
  lastError: string | null
}

const OFF_STATUS: SharedModeStatus = { status: "off", lastError: null }

export const sharedModeStatusAtom = atom<SharedModeStatus>(OFF_STATUS)

/** How long a run of ops coalesces before it is pushed. */
const PUSH_DEBOUNCE_MS = 1_000
/** Push retry backoff after a network failure: doubling from here to the cap. */
const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 60_000
/** Minimum gap between ambient re-pulls (same reasoning as the replica's). */
const AMBIENT_REFRESH_MS = 30_000

interface Slice {
  share: ReceivedShareSummary
  graph: GraphSnapshot
  /** The stored type of every root that is presented as a note (see
   * `asNotes`) — what a pushed row of it carries. */
  rootTypes: ReadonlyMap<string, string>
}

interface PendingPush {
  diff: GraphDiff
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  retryMs: number
}

interface SharedRuntime {
  generation: number
  slices: Map<string, Slice>
  pending: Map<string, PendingPush>
  refreshTimer: ReturnType<typeof setTimeout> | null
  lastRefreshAt: number
  refreshing: Promise<void> | null
  fetchImpl: typeof fetch | undefined
}

let runtime: SharedRuntime | null = null
let generation = 0

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
  const childLinks = new Map([...a.childLinks, ...b.childLinks])
  // The reverse index is rebuilt from the merged lists rather than merged by
  // key: a node the user linked in from a slice is held by a source on each
  // side, and only a rebuild keeps both parents.
  return {
    nodes: new Map([...a.nodes, ...b.nodes]),
    childLinks,
    parentLinks: indexParents(childLinks),
  }
}

export type OpsRoute = { kind: "own" } | { kind: "shared"; shareId: string } | { kind: "mixed" }

/**
 * Where a batch of ops belongs: the user's own corpus, one share, or — if it
 * names nodes of more than one origin — nowhere. A `create` names a node no
 * origin knows yet, so it follows the rest of its batch (a new block in a
 * shared note arrives with the link that places it).
 */
export function routeOps(ops: readonly Op[], origin: ReadonlyMap<string, string>): OpsRoute {
  let own = false
  let shareId: string | null = null
  const consider = (id: string) => {
    const share = origin.get(id)
    if (share === undefined) return
    if (shareId === null) shareId = share
    else if (shareId !== share) own = true
  }
  for (const op of ops) {
    if (op.op === "create") continue
    if (op.op === "link" || op.op === "unlink") {
      consider(op.source)
      consider(op.destination)
    } else consider(op.id)
  }
  if (shareId === null) return { kind: "own" }
  if (own) return { kind: "mixed" }
  // A batch that names a shared node AND one of the user's own existing
  // nodes (an id the origin map does not know but the own graph does) is
  // mixed too; the seam checks that against its own graph, so here only the
  // shared side is decided.
  return { kind: "shared", shareId }
}

/** Do the ids these ops name outside `origin` exist in the user's own graph?
 * The other half of `routeOps`'s mixed check. */
export function namesOwnNodes(
  ops: readonly Op[],
  origin: ReadonlyMap<string, string>,
  own: GraphSnapshot,
): boolean {
  const isOwn = (id: string) => !origin.has(id) && own.nodes.has(id)
  for (const op of ops) {
    if (op.op === "create") continue
    if (op.op === "link" || op.op === "unlink") {
      if (isOwn(op.source) || isOwn(op.destination)) return true
    } else if (isOwn(op.id)) return true
  }
  return false
}

/** Fold `next` into `pending`, keyed by row; a later row replaces an earlier one. */
export function mergeDiffs(pending: GraphDiff, next: GraphDiff): GraphDiff {
  const nodes = new Map(pending.nodes.map((row) => [row.id, row]))
  for (const row of next.nodes) nodes.set(row.id, row)
  const links = new Map(pending.links.map((row) => [linkKeyOf(row).join("\x1f"), row]))
  for (const row of next.links) links.set(linkKeyOf(row).join("\x1f"), row)
  const views = new Map(pending.views.map((row) => [row.id, row]))
  for (const row of next.views) views.set(row.id, row)
  return {
    ...emptyGraphDiff(),
    nodes: [...nodes.values()],
    links: [...links.values()],
    views: [...views.values()],
  }
}

/** The slice's rows with every root that is a block presented as a note. */
export function asNotes(nodes: NodeRow[], rootIds: readonly string[]): NodeRow[] {
  const roots = new Set(rootIds)
  return nodes.map((node) =>
    roots.has(node.id) && node.type !== NOTE_TYPE ? { ...node, type: NOTE_TYPE } : node,
  )
}

/** The stored type of every root `asNotes` will present as a note. */
function rootTypesOf(nodes: NodeRow[], rootIds: readonly string[]): Map<string, string> {
  const roots = new Set(rootIds)
  const types = new Map<string, string>()
  for (const node of nodes) {
    if (roots.has(node.id) && node.type !== NOTE_TYPE) types.set(node.id, node.type)
  }
  return types
}

/** A slice from the rows the server sent. The view rides with the rows, so
 * a pull follows the owner's edits to what the share opens as. */
const sliceOf = (
  summary: ReceivedShareSummary,
  rows: { nodes: NodeRow[]; links: LinkRowsOf; view?: ShareView },
): Slice => {
  const share = rows.view ? { ...summary, view: rows.view } : summary
  const roots = [share.view.rootId]
  return {
    share,
    graph: buildGraphSnapshot(asNotes(rows.nodes, roots), rows.links),
    rootTypes: rootTypesOf(rows.nodes, roots),
  }
}
type LinkRowsOf = Parameters<typeof buildGraphSnapshot>[1]

/** The verbs a share grants, as flags. */
export const sharePermissions = (
  share: ReceivedShareSummary,
): { write: boolean; delete: boolean } => ({
  write: share.permissions.includes("write" satisfies SharePermission),
  delete: share.permissions.includes("delete" satisfies SharePermission),
})

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
  generation += 1
  const activation: SharedRuntime = {
    generation,
    slices: new Map(),
    pending: new Map(),
    refreshTimer: null,
    lastRefreshAt: 0,
    refreshing: null,
    fetchImpl: options.fetchImpl,
  }
  runtime = activation
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHidden)
    document.addEventListener("visibilitychange", onPageHidden)
  }
  jotai().set(sharedModeStatusAtom, { status: "loading", lastError: null })
  void refresh(activation)
}

/** Stop the runtime: shared notes disappear from the graph at once. Pending
 * pushes are flushed with `keepalive` on the way out. */
export function stopSharedMode() {
  const stopped = runtime
  if (!stopped) return
  runtime = null
  generation += 1
  if (stopped.refreshTimer !== null) clearTimeout(stopped.refreshTimer)
  for (const [shareId, pending] of stopped.pending) {
    if (pending.timer !== null) clearTimeout(pending.timer)
    if (!pending.inFlight && !isEmptyGraphDiff(pending.diff)) {
      void pushShare(shareId, pending.diff, {
        keepalive: true,
        fetchImpl: stopped.fetchImpl,
      }).catch(() => {})
    }
  }
  if (typeof window !== "undefined") {
    window.removeEventListener("pagehide", onPageHidden)
    document.removeEventListener("visibilitychange", onPageHidden)
  }
  const store = jotai()
  store.set(sharedGraphAtom, EMPTY)
  store.set(sharedOriginAtom, EMPTY_ORIGIN)
  store.set(receivedSharesAtom, [])
  store.set(recordedEmailAtom, null)
  store.set(sharedModeStatusAtom, OFF_STATUS)
}

function onPageHidden() {
  if (typeof document !== "undefined" && document.visibilityState !== "hidden") return
  const activation = runtime
  if (!activation) return
  for (const shareId of activation.pending.keys()) void flush(activation, shareId, true)
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
        const current = activation.slices.get(share.id)
        const pending = activation.pending.get(share.id)
        // A slice with unpushed edits keeps its local copy: a pull landing
        // under them would revert what is on its way out.
        if (current && pending && (pending.inFlight || !isEmptyGraphDiff(pending.diff))) {
          next.set(share.id, { ...current, share })
          return
        }
        next.set(share.id, sliceOf(share, await pullShare(share.id, activation.fetchImpl)))
      }),
    )
    if (runtime !== activation) return
    activation.slices = next
    for (const shareId of [...activation.pending.keys()]) {
      if (!next.has(shareId)) activation.pending.delete(shareId)
    }
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

/** Re-pull one slice (after a push, or to revert a refused one). */
async function repull(activation: SharedRuntime, shareId: string) {
  const slice = activation.slices.get(shareId)
  if (!slice) return
  try {
    const rows = await pullShare(shareId, activation.fetchImpl)
    if (runtime !== activation) return
    const current = activation.slices.get(shareId)
    if (!current) return
    activation.slices.set(shareId, sliceOf(current.share, rows))
    publish(activation)
  } catch (error) {
    if (runtime === activation) console.error("[ruminate] share re-pull failed:", error)
  }
}

// -----------------------------------------------------------------------------
// Writes (the `store.ts` seam routes here for shared nodes)
// -----------------------------------------------------------------------------

/**
 * Apply a batch of ops to one share: the slice's snapshot takes them at once,
 * the row diff coalesces briefly and is pushed. A batch the share's verbs do
 * not cover is refused HERE, before anything changes on screen — the server
 * would refuse it anyway, but a toast now beats a revert later.
 */
export function sharedApplyOps(shareId: string, ops: readonly Op[]) {
  const activation = runtime
  if (!activation || ops.length === 0) return
  const slice = activation.slices.get(shareId)
  if (!slice) return

  const verbs = sharePermissions(slice.share)
  const deletes = ops.some((op) => op.op === "delete")
  const edits = ops.some((op) => op.op !== "delete")
  if (edits && !verbs.write) {
    toast("This note was shared with you to read, not to edit.")
    return
  }
  if (deletes && !verbs.delete) {
    toast("This share does not let you delete blocks.")
    return
  }

  const now = Date.now()
  const diff = opsToRows(slice.graph, ops, now)
  // A block root is a note on screen and a block in the owner's rows.
  for (const row of diff.nodes) {
    const stored = slice.rootTypes.get(row.id)
    if (stored !== undefined) row.type = stored
  }
  activation.slices.set(shareId, { ...slice, graph: applyOps(slice.graph, ops, now) })
  publish(activation)

  let pending = activation.pending.get(shareId)
  if (!pending) {
    pending = { diff: emptyGraphDiff(), timer: null, inFlight: false, retryMs: RETRY_MIN_MS }
    activation.pending.set(shareId, pending)
  }
  pending.diff = mergeDiffs(pending.diff, diff)
  schedule(activation, shareId, PUSH_DEBOUNCE_MS)
}

function schedule(activation: SharedRuntime, shareId: string, delayMs: number) {
  const pending = activation.pending.get(shareId)
  if (!pending) return
  if (pending.timer !== null) clearTimeout(pending.timer)
  pending.timer = setTimeout(() => {
    pending.timer = null
    if (runtime === activation) void flush(activation, shareId)
  }, delayMs)
}

async function flush(activation: SharedRuntime, shareId: string, keepalive = false) {
  const pending = activation.pending.get(shareId)
  if (!pending || pending.inFlight || isEmptyGraphDiff(pending.diff)) return
  if (pending.timer !== null) {
    clearTimeout(pending.timer)
    pending.timer = null
  }
  const diff = pending.diff
  pending.diff = emptyGraphDiff()
  pending.inFlight = true
  try {
    await pushShare(shareId, diff, { keepalive, fetchImpl: activation.fetchImpl })
    if (runtime !== activation) return
    pending.inFlight = false
    pending.retryMs = RETRY_MIN_MS
    if (isEmptyGraphDiff(pending.diff)) {
      activation.pending.delete(shareId)
      // Converge on the owner's rows (another editor's LWW win, a block the
      // owner unlinked meanwhile) once nothing of ours is outstanding.
      await repull(activation, shareId)
    } else {
      schedule(activation, shareId, PUSH_DEBOUNCE_MS)
    }
  } catch (error) {
    if (runtime !== activation) return
    pending.inFlight = false
    if (isSharesRefusal(error)) {
      // The server will say the same thing again: drop the rows and put the
      // screen back to what the owner's partition holds.
      const message = error instanceof Error ? error.message : String(error)
      toast(`A change to a shared note was refused: ${message}`)
      pending.diff = emptyGraphDiff()
      activation.pending.delete(shareId)
      patchStatus({ lastError: message })
      await repull(activation, shareId)
      return
    }
    // Network: keep the rows (newer ones queued meanwhile win) and retry.
    pending.diff = mergeDiffs(diff, pending.diff)
    patchStatus({ lastError: error instanceof Error ? error.message : String(error) })
    schedule(activation, shareId, pending.retryMs)
    pending.retryMs = Math.min(pending.retryMs * 2, RETRY_MAX_MS)
  }
}

/** Push every pending diff now and wait for the queue — tests only. */
export async function flushSharedMode(): Promise<void> {
  const activation = runtime
  if (!activation) return
  await activation.refreshing
  await Promise.all([...activation.pending.keys()].map((shareId) => flush(activation, shareId)))
}
