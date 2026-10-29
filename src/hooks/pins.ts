import { useAtomCallback } from "jotai/utils"
import React from "react"
import { pinOps } from "../data/pins"
import { sharedOriginAtom } from "../data/shared-mode"
import { useApplyOps } from "../data/store"
import { graphSnapshotAtom } from "../global-state"

/**
 * Pin notes or blocks, or unpin them (`src/data/pins.ts`): one batch of
 * `setProps` through the write seam, as any edit to a node is. A node of a
 * note someone shared is the owner's, so nothing is written for it.
 */
export function useSetPinned() {
  const applyOps = useApplyOps()
  return useAtomCallback(
    React.useCallback(
      (get, _set, ids: readonly string[], pinned: boolean) => {
        const graph = get(graphSnapshotAtom)
        const origin = get(sharedOriginAtom)
        const now = Date.now()
        const ops = ids.flatMap((id) => {
          const node = graph.nodes.get(id)
          return node && !origin.has(id) ? pinOps(node, pinned, now) : []
        })
        if (ops.length > 0) applyOps(ops)
      },
      [applyOps],
    ),
  )
}
