import { useAtomValue, useStore } from "jotai"
import { useCallback, useMemo, useRef } from "react"
import { isEmptyDoc } from "../blocks/ops"
import type { BlockDoc } from "../blocks/types"
import { basketDoc, basketToOps } from "../data/basket"
import { pageDoc } from "../data/graph"
import { docToOps } from "../data/ops"
import { useApplyOps } from "../data/store"
import { graphSnapshotAtom } from "../global-state"
import type { NoteId } from "../schema"

/**
 * The note page's doc, straight from the graph — and the way back.
 *
 * `doc` is the walk of the page (`pageDoc`) over the live snapshot, so a
 * pull bringing another device's edits, an edit made through another note
 * that shares a block, or our own change a moment ago all show the instant
 * the snapshot changes. There is no editor copy to reseed and nothing to
 * reconcile: the graph is the state.
 *
 * `setDoc(next)` is the editor handing back what it now shows. The
 * difference between the graph and `next` becomes a batch of ops
 * (`docToOps`: a new block is one `create` and one `link`, typing is one
 * `setText`) applied to the graph at once and written behind. The page's
 * `updated_at` is stamped on every change — what orders the notes list and
 * drives the replica's incremental pulls (docs/graph-storage.md).
 *
 * A note that is not in the graph yet (a new page) starts from `defaultDoc`
 * and is created by its first edit with content; a note deleted while open
 * stays gone — a trailing edit never resurrects it.
 */
export function useNoteDoc({
  noteId,
  defaultDoc,
}: {
  noteId: NoteId | undefined
  /** What a page not in the graph starts as (`?content=`, or empty). */
  defaultDoc: BlockDoc
}) {
  const snapshot = useAtomValue(graphSnapshotAtom)
  const store = useStore()
  const apply = useApplyOps()

  const stored = useMemo(
    () => (noteId === undefined ? null : pageDoc(noteId, snapshot)),
    [noteId, snapshot],
  )
  const exists = stored !== null
  // Once the page has been seen, its absence means "deleted", not "new".
  const seenRef = useRef(exists)
  if (exists) seenRef.current = true

  const setDoc = useCallback(
    (next: BlockDoc) => {
      if (noteId === undefined) return
      // Diff against the graph as it is NOW (edits can outrun renders).
      const current = store.get(graphSnapshotAtom)
      const page = pageDoc(noteId, current)
      if (page === null) {
        if (seenRef.current) return // deleted underneath: let it stay deleted
        if (isEmptyDoc(next)) return // nothing worth creating a page for
      }
      const stamped: BlockDoc = {
        ...next,
        props: { ...(next.props ?? {}), updated_at: new Date().toISOString() },
      }
      apply(docToOps(noteId, stamped, current))
    },
    [noteId, store, apply],
  )

  return { doc: stored ?? defaultDoc, exists, setDoc }
}

/**
 * A note's Unassigned basket (`src/data/basket.ts`): the blocks homed to the
 * note that nothing reaches, as a doc, and the way back — the same shape as
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
