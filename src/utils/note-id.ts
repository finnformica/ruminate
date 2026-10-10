import { blockId } from "../blocks/id"

/**
 * A note's id is minted and opaque (docs/graph-storage.md): a note is a
 * node like any other, so it takes an ordinary `blk_` id from the one minting
 * path every node uses. The note's *name* is its title — data on the note node,
 * free of the filename charset and of any uniqueness requirement.
 */
export function generateNoteId(): string {
  return blockId()
}
