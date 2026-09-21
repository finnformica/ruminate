import { useAtomValue } from "jotai"
import { useAtomCallback } from "jotai/utils"
import React from "react"
import { databaseApplyViews } from "../data/database-mode"
import {
  applyViewRows,
  patchedView,
  pinnedRootIdsAtom,
  reorderedViews,
  viewByRootAtom,
  viewsAtom,
  type ViewPatch,
} from "../data/views"
import { isDatabaseModeAtom } from "../global-state"

/**
 * The one write path for views (`src/data/views.ts`): pin or unpin a node,
 * or save what it opens as. Signed in the row goes to the database runtime —
 * the atom at once, the store and the replica behind it, exactly as an op
 * does — and signed out it goes to the atom alone, where the sample corpus
 * lives. Never to a share's runtime: a view is the viewer's own row, whoever
 * owns the node it is rooted at.
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

/**
 * Put the Views list in a new order (`reorderedViews`): the rows whose key
 * has to change go the same way a pin does. Handed the whole list as
 * dropped, so a drag and the menu's Move up / Move down are one write path.
 */
export function useReorderPinned() {
  return useAtomCallback(
    React.useCallback((get, set, nextRootIds: readonly string[]) => {
      const rows = reorderedViews(get(viewByRootAtom), nextRootIds, Date.now())
      if (rows.length === 0) return
      if (get(isDatabaseModeAtom)) databaseApplyViews(rows)
      else set(viewsAtom, applyViewRows(get(viewsAtom), rows))
    }, []),
  )
}

/** Whether the view rooted at `rootId` is pinned. */
export function useIsPinned(rootId: string | undefined): boolean {
  const pinned = useAtomValue(pinnedRootIdsAtom)
  return rootId !== undefined && pinned.has(rootId)
}
