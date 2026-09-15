import { useAtomCallback } from "jotai/utils"
import React from "react"
import { toast } from "sonner"
import { isDatabaseModeAtom, sampleGraphAtom } from "../global-state"
import { databaseApplyOps } from "./database-mode"
import { applyOps, type Op } from "./ops"
import { sharedOriginAtom, touchesShared } from "./shared-mode"

/**
 * The storage seam: every change to the graph goes through here as a batch
 * of ops (`src/data/ops.ts`). Signed in they go to the database runtime
 * (`src/data/database-mode.ts`: graph atom at once, store and replica behind
 * it); signed out they apply to the in-memory sample graph.
 *
 * A batch that names a node someone shared with the user is refused: shares
 * are read-only (docs/sharing.md), and those rows are someone else's corpus,
 * which the local store and the replica never hold.
 */
export function useApplyOps() {
  return useAtomCallback(
    React.useCallback((get, set, ops: readonly Op[]) => {
      if (ops.length === 0) return
      if (!get(isDatabaseModeAtom)) {
        set(sampleGraphAtom, applyOps(get(sampleGraphAtom), ops, Date.now()))
        return
      }
      if (touchesShared(ops, get(sharedOriginAtom))) {
        toast("This note was shared with you to read, not to edit.")
        return
      }
      databaseApplyOps(ops)
    }, []),
  )
}
