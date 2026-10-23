import { useAtomValue } from "jotai"
import React from "react"
import { rootChildIds } from "../data/graph"
import { sharedOriginAtom } from "../data/shared-mode"
import { graphSnapshotAtom } from "../global-state"
import type { ResultRoot } from "./results-doc"

const NO_ROOTS: readonly ResultRoot[] = []

/**
 * The Root frame's roots (docs/graph-walk.md, decision 5): every live note
 * of the user's own, first the notes the corpus root links, in their order,
 * then the rest by title (`rootChildIds`). The notes other people shared are
 * listed apart, so they are left out. Drawn by the palette's own editor
 * (`ResultsEditor`), so Root and the palette are one row renderer. Nothing
 * when `enabled` is false: the walk is only for the Root frame.
 */
export function useRootRoots(enabled: boolean): readonly ResultRoot[] {
  const graph = useAtomValue(graphSnapshotAtom)
  const shared = useAtomValue(sharedOriginAtom)
  return React.useMemo(() => {
    if (!enabled) return NO_ROOTS
    const exclude = shared.size > 0 ? new Set(shared.keys()) : undefined
    return rootChildIds(graph, exclude).map((id) => ({ id, noteId: id }))
  }, [enabled, graph, shared])
}
