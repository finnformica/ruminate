import { atom } from "jotai"
import type { ViewRow } from "../../worker/handlers/replica-payload"
import { reconcileSortKeys } from "./graph"
import type { Op } from "./ops"
import { sampleViews } from "./sample-graph"

/**
 * **Views** (migrations/0015, docs/metadata.md): the entrypoints into the
 * graph. A view is a node to start at (`root_id`), what of its subgraph to
 * keep (`filter`), how to lay that out (`sort`) and where it sits in the
 * **Views** list (`sort_key`) — the one list the sidebar, the Views page and
 * the palette draw.
 *
 * **Every note is a view**, row or no row: a page node is listed whether or
 * not anything was saved about it, and its row, when it has one, only says
 * how it opens and where it sits. **A block is a view exactly when it has a
 * row**: "Add to Views" on a block writes one (`pinned`, the column's name on
 * the wire, is what keeps a row alive that saves no filter and no sort — a
 * note never needs it), and "Remove from Views" tombstones it. Nothing is
 * pinned any more: a place is kept to hand by where it is dragged to, and
 * the list has one order for notes and blocks alike.
 *
 * A view is the viewer's own row about a node that need not be theirs — a
 * block in a note someone shared can be a view from this side — which is
 * why it is a table beside the graph rather than props on the node, and why
 * nothing here goes through ops: the graph is untouched by a view, and a
 * view is untouched by every edit to the graph except one, the delete of its
 * root (`orphanedViews`). Moving a block keeps its id, so it keeps its view;
 * duplicating one mints ids, so the copy has none.
 *
 * **One view per root, and its id IS the root's.** Two devices adding the
 * same block while apart then converge on one row under last-writer-wins
 * rather than on two rows for one block. The table keeps `id` a column of
 * its own so "several views of one node" needs no migration when it comes.
 */

export type { ViewRow }

/** The live views, by id. Set by the database runtime — from the store on
 * boot and after every pull, and at once on every write — and the sample
 * corpus's signed out. Never a tombstone: those are for replication. */
export const viewsAtom = atom<ReadonlyMap<string, ViewRow>>(viewMapOf(sampleViews()))

/** The view rooted at each node, for the note page's lookup and the list's
 * order. */
export const viewByRootAtom = atom((get) => {
  const byRoot = new Map<string, ViewRow>()
  for (const view of get(viewsAtom).values()) {
    if (!byRoot.has(view.root_id)) byRoot.set(view.root_id, view)
  }
  return byRoot
})

const NO_ROOTS: ReadonlySet<string> = new Set()

/** The roots that have a view row. For a block that is what makes it a
 * view of its own (see above); a note is one regardless, so this is read for
 * blocks — the sidebar's block rows and the editor's "Add to Views". */
export const viewRootIdsAtom = atom((get) => {
  const ids = new Set<string>()
  for (const view of get(viewsAtom).values()) ids.add(view.root_id)
  return ids.size === 0 ? NO_ROOTS : ids
})

/** The id the view rooted at `rootId` is minted under (see above). */
const viewIdFor = (rootId: string) => rootId

/** What a write may change. `null` clears a field; an empty string is the
 * same clearing, so a header that hands over `""` for "no filter" is right. */
export interface ViewPatch {
  filter?: string | null
  sort?: string | null
  /** Kept as a view of its own with nothing saved on it — what "Add to
   * Views" on a block writes, and what "Remove from Views" clears (with the
   * rest, so the row goes). Never written for a note. */
  pinned?: boolean
  /** Where the view sits in the Views list (`orderViews`). */
  sort_key?: string | null
}

const textOrNull = (value: string | null | undefined, fallback: string | null) => {
  if (value === undefined) return fallback
  const trimmed = value?.trim() ?? ""
  return trimmed === "" ? null : trimmed
}

/**
 * The row a patch to the view rooted at `rootId` writes: the current row
 * with the patch over it — or, when nothing is left that a row is for (not
 * kept, no filter, no sort, no place in the order), its tombstone, so
 * removing a block from Views leaves no empty row behind. `updated_at`
 * always moves past the current row's, because last-writer-wins reads `>=`
 * and a clock that stood still must not make the write a draw.
 */
