import type { BlockDoc } from "../blocks/types"
import type { NoteId } from "../schema"
import { docFromGraph, docToParts, NOTE_TYPE, type GraphSnapshot } from "./graph"
import { noteIds, parentsIndex, partsToOps, reachableFrom, reservedNoteIds, type Op } from "./ops"

/**
 * The Unassigned basket (docs/graph-schema-v2.md, "Delete").
 *
 * A block belongs to a note by being reachable from its note node; a block
 * that nothing reaches any more — its parent was deleted, or its last link
 * removed — would otherwise be invisible. Every block also carries a note id
 * (`notes_id`: the note it was written in, set once at creation), and a
 * block no note reaches shows in that note's basket, beneath the outline,
 * where it can be edited, pasted back into the outline (which links it, and
 * so takes it out of the basket) or deleted for good. Removing a row in the
 * outline is how a block gets here (`docToOps` unlinks, never deletes);
 * removing a row here is the delete.
 *
 * "No note reaches it" — not "it has no parent": two blocks that hold each
 * other and have lost their link to the note both have a parent, yet neither
 * can be seen. Reachability from the notes catches both.
 */

/** Ids of the live blocks no note reaches. */
export function unassignedIds(snapshot: GraphSnapshot): Set<string> {
  const reached = reachableFrom(snapshot, noteIds(snapshot))
  const out = new Set<string>()
  for (const node of snapshot.nodes.values()) {
    if (node.type !== NOTE_TYPE && !reached.has(node.id)) out.add(node.id)
  }
  return out
}

/**
 * The roots of a note's basket, in the order they are shown: the note's
 * unassigned blocks that no other unassigned block of the note holds, most
 * recently changed first. A loop of unassigned blocks (each holding the
 * other) has no such root; its oldest-id member is promoted so the loop is
 * shown at all.
 */
export function basketRootIds(noteId: NoteId, snapshot: GraphSnapshot): string[] {
  const unassigned = unassignedIds(snapshot)
  const ofNote = new Set<string>()
  for (const id of unassigned) if (snapshot.nodes.get(id)?.notes_id === noteId) ofNote.add(id)
  if (ofNote.size === 0) return []
  const parentsOf = parentsIndex(snapshot)
  const roots = [...ofNote].filter(
    (id) => ![...(parentsOf.get(id) ?? [])].some((parent) => ofNote.has(parent)),
  )
  // Promote a member of any loop the roots do not reach.
  let covered = reachableFrom(snapshot, roots)
  const stranded = () => [...ofNote].filter((id) => !covered.has(id) && !roots.includes(id)).sort()
  for (let left = stranded(); left.length > 0; left = stranded()) {
    roots.push(left[0])
    covered = reachableFrom(snapshot, roots)
  }
  const stamp = (id: string) => snapshot.nodes.get(id)?.updated_at ?? 0
  return roots.sort((a, b) => stamp(b) - stamp(a) || (a < b ? -1 : 1))
}

/** A note's basket as a doc: its roots and what they hold. */
export function basketDoc(noteId: NoteId, snapshot: GraphSnapshot): BlockDoc {
  return docFromGraph(basketRootIds(noteId, snapshot), snapshot)
}

/**
 * The batch that makes the graph hold `doc` as note `noteId`'s basket — the
 * same diff as `docToOps` (text, type, order, a deleted root), except that
 * the roots hang from nothing: the basket is not the outline. A basket block
 * the doc no longer names, that nothing holds, is deleted; what it held
 * stays in the basket.
 */
export function basketToOps(noteId: NoteId, doc: BlockDoc, snapshot: GraphSnapshot): Op[] {
  const before = basketDoc(noteId, snapshot)
  const { nodes, childrenOf } = docToParts(noteId, doc, 0, reservedNoteIds(snapshot, noteId))
  // The note node and its root order are the outline's business, not the
  // basket's: drop them so the diff touches only the basket's blocks.
  const blocks = nodes.filter((node) => node.id !== noteId)
  childrenOf.delete(noteId)
  // A row removed here is deleted: there is nothing to unlink it from, and
  // the basket is where a block is deleted for good.
  return partsToOps(
    noteId,
    blocks,
    childrenOf,
    snapshot,
    new Set(Object.keys(before.blocks)),
    "delete",
  )
}
