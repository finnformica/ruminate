import type { Note, NoteId } from "../schema"
import { searchBlocks, type BlockHit, type BlockIndex } from "./block-search"
import { parseQuery } from "./search"

/**
 * **The data source behind block search results.**
 *
 * Everything the results UI needs, and nothing else: resolve a query to hits,
 * and resolve one hit to its direct children (for lazy expansion). Components
 * and hooks talk to this interface only — they never reach into the block
 * index, the atoms behind it, or a store.
 *
 * Both methods are **await-tolerant**: they may return a value or a promise of
 * one. Today's implementation (`inMemoryBlockSearchSource`) is synchronous and
 * the UI renders its results in the same pass — no loading state, no extra
 * render. A future implementation that answers over the network (server-side
 * search across a corpus too large to hold client-side) returns promises
 * instead, and the *hooks* absorb the difference: `useSearchResults` and
 * `useBlockResultTree` already handle both shapes. That is the whole swap —
 * one factory, at the single call site in `src/hooks/search-results.ts`.
 *
 * The contract an async implementation must keep:
 * - `search` returns hits in result order; each hit carries its own text,
 *   type, breadcrumb `ancestors`, containing `note`, and `childCount` (the
 *   has-downstream flag the expand chevron is drawn from).
 * - `children` returns direct children in document order, each itself a hit
 *   with a correct `childCount`, so the next level expands the same way.
 * - `children` is expected to be cheap on repeat: memoize it (see
 *   `createChildResolver`, which caches promises just as well as arrays).
 */
export interface BlockSearchSource {
  /** Blocks matching a query, in result order. */
  search(query: string): BlockHit[] | Promise<BlockHit[]>
  /** One hit's direct children, in document order. Empty for a leaf. */
  children(hit: BlockHit): BlockHit[] | Promise<BlockHit[]>
  /**
   * A NOTE as a result row (see `noteHit`). Synchronous, unlike the two
   * above: everything but the has-downstream flag comes from the `Note` the
   * caller already holds, and a source with no cheap count for it may
   * approximate — `childCount` is a presence flag, never a total.
   */
  noteHit(note: Note): BlockHit
}

/**
 * **A note, as a result row.** A note IS a node (docs/graph-schema-v2.md):
 * its type is `note`, its `text` is its title, and its children are its
 * top-level blocks. So a note result is simply a ROOT ROW whose children can
 * be revealed — exactly what a block result is — and the results list draws
 * both with the editor's own row component.
 *
 * `blockId === noteId` is what makes a note row tellable from a block that
 * merely has the `note` type (a note linked under a block renders as one —
 * `docFromGraph`); `isNoteHit` is the predicate everything else asks.
 */
export function noteHit(note: Note, childCount: number): BlockHit {
  return {
    blockId: note.id,
    noteId: note.id,
    text: note.displayName,
    type: "note",
    olNumber: 1,
    // A note is the top of its own outline: there is nothing above it, which
    // is also why a note row carries no breadcrumb.
    ancestors: [],
    childCount,
    note,
  }
}

/** Is this hit the note itself, rather than a block inside one? */
export function isNoteHit(hit: BlockHit): boolean {
  return hit.type === "note" && hit.blockId === hit.noteId
}

/**
 * The source the app runs on: the client-side block index (`blockIndexAtom`),
 * queried synchronously. The index is incremental — only notes whose content
 * changed are re-parsed — so this costs nothing per keystroke beyond the
 * filter itself.
 */
export function inMemoryBlockSearchSource(index: BlockIndex): BlockSearchSource {
  // A note's OWN children are not in the index's parent → child table: that
  // table is keyed by parent block, and a note's top-level blocks have no
  // parent block. They are read off the hits' own ancestry instead, in one
  // pass built on first use — so a page that never expands a note (and one
  // that never lists any) pays nothing for it.
  let noteRoots: Map<NoteId, BlockHit[]> | null = null
  const rootsOf = (noteId: NoteId): BlockHit[] => {
    if (!noteRoots) {
      noteRoots = new Map()
      for (const hit of index.hits) {
        if (hit.ancestors.length > 0) continue
        const roots = noteRoots.get(hit.noteId)
        if (roots) roots.push(hit)
        else noteRoots.set(hit.noteId, [hit])
      }
    }
    return noteRoots.get(noteId) ?? []
  }

  return {
    search: (query) => searchBlocks(parseQuery(query), index),
    // Already memoized per block by the index (see `createChildResolver`).
    children: (hit) => (isNoteHit(hit) ? rootsOf(hit.noteId) : index.getChildren(hit)),
    noteHit: (note) => noteHit(note, rootsOf(note.id).length),
  }
}
