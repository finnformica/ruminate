import { blockId } from "../blocks/id"

/**
 * A note's id is minted and opaque (docs/page-identity-design.md): a page is a
 * node like any other, so it takes an ordinary `blk_` id from the one minting
 * path every node uses. The note's *name* is its title — data on the page node,
 * free of the filename charset and of any uniqueness requirement.
 *
 * Daily and weekly notes are the deliberate exception and keep their date ids
 * (`isDatePageId`, src/data/page-identity.ts): there the date is the identity
 * and never renames.
 */
export function generateNoteId(): string {
  return blockId()
}
