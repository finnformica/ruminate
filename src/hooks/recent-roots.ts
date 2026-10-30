import { useAtomValue } from "jotai"
import { useEffect, useMemo } from "react"
import { databaseEnsureNodes } from "../data/database-mode"
import { graphSnapshotAtom, recentVisitsAtom, sortedNotesAtom } from "../global-state"
import { rankRecents } from "../utils/recents"
import type { ResultRoot } from "./results-doc"

/**
 * The **Recent** list as roots the results editor can walk — a note opens
 * itself, a block opens its note focused on it — ranked by frecency as of
 * the moment it was drawn (`rankRecents`). One list, drawn by the ⌘K palette
 * with nothing typed.
 */
export function useRecentRoots(): ResultRoot[] {
  const visits = useAtomValue(recentVisitsAtom)
  const notes = useAtomValue(sortedNotesAtom)
  const graph = useAtomValue(graphSnapshotAtom)
  // A recent block in a note not opened this session is not in the graph
  // yet (docs/events-log-cache.md, "The client"): its node is read so the
  // row can be drawn.
  useEffect(() => {
    const missing = visits.map((visit) => visit.id).filter((id) => !graph.nodes.has(id))
    if (missing.length > 0) void databaseEnsureNodes(missing)
  }, [visits, graph])
  return useMemo(
    () => rankRecents(visits, notes, (id) => graph.nodes.has(id), Date.now()),
    [visits, notes, graph],
  )
}
