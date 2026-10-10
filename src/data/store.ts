import { useAtomCallback } from "jotai/utils"
import React from "react"
import { toast } from "sonner"
import { isDatabaseModeAtom, sampleGraphAtom } from "../global-state"
import { databaseApplyOps, databaseApplyViews, databaseGraphAtom } from "./database-mode"
import { applyOps, type Op } from "./ops"
import { namesOwnNodes, routeOps, sharedApplyOps, sharedOriginAtom } from "./shared-mode"
import {
  applyViewRows,
  deletedIdsOf,
  orphanedViews,
  patchedViews,
  viewByRootAtom,
  viewsAtom,
  type ViewWrite,
} from "./views"

/**
 * The storage seam: every change to the graph goes through here as a batch
 * of ops (`src/data/ops.ts`). Signed in they go to the database runtime
 * (`src/data/database-mode.ts`: graph atom at once, store and replica behind
 * it) — or, when the batch names nodes of a note someone shared with the
 * user, to that share's runtime (`src/data/shared-mode.ts`), which pushes
 * them to the owner's partition instead. A batch spanning both is refused:
 * a block cannot live in a shared note and one of your own at once, because
 * the two are rows in two different people's corpora.
 * Signed out they apply to the in-memory sample graph.
 *
 * A batch may name the command behind it (`cause`), which the event log keeps
 * beside each change it amounts to (docs/event-sourcing.md); none does yet.
 *
 * A batch may carry **view writes** with it (`ViewWrite`, src/data/views.ts)
 * — the row a note or board is created with (`LISTED_VIEW`), so the node
 * and the row that lists it land in the one write. A view is the viewer's
 * own row whoever owns the node, so the rows go to the viewer's own runtime
 * whichever way the ops are routed.
 */
export function useApplyOps() {
  return useAtomCallback(
    React.useCallback(
      (
        get,
        set,
        ops: readonly Op[],
        extra: { views?: readonly ViewWrite[]; cause?: string } = {},
      ) => {
        const writes = extra.views ?? []
        if (ops.length === 0 && writes.length === 0) return
        if (!get(isDatabaseModeAtom)) {
          const now = Date.now()
          set(sampleGraphAtom, applyOps(get(sampleGraphAtom), ops, now))
          // As the runtime does: a deleted node takes its view with it, and
          // the batch's own view writes land after.
          const views = get(viewsAtom)
          const rows = [
            ...orphanedViews(views, deletedIdsOf(ops), now),
            ...patchedViews(get(viewByRootAtom), writes, now),
          ]
          set(viewsAtom, applyViewRows(views, rows))
          return
        }
        const origin = get(sharedOriginAtom)
        const route =
          origin.size === 0 || ops.length === 0 ? { kind: "own" as const } : routeOps(ops, origin)
        if (route.kind === "own") {
          databaseApplyOps(ops, writes, extra.cause)
          return
        }
        if (route.kind === "mixed" || namesOwnNodes(ops, origin, get(databaseGraphAtom))) {
          toast("Blocks can’t be moved between your notes and notes shared with you.")
          return
        }
        sharedApplyOps(route.shareId, ops)
        databaseApplyViews(patchedViews(get(viewByRootAtom), writes, Date.now()))
      },
      [],
    ),
  )
}
