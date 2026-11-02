import { useAtomValue, useStore } from "jotai"
import React from "react"
import { blockId } from "../blocks/id"
import { TRACKER_TYPE } from "../data/graph"
import { notePropsOps } from "../data/note-meta"
import type { Op } from "../data/ops"
import { useApplyOps } from "../data/store"
import {
  addSeriesOps,
  isTracker,
  newTrackerOps,
  removeSeriesOps,
  setEntryOps,
  trackerSeries,
  updateSeriesOps,
  type DayString,
  type SeriesPatch,
  type SeriesState,
} from "../data/tracker"
import { graphSnapshotAtom } from "../global-state"
import type { NoteId } from "../schema"

/**
 * Making a tracker (docs/trackers.md): the note's root given the `tracker`
 * type. **New tracker** makes the node first (`create`, with its title);
 * **Make this a tracker** retypes the note that is there. Nothing beneath
 * the root changes, and no series is written: the page's **Series** editor
 * adds them.
 */
export function useMakeTracker(): (noteId: NoteId, create?: { title: string }) => void {
  const store = useStore()
  const apply = useApplyOps()
  return React.useCallback(
    (noteId, create) => {
      const snapshot = store.get(graphSnapshotAtom)
      const ops: Op[] = []
      if (snapshot.nodes.has(noteId)) {
        ops.push({ op: "setType", id: noteId, type: TRACKER_TYPE })
        // The note is edited: its `updated_at` moves with it.
        ops.push(...notePropsOps(noteId, {}, snapshot))
      } else if (create) {
        ops.push(...newTrackerOps(snapshot, noteId, create.title))
      } else return
      apply(ops)
    },
    [store, apply],
  )
}

/** A tracker as the page draws it: whether the note is one, and its series
 * with their entries, derived from the live graph so a change on another
 * device is on the grid at once. */
export function useTracker(trackerId: NoteId): { exists: boolean; series: SeriesState[] } {
  const snapshot = useAtomValue(graphSnapshotAtom)
  return React.useMemo(
    () => ({ exists: isTracker(snapshot, trackerId), series: trackerSeries(snapshot, trackerId) }),
    [snapshot, trackerId],
  )
}

/** What the tracker page writes, each a batch of ops on the tracker's own
 * graph through the one write seam (`useApplyOps`). */
export interface TrackerWrites {
  /** A new series after the others; its id, so the editor can open it. */
  addSeries: (patch?: SeriesPatch) => string | null
  updateSeries: (seriesId: string, patch: SeriesPatch) => void
  removeSeries: (seriesId: string) => void
  /** A day's value on a series: `null` or `false` clears the day. */
  setEntry: (seriesId: string, date: DayString, value: boolean | number | null) => void
}

export function useTrackerWrites(trackerId: NoteId, exists: boolean): TrackerWrites {
  const store = useStore()
  const apply = useApplyOps()
  return React.useMemo<TrackerWrites>(() => {
    const snapshot = () => store.get(graphSnapshotAtom)
    return {
      addSeries: (patch) => {
        if (!exists) return null
        const id = blockId()
        const ops = addSeriesOps(snapshot(), trackerId, id, patch)
        if (ops.length === 0) return null
        apply(ops)
        return id
      },
      updateSeries: (seriesId, patch) => apply(updateSeriesOps(snapshot(), seriesId, patch)),
      removeSeries: (seriesId) => apply(removeSeriesOps(snapshot(), seriesId)),
      setEntry: (seriesId, date, value) => apply(setEntryOps(snapshot(), seriesId, date, value)),
    }
  }, [store, apply, trackerId, exists])
}