export function patchedView(
  current: ViewRow | undefined,
  rootId: string,
  patch: ViewPatch,
  now: number,
): ViewRow {
  const next: ViewRow = {
    id: current?.id ?? viewIdFor(rootId),
    root_id: rootId,
    filter: textOrNull(patch.filter, current?.filter ?? null),
    sort: textOrNull(patch.sort, current?.sort ?? null),
    pinned: patch.pinned ?? current?.pinned ?? false,
    sort_key: patch.sort_key !== undefined ? patch.sort_key : (current?.sort_key ?? null),
    updated_at: Math.max(now, (current?.updated_at ?? 0) + 1),
  }
  if (!next.pinned && next.filter === null && next.sort === null && next.sort_key === null) {
    return { ...next, deleted_at: next.updated_at }
  }
  return next
}

/** The live map with `rows` landed on it: an upsert per live row, and a
 * tombstone takes its id out. */
export function applyViewRows(
  views: ReadonlyMap<string, ViewRow>,
  rows: readonly ViewRow[],
): ReadonlyMap<string, ViewRow> {
  if (rows.length === 0) return views
  const next = new Map(views)
  for (const row of rows) {
    if (row.deleted_at != null) next.delete(row.id)
    else next.set(row.id, row)
  }
  return next
}

/** A live map from the store's rows. */
export function viewMapOf(rows: readonly ViewRow[]): ReadonlyMap<string, ViewRow> {
  return applyViewRows(new Map(), rows)
}

/** The ids a batch of ops deletes outright (`delete`, never `unlink`). */
export function deletedIdsOf(ops: readonly Op[]): string[] {
  const ids: string[] = []
  for (const op of ops) if (op.op === "delete") ids.push(op.id)
  return ids
}

/**
 * Tombstones for the views whose root a batch deleted: a view of a node
 * that is gone would be a row in the sidebar that opens nothing. The one
 * place the graph reaches into the views table.
 */
export function orphanedViews(
  views: ReadonlyMap<string, ViewRow>,
  deletedRootIds: readonly string[],
  now: number,
): ViewRow[] {
  if (deletedRootIds.length === 0 || views.size === 0) return []
  const gone = new Set(deletedRootIds)
  const tombstones: ViewRow[] = []
  for (const view of views.values()) {
    if (!gone.has(view.root_id)) continue
    const at = Math.max(now, view.updated_at + 1)
    tombstones.push({ ...view, updated_at: at, deleted_at: at })
  }
  return tombstones
}

/**
 * **The Views list's manual order.** A view with a `sort_key` sits where the
 * key puts it — the same fractional index a `child` link uses for sibling
 * order, so a drag rewrites one row — and the rest follow in the order the
 * caller drew them (the notes in their sort, then the blocks in index
 * order), which is where a view sits until it is dragged: keys are assigned
 * on the first drag, not when a view is made, so a corpus nobody has
 * reordered carries none, and a view added later joins the end rather than
 * jumping the queue. Ties on a key break on the root id, as sibling links do.
 */
export function orderViews<T extends { id: string }>(
  entries: readonly T[],
  viewByRoot: ReadonlyMap<string, ViewRow>,
): T[] {
  const keyed: { entry: T; key: string }[] = []
  const unkeyed: T[] = []
  for (const entry of entries) {
    const key = viewByRoot.get(entry.id)?.sort_key
    if (typeof key === "string") keyed.push({ entry, key })
    else unkeyed.push(entry)
  }
  if (keyed.length === 0) return [...entries]
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.entry.id < b.entry.id ? -1 : 1))
  return [...keyed.map(({ entry }) => entry), ...unkeyed]
}

/**
 * The rows a drag of the Views list writes: the views in `nextRootIds`
 * order, keyed the way `reconcileSortKeys` keys siblings — every key that
 * still fits the new order is kept, so an ordinary drag rewrites one row,
 * and the first drag ever (no keys yet) keys the whole list. A note with no
 * row yet gets one here, holding nothing but its place: the order is the
 * one thing a note's row is always for.
 */
export function reorderedViews(
  viewByRoot: ReadonlyMap<string, ViewRow>,
  nextRootIds: readonly string[],
  now: number,
): ViewRow[] {
  const existing = nextRootIds.flatMap((id) => {
    const key = viewByRoot.get(id)?.sort_key
    return typeof key === "string" ? [{ id, sortKey: key }] : []
  })
  const keys = reconcileSortKeys(existing, [...nextRootIds])
  const rows: ViewRow[] = []
  for (const id of nextRootIds) {
    const view = viewByRoot.get(id)
    const key = keys.get(id)
    if (key === undefined || key === (view?.sort_key ?? null)) continue
    rows.push(patchedView(view, id, { sort_key: key }, now))
  }
  return rows
}
