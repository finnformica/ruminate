/**
 * Note identity (docs/graph-storage.md) — what names a note, and where
 * its title lives.
 *
 * A note used to *be* its title: the node id, the `<id>.md` key, the route
 * param and the visible name were one string, so renaming was id surgery and
 * every old link died. Now a note is a node like any other — an opaque minted
 * id — and **the title is data**: the note node's `text`.
 *
 * ## One id space
 *
 * Notes mint ordinary `blk_` ids (`src/blocks/id.ts`), not a second prefix: a
 * note is a node whose stored `type` is `note`, and the type column already carries
 * that distinction (design doc, amendment 1). One minting path, one id space —
 * which is also why the ingest's note-id reservation guard still means
 * something: note and block ids live in the same table.
 *
 * ## How a title travels
 *
 * The editor edits a `BlockDoc`; the note's title rides that doc's props as
 * `title` (`noteDoc` puts it there from the node's `text`, `docToParts` lifts
 * it back out), so it is stored once and the editor never learns where. No
 * `title` means an untitled note (its text is its id), and `emittedNoteTitle`
 * is that rule.
 */

/** The prefix every minted id carries — notes and blocks alike. */
const MINTED_ID_PREFIX = "blk_"

/**
 * Is this id opaque (minted) rather than something to show a human? Used by the
 * display-name ladder: a minted id is never a fallback title.
 */
export function isMintedNoteId(id: string): boolean {
  return id.startsWith(MINTED_ID_PREFIX)
}

/**
 * The title a note's doc should carry for a note node, or null for none:
 * an untitled note (a freshly minted note, whose `text` is still its own id)
 * has no title to carry.
 */
export function emittedNoteTitle(id: string, text: string): string | null {
  if (text === "" || text === id) return null
  return text
}
