import { useAtomValue } from "jotai"
import { useMemo } from "react"
import { graphSnapshotAtom, recentVisitsAtom, sortedNotesAtom } from "../global-state"
import { rankRecents } from "../utils/recents"
import type { ResultRoot } from "./results-doc"

/**
 * The **Recent** list as roots the results editor can walk — a note opens
 * itself, a block opens its note focused on it — ranked by frecency as of
 * the moment it was drawn (`rankRecents`). One list, drawn by the ⌘K palette
 * with nothing typed and by the notes page above its Views.
 */
export function useRecentRoots(): ResultRoot[] {
  const visits = useAtomValue(recentVisitsAtom)
  const notes = useAtomValue(sortedNotesAtom)
  const graph = useAtomValue(graphSnapshotAtom)
  return useMemo(
    () => rankRecents(visits, notes, (id) => graph.nodes.has(id), Date.now()),
    [visits, notes, graph],
  )
}
