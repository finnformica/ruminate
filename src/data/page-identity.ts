import { isValidDateString, isValidWeekString } from "../utils/date"

/**
 * Page identity (docs/graph-storage.md) — what names a page, and where
 * its title lives.
 *
 * A page used to *be* its title: the node id, the `<id>.md` key, the route
 * param and the visible name were one string, so renaming was id surgery and
 * every old link died. Now a page is a node like any other — an opaque minted
 * id — and **the title is data**: the page node's `text`.
 *
 * ## One id space
 *
 * Pages mint ordinary `blk_` ids (`src/blocks/id.ts`), not a second prefix: a
 * page is a node whose `type` is `page`, and the type column already carries
 * that distinction (design doc, amendment 1). One minting path, one id space —
 * which is also why the ingest's page-id reservation guard still means
 * something: page and block ids live in the same table.
 *
 * ## The date carve-out
 *
 * Daily and weekly pages keep their date ids (`2026-08-31`, `2026-W35`). The
 * date **is** the identity and never renames, so minting would buy nothing and
 * cost the calendar, the date-mention index and every `isValidDateString` call
 * site. `isDatePageId` is that seam, named once here so it is greppable.
 *
 * ## How a title travels
 *
 * The editor edits a `BlockDoc`; the page's title rides that doc's props as
 * `title` (`pageDoc` puts it there from the node's `text`, `docToParts` lifts
 * it back out), so it is stored once and the editor never learns where. No
 * `title` means an untitled page (its text is its id) or a date page (whose
 * text IS its id), and `emittedPageTitle` is that rule.
 */

/** The prefix every minted id carries — pages and blocks alike. */
const MINTED_ID_PREFIX = "blk_"

/**
 * Is this id a date/week natural key — a page that must NOT be minted? The one
 * seam between page identity and the calendar (see the module header).
 */
export function isDatePageId(id: string): boolean {
  return isValidDateString(id) || isValidWeekString(id)
}

/**
 * Is this id opaque (minted) rather than something to show a human? Used by the
 * display-name ladder: a minted id is never a fallback title.
 */
export function isMintedNoteId(id: string): boolean {
  return id.startsWith(MINTED_ID_PREFIX)
}

/**
 * The title a page's doc should carry for a page node, or null for none.
 *
 * Null in the two cases where a title would be noise rather than data: an
 * untitled page (a freshly minted note, whose `text` is still its own id) and a
 * date page (whose `text` *is* its id by design). Both keep the exact bytes
 * they have today.
 */
export function emittedPageTitle(id: string, text: string): string | null {
  if (text === "" || text === id) return null
  return text
}
