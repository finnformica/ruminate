import { useAtomValue, useStore } from "jotai"
import { useCallback, useMemo, useRef } from "react"
import { isEmptyDoc } from "../blocks/ops"
import type { BlockDoc, ChangeHint } from "../blocks/types"
import type { ExpandedRule } from "../blocks/view"
import { basketDoc, basketToOps } from "../data/basket"
import { NOTE_TYPE, blockView, noteView, type GraphView } from "../data/graph"
import { notePropsOps } from "../data/note-meta"
import { docToOps } from "../data/ops"
import { useApplyOps } from "../data/store"
import { graphSnapshotAtom } from "../global-state"
import type { NoteId } from "../schema"

const NOTHING_COLLAPSED: ReadonlySet<string> = new Set()

/**
 * The note's doc, straight from the graph — and the way back.
 *
 * `doc` is the walk of the note (`noteView`) over the live snapshot — or,
 * zoomed, the walk of the zoomed block (`blockView`): the same walk from a
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
 * drives the replica's incremental pulls (docs/graph-storage.md); zoomed,
 * where the doc says nothing about the note node, as its own `setProps`.
 *
 * A note that is not in the graph yet (a new one) starts from `defaultDoc`
 * and is created by its first edit with content; a note deleted while open
 * stays gone — a trailing edit never resurrects it.
 */
export function useNoteDoc({
  noteId,
  defaultDoc,
  zoomBlockId = null,
  expanded,
}: {
  noteId: NoteId | undefined
  /** What a note not in the graph starts as (`?content=`, or empty). */
  defaultDoc: BlockDoc
  /** The block the page is zoomed into, if any: the walk's root instead of
   * the note. A block the graph lacks falls back to the note's view (the
   * editor then clears the zoom). */
  zoomBlockId?: string | null
  /** The fold rule the walk descends by; absent = walk everything. */
  expanded?: ExpandedRule
}) {
  const snapshot = useAtomValue(graphSnapshotAtom)
  const store = useStore()
  const apply = useApplyOps()

  const view = useMemo<GraphView | null>(() => {
    if (noteId === undefined) return null
    const zoomed = zoomBlockId ? blockView(zoomBlockId, snapshot, expanded) : null
    return zoomed ?? noteView(noteId, snapshot, expanded)
  }, [noteId, zoomBlockId, snapshot, expanded])
  // Whether the doc is rooted at the zoomed block (the note node is then not
  // this doc's to write).
  const rootId = zoomBlockId && view?.doc.rootBlockIds[0] === zoomBlockId ? zoomBlockId : null
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
      if (rootId) {
        // Zoomed: the block's subtree is diffed; the note itself is only
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
    [noteId, rootId, store, apply],
  )

  return {
    doc: view?.doc ?? defaultDoc,
    collapsed: view?.collapsed ?? NOTHING_COLLAPSED,
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
