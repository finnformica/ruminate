import { atom } from "jotai"
import type { ViewRow } from "../../worker/handlers/replica-payload"
import type { Op } from "./ops"
import { sampleViews } from "./sample-graph"

/**
 * **Views** (migrations/0015, docs/metadata.md): the entrypoints into the
 * graph. A view is a node to start at (`root_id`), what of its subgraph to
 * keep (`filter`), how to lay that out (`sort`) and whether it is **pinned**:
 * listed under **Views** in the sidebar, the notes page and the palette.
 *
 * A view is the viewer's own row about a node that need not be theirs — a
 * note someone shared can be pinned from this side — which is why it is a
 * table beside the graph rather than props on the node, and why nothing here
 * goes through ops: the graph is untouched by a view, and a view is untouched
 * by every edit to the graph except one, the delete of its root
 * (`orphanedViews`). Moving a block keeps its id, so it keeps its view;
 * duplicating one mints ids, so the copy has none.
 *
 * **One view per root, and its id IS the root's.** Two devices pinning the
 * same note while apart then converge on one row under last-writer-wins
 * rather than on two rows for one note. The table keeps `id` a column of its
 * own so "several views of one node" needs no migration when it comes.
 */

export type { ViewRow }

/** The live views, by id. Set by the database runtime — from the store on
 * boot and after every pull, and at once on every write — and the sample
 * corpus's signed out. Never a tombstone: those are for replication. */
export const viewsAtom = atom<ReadonlyMap<string, ViewRow>>(viewMapOf(sampleViews()))

/** The view rooted at each node, for the note page's lookup. */
export const viewByRootAtom = atom((get) => {
  const byRoot = new Map<string, ViewRow>()
  for (const view of get(viewsAtom).values()) {
    if (!byRoot.has(view.root_id)) byRoot.set(view.root_id, view)
  }
  return byRoot
})

const NO_ROOTS: ReadonlySet<string> = new Set()

/** The roots of the pinned views: what wears the pin, wherever it is drawn. */
export const pinnedRootIdsAtom = atom((get) => {
  const ids = new Set<string>()
  for (const view of get(viewsAtom).values()) if (view.pinned) ids.add(view.root_id)
  return ids.size === 0 ? NO_ROOTS : ids
})

/** The id the view rooted at `rootId` is minted under (see above). */
const viewIdFor = (rootId: string) => rootId

/** What a write may change. `null` clears a field; an empty string is the
 * same clearing, so a header that hands over `""` for "no filter" is right. */
export interface ViewPatch {
  filter?: string | null
  sort?: string | null
  pinned?: boolean
}

const textOrNull = (value: string | null | undefined, fallback: string | null) => {
  if (value === undefined) return fallback
  const trimmed = value?.trim() ?? ""
  return trimmed === "" ? null : trimmed
}

/**
 * The row a patch to the view rooted at `rootId` writes: the current row
 * with the patch over it — or, when nothing is left that a view is for (not
 * pinned, no filter, no sort), its tombstone, so unpinning a note that saved
 * nothing leaves no empty row behind. `updated_at` always moves past the
 * current row's, because last-writer-wins reads `>=` and a clock that stood
 * still must not make the write a draw.
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
    sort_key: current?.sort_key ?? null,
    updated_at: Math.max(now, (current?.updated_at ?? 0) + 1),
  }
  if (!next.pinned && next.filter === null && next.sort === null) {
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
