import { useAtomCallback } from "jotai/utils"
import React from "react"
import { databaseApplyViews } from "../data/database-mode"
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
