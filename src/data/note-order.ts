import { NOTE_TYPE, noteOrderIds, type GraphSnapshot } from "./graph"
import type { NoteId } from "../schema"

/**
 * The **manual note order the graph holds** (docs/graph-storage.md,
 * "Ordering notes") — read, never written any more.
 *
 * Sibling order for a block is a `sort_key` on the `child` link from its
 * parent, and notes once got exactly the same mechanism: the corpus root
 * (`ROOT_TYPE`) holds every note that was placed by hand, and the key on its
 * link says where the note sits. The Views list has since taken the order
 * onto the view rows themselves (`src/data/views.ts`, `sort_key`), where a
 * block view can sit between two notes; nothing writes the root's links now.
 * They are still read so a corpus dragged into an order before then keeps
 * it: the notes the root holds lead, in that order, until the first drag of
 * the Views list keys every row and the root stops mattering.
 *
 * The root is **ordering-only**: a note it does not hold is an ordinary note
 * with no manual position. `orderedNoteIds` returns the placed notes;
 * everything else is the caller's fallback band.
 */

const isNote = (snapshot: GraphSnapshot, id: string) => snapshot.nodes.get(id)?.type === NOTE_TYPE

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
