import { useAtomValue } from "jotai"
import { useAtomCallback } from "jotai/utils"
import React from "react"
import { databaseApplyViews } from "../data/database-mode"
import { sharedViewByRootAtom } from "../data/shared-mode"
import {
  applyViewRows,
  patchedView,
  reorderedViews,
  viewByRootAtom,
  viewsAtom,
  type ViewPatch,
} from "../data/views"
import { isDatabaseModeAtom } from "../global-state"

/**
 * The one write path for views (`src/data/views.ts`): make a block a view
 * or remove it, save what a node opens as, or place it in the list. Signed
 * in the row goes to the database runtime — the atom at once, the store and
 * the replica behind it, exactly as an op does — and signed out it goes to
 * the atom alone, where the sample corpus lives. Never to a share's runtime:
 * a view is the viewer's own row, whoever owns the node it is rooted at.
 */
export function useWriteView() {
  return useAtomCallback(
    React.useCallback((get, set, rootId: string, patch: ViewPatch) => {
      const row = patchedView(get(viewByRootAtom).get(rootId), rootId, patch, Date.now())
      if (get(isDatabaseModeAtom)) databaseApplyViews([row])
      else set(viewsAtom, applyViewRows(get(viewsAtom), [row]))
    }, []),
  )
}

/** What "Remove from Views" on a block writes: the whole row cleared, so it
 * goes (`patchedView` tombstones a row with nothing left in it). */
export const REMOVE_VIEW: ViewPatch = { pinned: false, filter: null, sort: null, sort_key: null }

/**
 * Put the Views list in a new order (`reorderedViews`): the rows whose key
 * has to change go the same way a saved view does. Handed the whole list as
 * dropped, so a drag and the menu's Move up / Move down are one write path.
 */
export function useReorderViews() {
  return useAtomCallback(
    React.useCallback((get, set, nextRootIds: readonly string[]) => {
      const rows = reorderedViews(get(viewByRootAtom), nextRootIds, Date.now())
      if (rows.length === 0) return
      if (get(isDatabaseModeAtom)) databaseApplyViews(rows)
      else set(viewsAtom, applyViewRows(get(viewsAtom), rows))
    }, []),
  )
}

/** What a note or block saved as its default view (docs/metadata.md). */
export interface SavedView {
  filter: string
  sort: string
  /** Whether the header may offer to save: there is something to root a
   * view at. A note shared with the user included — the view is the user's
   * own row (`src/data/views.ts`), whoever owns the note. */
  writable: boolean
}

const NO_SAVED_VIEW: SavedView = { filter: "", sort: "", writable: false }

/**
 * The saved view of whatever the page is rooted at — the focused block, else
 * the note: the view row rooted there (docs/metadata.md, "Views"). A note
 * needs no row to be a view, and a block needs no row to save one. On a note
 * someone shared, the reader's own row wins, and the share's view — the
 * owner's filter and sort, which is what a share IS (docs/sharing.md) — fills
 * in behind it, so the note opens the way the owner meant it to. A note's
 * outline and its board (docs/boards.md) read the same row, so a view saved
 * on one is what the other opens with.
 */
export function useSavedView(focusBlockId: string | null, noteId: string | undefined): SavedView {
  const byRoot = useAtomValue(viewByRootAtom)
  const sharedByRoot = useAtomValue(sharedViewByRootAtom)
  return React.useMemo<SavedView>(() => {
    const rootId = focusBlockId ?? noteId
    if (!rootId) return NO_SAVED_VIEW
    const view = byRoot.get(rootId) ?? sharedByRoot.get(rootId)
    return { filter: view?.filter ?? "", sort: view?.sort ?? "", writable: true }
  }, [focusBlockId, noteId, byRoot, sharedByRoot])
}
