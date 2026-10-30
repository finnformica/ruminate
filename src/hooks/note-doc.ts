import { useAtomValue, useStore } from "jotai"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { isEmptyDoc } from "../blocks/ops"
import type { LinkPivots } from "../blocks/query"
import { asBlockType, type BlockDoc, type ChangeHint } from "../blocks/types"
import type { ExpandedRule } from "../blocks/view"
import { titlesFocus } from "../blocks/markers"
import { basketDoc, basketToOps } from "../data/basket"
import { filteredView, filterReach, type FilteredView } from "../data/filter-view"
import { databaseEnsureBlocks, databaseEnsureNote } from "../data/database-mode"
import { CORPUS_ROOT_ID, isNoteType } from "../data/graph"
import { notePropsOps } from "../data/note-meta"
import { docToOps } from "../data/ops"
import { sharedOriginAtom } from "../data/shared-mode"
import { useApplyOps } from "../data/store"
import { blockIndexAtom, graphSnapshotAtom } from "../global-state"
import { viewNarrowing } from "../utils/view-narrowing"
import type { NoteId } from "../schema"
import { rootToOps } from "./results-doc"

const NOTHING_COLLAPSED: ReadonlySet<string> = new Set()
const NO_CONTEXT: ReadonlySet<string> = new Set()
const NO_PIVOTS: LinkPivots = new Map()

/**
 * The note's doc, straight from the graph — and the way back.
 *
 * `doc` is the walk of the note (`noteView`) over the live snapshot — or,
 * in focus, the walk of the focused block (`blockView`): the same walk from a
 * different root, the block as the doc's one root — so a pull bringing
 * another device's edits, an edit made through another note that shares a
 * block, or our own change a moment ago all show the instant the snapshot
 * changes. There is no editor copy to reseed and nothing to reconcile: the
 * graph is the state.
 *
 * The walk is lazy: it descends only where `expanded` (the reader's folds
 * over the depth setting, `useFoldRule`) opens a row, and `collapsed` is
 * the rows it stopped at — what the editor draws folded. Without a rule,
 * everything is walked.
 *
 * `setDoc(next)` is the editor handing back what it now shows. The
 * difference between what it was shown and `next` becomes a batch of ops
 * (`docToOps`: a new block is one `create` and one `link`, typing is one
 * `setText`) applied to the graph at once and written behind. Narrowed —
 * a filter or a sort on (`src/data/filter-view.ts`) — the doc is the rows
 * that survived, in the view's order, and the edit is read as exactly
 * that: the rows the filter hid, and the note's own order, are left as they
 * are, and everything else edits as it does in the note. The note's
 * `updated_at` is stamped on every change — what drives the replica's incremental pulls (docs/graph-storage.md); in focus,
 * where the doc says nothing about the note node, as its own `setProps`.
 *
 * A note that is not in the graph yet (a new one) starts from `defaultDoc`
 * and is created by its first edit with content; a note deleted while open
 * stays gone — a trailing edit never resurrects it.
 *
 * The Root frame (`CORPUS_ROOT_ID`, src/data/root-frame.ts) is this same doc:
 * the walk of the corpus root (`rootView`), whose rows are every note of the
 * reader's own. Its edit is `rootToOps`: each block's home is the note it
 * sits in, and a move of one note row, with nothing narrowed, writes the
 * root's link to it.
 */
