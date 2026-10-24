import { generateNKeysBetween } from "fractional-indexing"
import {
  CORPUS_ROOT_ID,
  ROOT_TYPE,
  isNoteType,
  noteOrderIds,
  sortKeyBetween,
  type GraphSnapshot,
} from "./graph"
import { notePropsOps } from "./note-meta"
import type { Op } from "./ops"
import type { NoteId } from "../schema"

/**
 * The **manual note order the graph holds** (docs/graph-storage.md,
 * "Ordering notes"): the order of the Root frame's rows, which a drag
 * there writes (`moveNoteOps`, docs/graph-walk.md, decision 5).
 *
 * Sibling order for a block is a `sort_key` on the `child` link from its
 * parent, and notes once got exactly the same mechanism: the corpus root
 * (`ROOT_TYPE`) holds every note that was placed by hand, and the key on its
 * link says where the note sits. The Views list has since taken the order
 * onto the view rows themselves (`src/data/views.ts`, `sort_key`), where a
 * block view can sit between two notes. The root's links order the Root
 * frame (`src/data/root-frame.ts`): the notes the root holds lead, in its
 * order, then the rest by title, and a drag of a row there writes them.
 *
 * The root is **ordering-only**: a note it does not hold is an ordinary note
 * with no manual position. `orderedNoteIds` returns the placed notes;
 * everything else is the caller's fallback band.
 */

const isNote = (snapshot: GraphSnapshot, id: string) =>
  isNoteType(snapshot.nodes.get(id)?.type ?? "")

/**
 * The manually placed notes, in their order — live notes only.
 *
 * A delete does not cascade to link rows (`ops-rows.ts`), so the stored order
 * can name a note that is no longer in the graph; such ids are dropped here
 * rather than written out, which keeps deleting a note free of any order
 * bookkeeping.
 */
export function orderedNoteIds(snapshot: GraphSnapshot): NoteId[] {
  return noteOrderIds(snapshot).filter((id) => isNote(snapshot, id))
}

/** The ops that put the corpus root in the graph, or none when it is already
 * there. Made on the first drag rather than at boot, so a corpus nobody has
 * reordered carries no root row at all. */
function ensureRootOps(snapshot: GraphSnapshot): Op[] {
  if (snapshot.nodes.has(CORPUS_ROOT_ID)) return []
  return [{ op: "create", id: CORPUS_ROOT_ID, type: ROOT_TYPE, text: "", props: null }]
}

/** The key the root's link to each placed note carries. */
function keysByNote(snapshot: GraphSnapshot): Map<string, string> {
  const keys = new Map<string, string>()
  for (const link of snapshot.childLinks.get(CORPUS_ROOT_ID) ?? []) {
    keys.set(link.destination_id, link.sort_key)
  }
  return keys
}

/** Key every note in `live` from scratch, evenly spaced: the first drag, where
 * there is no order to move within. */
function seedOps(live: NoteId[], snapshot: GraphSnapshot): Op[] {
  const keys = generateNKeysBetween(null, null, live.length)
  return [
    ...ensureRootOps(snapshot),
    ...live.map((id, index): Op => ({
      op: "link",
      source: CORPUS_ROOT_ID,
      destination: id,
      sortKey: keys[index],
    })),
  ]
}

/**
 * The ops that move one note in the Root frame. `desired` is the full list of
 * the frame's rows in the order they now sit — what the frame drew, with the
 * dragged row at its new place — and `noteId` is the row that moved.
 *
 * In the steady state this is **one link row**: the moved note takes a key
 * between the two it now sits between, and nothing else changes. The first
 * drag writes more, because there are no keys yet to move between
 * (`seedOps`): it keys every row, so the order on screen is the one kept.
 *
 * The moved note's `updated_at` is stamped too: the key rides a link row, so
 * the note node would otherwise not record the change.
 *
 * `reconcileSortKeys` is not used here. It takes a whole new child order and
 * keeps the first run of keys it can, so a note dragged to the front would
 * re-key every note it passed. A drag knows which row moved.
 */
export function moveNoteOps(
  noteId: NoteId,
  desired: readonly NoteId[],
  snapshot: GraphSnapshot,
): Op[] {
  const live = desired.filter((id) => isNote(snapshot, id))
  const index = live.indexOf(noteId)
  if (index === -1) return []

  const keys = keysByNote(snapshot)
  // Every note but the one that moved needs a key to move between; without
  // that, this is the first drag and the whole list is keyed at once.
  const placed = live.every((id) => id === noteId || keys.get(id) !== undefined)
  if (!placed) return seedOps(live, snapshot)

  const before = index > 0 ? (keys.get(live[index - 1]) ?? null) : null
  const after = index < live.length - 1 ? (keys.get(live[index + 1]) ?? null) : null
  // The neighbours' keys must bracket the gap. A drag keeps the placed notes
  // in their stored order, so they do; a caller that moved several at once
  // lands here, and keying the list again is the honest answer.
  if (before !== null && after !== null && before >= after) return seedOps(live, snapshot)
  const key = sortKeyBetween(before, after)
  if (keys.get(noteId) === key) return []

  return [
    ...ensureRootOps(snapshot),
    { op: "link", source: CORPUS_ROOT_ID, destination: noteId, sortKey: key },
    ...notePropsOps(noteId, {}, snapshot),
  ]
}
