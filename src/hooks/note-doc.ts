import { useAtomValue, useStore } from "jotai"
import { useCallback, useMemo, useRef } from "react"
import { isEmptyDoc } from "../blocks/ops"
import type { BlockDoc, ChangeHint } from "../blocks/types"
import type { ExpandedRule } from "../blocks/view"
import { basketDoc, basketToOps } from "../data/basket"
import { filteredView, isNarrowed, type FilteredView } from "../data/filter-view"
import { NOTE_TYPE, blockView, noteView, type LinkDirections } from "../data/graph"
import { notePropsOps } from "../data/note-meta"
import { docToOps } from "../data/ops"
import { useApplyOps } from "../data/store"
import { blockIndexAtom, graphSnapshotAtom } from "../global-state"
import { viewNarrowing } from "../utils/view-narrowing"
import type { NoteId } from "../schema"

const NOTHING_COLLAPSED: ReadonlySet<string> = new Set()
const NO_CONTEXT: ReadonlySet<string> = new Set()

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
 * difference between the graph and `next` becomes a batch of ops
 * (`docToOps`: a new block is one `create` and one `link`, typing is one
 * `setText`) applied to the graph at once and written behind. The note's
 * `updated_at` is stamped on every change — what orders the notes list and
 * drives the replica's incremental pulls (docs/graph-storage.md); in focus,
 * where the doc says nothing about the note node, as its own `setProps`.
 *
 * A note that is not in the graph yet (a new one) starts from `defaultDoc`
 * and is created by its first edit with content; a note deleted while open
 * stays gone — a trailing edit never resurrects it.
 */
export function useNoteDoc({
  noteId,
  defaultDoc,
  focusBlockId = null,
  expanded,
  directions = "downstream",
  filter = "",
  sort = "",
}: {
  noteId: NoteId | undefined
  /** What a note not in the graph starts as (`?content=`, or empty). */
  defaultDoc: BlockDoc
  /** The block the page is focused on, if any: the walk's root instead of
   * the note. A block the graph lacks falls back to the note's view (the
   * editor then clears the focus). */
  focusBlockId?: string | null
  /** The fold rule the walk descends by; absent = walk everything. */
  expanded?: ExpandedRule
  /** Which links the walk follows (Settings → Editor, "Show links"). */
  directions?: LinkDirections
  /** Narrow the view to the blocks this query matches, their ancestors kept
   * as context (`src/data/filter-view.ts`). Empty = the whole view. */
  filter?: string
  /** Order each parent's children by this key (`text`, `text:desc`, …), the
   * nesting untouched. Empty = document order. */
  sort?: string
}) {
  const snapshot = useAtomValue(graphSnapshotAtom)
  const store = useStore()
  const apply = useApplyOps()

  // What the filter and the sort come to, answered by the SEARCH engine —
  // one vocabulary and one comparator for the header's menus and the query
  // box alike (`src/utils/view-narrowing.ts`).
  const index = useAtomValue(blockIndexAtom)
  const narrowing = useMemo(
    () => viewNarrowing({ filter, sort, noteId, index }),
    [filter, sort, noteId, index],
  )
  const narrowed = isNarrowed(narrowing)
  const view = useMemo<FilteredView | null>(() => {
    if (noteId === undefined) return null
    // A narrowed view is walked EAGERLY: whether a branch survives depends on
    // what is beneath it, and a sort must see every sibling to order them,
    // neither of which a lazy walk can answer. The reader's folds stand
    // aside while it is on and come back untouched the moment it clears.
    const rule = narrowed ? undefined : expanded
    const focused = focusBlockId ? blockView(focusBlockId, snapshot, rule, directions) : null
    const base = focused ?? noteView(noteId, snapshot, rule, directions)
    if (!base) return null
    // Focused, the root block is the view's title rather than one of its
    // rows, so the filter runs over what is inside it and never takes it
    // away (`keepRoots`).
    return filteredView(base, narrowing, { keepRoots: focused !== null })
  }, [noteId, focusBlockId, snapshot, expanded, directions, narrowed, narrowing])
  // Whether the doc is rooted at the focused block (the note node is then not
  // this doc's to write).
  const rootId = focusBlockId && view?.doc.rootBlockIds[0] === focusBlockId ? focusBlockId : null
  const exists =
    noteId !== undefined &&
    (rootId ? snapshot.nodes.get(noteId)?.type === NOTE_TYPE : view !== null)
  // Once the note has been seen, its absence means "deleted", not "new".
  const seenRef = useRef(exists)
  if (exists) seenRef.current = true

  const setDoc = useCallback(
    (next: BlockDoc, hint?: ChangeHint) => {
      if (noteId === undefined) return
      // Diff against the graph as it is NOW (edits can outrun renders).
      const current = store.get(graphSnapshotAtom)
      const note = current.nodes.get(noteId)?.type === NOTE_TYPE ? noteId : null
      if (note === null) {
        if (seenRef.current) return // deleted underneath: let it stay deleted
        if (isEmptyDoc(next)) return // nothing worth creating a note for
      }
      if (narrowed) {
        // **A narrowed view is a SELECTION of the note, not the note.** Its
        // doc holds only the rows that survived the filter, in the order the
        // sort put them — so reconciling it against the graph would read
        // every hidden row as removed and every reordered one as moved, and
        // an unlink is how a row leaves a note. Only the ops that change a
        // row's own value are kept: ticking a to-do, retyping a line, a
        // block's props. Structure — new rows, indents, removals, reorders —
        // belongs to the note itself, which is one click away with the
        // filter cleared.
        const ops = docToOps(noteId, next, current, hint?.discard, rootId ?? undefined).filter(
          (op) => op.op === "setText" || op.op === "setType" || op.op === "setProps",
        )
        if (ops.length > 0) apply([...ops, ...notePropsOps(noteId, {}, current)])
        return
      }
      if (rootId) {
        // In focus: the block's subtree is diffed; the note itself is only
        // stamped, and only when something changed.
        const ops = docToOps(noteId, next, current, hint?.discard, rootId)
        if (ops.length > 0) apply([...ops, ...notePropsOps(noteId, {}, current)])
        return
      }
      const stamped: BlockDoc = {
        ...next,
        props: { ...(next.props ?? {}), updated_at: new Date().toISOString() },
      }
      apply(docToOps(noteId, stamped, current, hint?.discard))
    },
    [noteId, rootId, narrowed, store, apply],
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
