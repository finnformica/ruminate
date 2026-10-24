import { useAtomValue } from "jotai"
import React from "react"
import { restoreViewFrames, viewPathHint } from "../data/view-stack"
import { viewByRootAtom } from "../data/views"
import { graphSnapshotAtom, viewEntriesAtom } from "../global-state"

/**
 * Each View's path hint, by its root id (`viewPathHint`): what the palette's
 * Views list shows after a row's name, as the sidebar does. A one-frame View
 * has none, and is not in the map.
 */
export function useViewHints(): ReadonlyMap<string, string> {
  const entries = useAtomValue(viewEntriesAtom)
  const byRoot = useAtomValue(viewByRootAtom)
  const graph = useAtomValue(graphSnapshotAtom)
  return React.useMemo(() => {
    const hints = new Map<string, string>()
    for (const entry of entries) {
      const stack = byRoot.get(entry.id)?.stack
      if (!stack) continue
      const frames = restoreViewFrames({ rootId: entry.id, noteId: entry.noteId, stack }, graph)
      const hint = frames ? viewPathHint(frames, graph) : ""
      if (hint) hints.set(entry.id, hint)
    }
    return hints
  }, [entries, byRoot, graph])
}
