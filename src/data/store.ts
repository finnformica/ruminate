import { useAtomCallback } from "jotai/utils"
import React from "react"
import { isDatabaseModeAtom, sampleGraphAtom } from "../global-state"
import { databaseApplyOps } from "./database-mode"
import { applyOps, type Op } from "./ops"

/**
 * The storage seam: every change to the graph goes through here as a batch
 * of ops (`src/data/ops.ts`). Signed in they go to the database runtime
 * (`src/data/database-mode.ts`: graph atom at once, store and replica behind
 * it); signed out they apply to the in-memory sample graph.
 */
export function useApplyOps() {
  return useAtomCallback(
    React.useCallback((get, set, ops: readonly Op[]) => {
      if (ops.length === 0) return
      if (get(isDatabaseModeAtom)) databaseApplyOps(ops)
      else set(sampleGraphAtom, applyOps(get(sampleGraphAtom), ops, Date.now()))
    }, []),
  )
}