export function useNoteDoc({
  noteId,
  defaultDoc,
  focusBlockId = null,
  expanded,
  pivots = NO_PIVOTS,
  filter = "",
  sort = "",
  keep,
}: {
  noteId: NoteId | undefined
  /** What a note not in the graph starts as (`?content=`, or empty). */
  defaultDoc: BlockDoc
  /** The block the page is focused on, if any: the walk's root instead of
   * the note. A block the graph lacks falls back to the note's view (the
   * editor then clears the focus). */
  focusBlockId?: string | null
  /** The fold rule the view's rows are drawn by — the view's own
   * (`useFoldRule`, src/data/view-state.ts); absent = nothing folded. */
  expanded?: ExpandedRule
  /** The frame's link pivots (src/blocks/query.ts): the walk reads them, and
   * a filter or a sort keeps their up regions whole. None by default. */
  pivots?: LinkPivots
  /** Narrow the view to the blocks this query matches, their ancestors kept
   * as context (`src/data/filter-view.ts`). Empty = the whole view. */
  filter?: string
  /** Order each parent's children by this key (`text`, `text:desc`, …), the
   * nesting untouched. Empty = document order. */
  sort?: string
  /** Rows the filter keeps whatever it says of them — the row being edited
   * (`filteredView`, `keep`). Nothing without a filter. */
  keep?: ReadonlySet<string>
}) {
  const snapshot = useAtomValue(graphSnapshotAtom)
  const store = useStore()
  const apply = useApplyOps()
  // The notes other people shared are listed apart, not as Root's rows.
  const shared = useAtomValue(sharedOriginAtom)
  const exclude = useMemo(() => (shared.size > 0 ? new Set(shared.keys()) : undefined), [shared])

  // The graph is loaded lazily (docs/events-log-cache.md, "The client"): a
  // note is read whole the moment its page opens, and a row the walk opened
  // whose children the graph held only in part is read next. A shared note
  // is held whole in memory already.
  useEffect(() => {
    if (noteId === undefined || noteId === CORPUS_ROOT_ID || shared.has(noteId)) return
    void databaseEnsureNote(noteId)
  }, [noteId, shared])

  // What the filter and the sort come to, answered by the SEARCH engine —
  // one vocabulary and one comparator for the header's menus and the query
  // box alike (`src/utils/view-narrowing.ts`).
  const index = useAtomValue(blockIndexAtom)
  const narrowing = useMemo(
    () => viewNarrowing({ filter, sort, noteId, index }),
    [filter, sort, noteId, index],
  )
  // The filter's ancestor closure, built once per filter and snapshot: what
  // lets the walk narrow lazily (docs/graph-walk.md, 4.5).
  const reach = useMemo(
    () =>
      noteId === undefined || narrowing.matched === null
        ? undefined
        : filterReach(snapshot, noteId, narrowing.matched),
    [snapshot, noteId, narrowing.matched],
  )
  const view = useMemo<FilteredView | null>(() => {
    if (noteId === undefined) return null
    // A heading in focus is the view's title, always open (`titlesFocus`,
    // src/blocks/view.ts), so the walk opens it whatever the reader's fold
    // on it says: a top-level heading folded in the note has its fold under
    // its bare id, the very key the focus walk gives the root, and the walk
    // would stop there with nothing beneath the title.
    const focusType = focusBlockId ? snapshot.nodes.get(focusBlockId)?.type : undefined
    const viewRule: ExpandedRule | undefined =
      expanded && focusBlockId && focusType && titlesFocus(asBlockType(focusType))
        ? (key, level, type) => key === focusBlockId || expanded(key, level, type)
        : expanded
    // Narrowed or not, the walk is the lazy one, by the view's fold rule: a
    // narrowed walk tells a branch's fate from `reach`, not from a walk
    // beneath it, and sorts each row's children as it builds the row.
    return filteredView(snapshot, noteId, focusBlockId, narrowing, {
      expanded: viewRule,
      keep,
      pivots,
      reach,
      exclude,
    })
  }, [noteId, focusBlockId, snapshot, expanded, pivots, narrowing, keep, reach, exclude])
  useEffect(() => {
    if (view && view.unloaded.size > 0) void databaseEnsureBlocks([...view.unloaded])
  }, [view])
  // Whether the doc is rooted at the focused block (the note node is then not
  // this doc's to write).
  const rootId = focusBlockId && view?.doc.rootBlockIds[0] === focusBlockId ? focusBlockId : null
  const exists =
    noteId !== undefined &&
    (rootId ? isNoteType(snapshot.nodes.get(noteId)?.type ?? "") : view !== null)
  // Once the note has been seen, its absence means "deleted", not "new".
  const seenRef = useRef(exists)
  if (exists) seenRef.current = true
  // What the editor was handed — the doc an edit starts from.
  const shownRef = useRef(view)
  shownRef.current = view

  const setDoc = useCallback(
    (next: BlockDoc, hint?: ChangeHint) => {
      if (noteId === undefined) return
      // Diff against the graph as it is NOW (edits can outrun renders).
      const current = store.get(graphSnapshotAtom)
      if (noteId === CORPUS_ROOT_ID) {
        const shown = shownRef.current?.doc
        if (!shown) return
        // A move means the root's order only where the rows are in it: a
        // filter or a sort shows another order (`movableRoots`).
        const movable = narrowing.matched === null && narrowing.compare === null
        apply(rootToOps(next, shown, current, { discard: hint?.discard, movable }))
        return
      }
      const note = isNoteType(current.nodes.get(noteId)?.type ?? "") ? noteId : null
      if (note === null) {
        if (seenRef.current) return // deleted underneath: let it stay deleted
        if (isEmptyDoc(next)) return // nothing worth creating a note for
      }
      // The diff is read as the edit to what the view SHOWED (`docToOps`,
      // `shown`): the whole note, or — narrowed — the rows that survived the
      // filter in the order the sort put them. So a narrowed view edits as
      // the note does, with the same editor and the same save: a row added
      // beneath a match lands beside it in the note, a row removed is
      // unlinked, and the rows the filter hid, and the note's own order,
      // are never this edit's to change.
      const shown = shownRef.current?.doc
      if (rootId) {
        // In focus: the block's subtree is diffed; the note itself is only
        // stamped, and only when something changed.
        const ops = docToOps(noteId, next, current, hint?.discard, rootId, shown)
        if (ops.length > 0) apply([...ops, ...notePropsOps(noteId, {}, current)])
        return
      }
      const stamped: BlockDoc = {
        ...next,
        props: { ...(next.props ?? {}), updated_at: new Date().toISOString() },
      }
      // A first edit to a note that is not in the graph yet — a fresh
      // `/notes/<id>` typed into — is what creates it.
      apply(docToOps(noteId, stamped, current, hint?.discard, noteId, shown))
    },
    [noteId, rootId, store, apply, narrowing],
  )

  return {
    doc: view?.doc ?? defaultDoc,
    collapsed: view?.collapsed ?? NOTHING_COLLAPSED,
    /** The rows kept only as context by the filter — drawn dimmed. */
    context: view?.context ?? NO_CONTEXT,
    /** How many rows the filter matched; null when nothing is filtered. */
    matches: view?.matches ?? null,
    exists,
    setDoc,
  }
}

/**
 * A note's Unassigned basket (`src/data/basket.ts`): the blocks written in
 * the note that nothing reaches, as a doc, and the way back — the same shape as
 * `useNoteDoc`, over `basketToOps` instead of `docToOps`, so the basket's
 * rows edit exactly like the outline's. Empty (no roots) when every block
 * of the note is reached.
 */
export function useBasketDoc(noteId: NoteId | undefined) {
  const snapshot = useAtomValue(graphSnapshotAtom)
  const store = useStore()
  const apply = useApplyOps()

  const doc = useMemo(
    () => (noteId === undefined ? null : basketDoc(noteId, snapshot)),
    [noteId, snapshot],
  )

  const setDoc = useCallback(
    (next: BlockDoc) => {
      if (noteId === undefined) return
      apply(basketToOps(noteId, next, store.get(graphSnapshotAtom)))
    },
    [noteId, store, apply],
  )

  return { doc, count: doc?.rootBlockIds.length ?? 0, setDoc }
}
