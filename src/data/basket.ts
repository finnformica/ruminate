import type { BlockDoc } from "../blocks/types"
import type { NoteId } from "../schema"
import { docFromGraph, docToParts, PAGE_TYPE, type GraphSnapshot } from "./graph"
import { pageIds, parentsIndex, partsToOps, reachableFrom, reservedPageIds, type Op } from "./ops"

/**
 * The Unassigned basket (docs/graph-schema-v2.md, "Delete").
 *
 * A block belongs to a note by being reachable from its page node; a block
 * that nothing reaches any more — its parent was deleted, or its last link
 * removed — would otherwise be invisible. Every block also has a **home**
 * (`home_id`: the note it was written in, set once at creation), and a
 * homed block no page reaches shows in its home note's basket, beneath the
 * outline, where it can be edited, pasted back into the outline (which links
 * it, and so takes it out of the basket) or deleted for good.
 *
 * "No page reaches it" — not "it has no parent": two blocks that hold each
 * other and have lost their link to the page both have a parent, yet neither
 * can be seen. Reachability from the pages catches both.
 */

/** Ids of the live blocks no page reaches. */
export function unassignedIds(snapshot: GraphSnapshot): Set<string> {
  const reached = reachableFrom(snapshot, pageIds(snapshot))
  const out = new Set<string>()
  for (const node of snapshot.nodes.values()) {
    if (node.type !== PAGE_TYPE && !reached.has(node.id)) out.add(node.id)
  }
  return out
}

/**
 * The roots of a page's basket, in the order they are shown: the page's
 * unassigned blocks that no other unassigned block of the page holds, most
 * recently changed first. A loop of unassigned blocks (each holding the
 * other) has no such root; its oldest-id member is promoted so the loop is
 * shown at all.
 */
export function basketRootIds(pageId: NoteId, snapshot: GraphSnapshot): string[] {
  const unassigned = unassignedIds(snapshot)
  const homed = new Set<string>()
  for (const id of unassigned) if (snapshot.nodes.get(id)?.home_id === pageId) homed.add(id)
  if (homed.size === 0) return []
  const parentsOf = parentsIndex(snapshot)
  const roots = [...homed].filter(
    (id) => ![...(parentsOf.get(id) ?? [])].some((parent) => homed.has(parent)),
  )
  // Promote a member of any loop the roots do not reach.
  let covered = reachableFrom(snapshot, roots)
  const stranded = () => [...homed].filter((id) => !covered.has(id) && !roots.includes(id)).sort()
  for (let left = stranded(); left.length > 0; left = stranded()) {
    roots.push(left[0])
    covered = reachableFrom(snapshot, roots)
  }
  const stamp = (id: string) => snapshot.nodes.get(id)?.updated_at ?? 0
  return roots.sort((a, b) => stamp(b) - stamp(a) || (a < b ? -1 : 1))
}

/** A page's basket as a doc: its roots and what they hold. */
export function basketDoc(pageId: NoteId, snapshot: GraphSnapshot): BlockDoc {
  return docFromGraph(basketRootIds(pageId, snapshot), snapshot)
}

/**
 * The batch that makes the graph hold `doc` as page `pageId`'s basket — the
 * same diff as `docToOps` (text, type, order, a deleted root), except that
 * the roots hang from nothing: the basket is not the outline. A basket block
 * the doc no longer names, that nothing holds, is deleted; what it held
 * stays in the basket.
 */
export function basketToOps(pageId: NoteId, doc: BlockDoc, snapshot: GraphSnapshot): Op[] {
  const before = basketDoc(pageId, snapshot)
  const { nodes, childrenOf } = docToParts(pageId, doc, 0, reservedPageIds(snapshot, pageId))
  // The page node and its root order are the outline's business, not the
  // basket's: drop them so the diff touches only the basket's blocks.
  const blocks = nodes.filter((node) => node.id !== pageId)
  childrenOf.delete(pageId)
  return partsToOps(pageId, blocks, childrenOf, snapshot, new Set(Object.keys(before.blocks)))
}
