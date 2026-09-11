import { canonicalFrontmatterYaml, parseFrontmatter } from "../utils/frontmatter"
import { isValidDateString, isValidWeekString } from "../utils/date"

/**
 * Page identity (docs/archive/page-identity-design.md) — what names a page, and where
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
 * Everything above `src/data` reads notes as markdown through the `<id>.md`
 * files atom, so the title has to survive that seam. It rides as a
 * **projection-owned frontmatter key**: the rollup injects `title:` from the
 * page node's `text`, ingest lifts it back out into `text` (and keeps it out of
 * `props`, so it is never stored twice), and `parseNote` prefers it over the
 * first `# ` heading. The editor and the markdown bridge never learn about it,
 * and exports carry their titles.
 *
 * The injection rule is `text !== id && text !== ""`, which is what keeps the
 * round trip a fixpoint *and* leaves date pages untouched: their `text` equals
 * their id, so no `title:` key is emitted and their bytes are unchanged.
 */

/** The prefix every minted id carries — pages and blocks alike. */
const MINTED_ID_PREFIX = "blk_"

/** The frontmatter key the projection owns (see the module header). It is also
 * shown as the title, never as a user-facing property
 * chip — the title is shown as the title, not as metadata. */
const TITLE_KEY = "title"

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

// -----------------------------------------------------------------------------
// The title's ride through the `<id>.md` seam
// -----------------------------------------------------------------------------

/**
 * Split a projection-owned `title:` out of a page's raw frontmatter text.
 * Returns the title (null when the key is absent or not a string) and the
 * frontmatter with that line removed — null when nothing is left, so a page
 * whose only frontmatter was its title ingests with `props` null.
 *
 * Removal is line-based, which is exactly the shape both frontmatter forms
 * take: the canonical serializer emits one `key: value` line per entry, and
 * hand-written frontmatter that spans lines cannot be a scalar `title` anyway.
 */
export function liftTitleFromFrontmatter(raw: string | null): {
  title: string | null
  rest: string | null
} {
  if (raw === null) return { title: null, rest: null }
  const { frontmatter } = parseFrontmatter(`---\n${raw}\n---\n`)
  const value = frontmatter[TITLE_KEY]
  if (typeof value !== "string") return { title: null, rest: raw }
  const kept = raw.split("\n").filter((line) => !isTitleLine(line))
  return { title: value, rest: kept.length > 0 ? kept.join("\n") : null }
}

/** Does this frontmatter line declare the projection-owned `title` key? */
function isTitleLine(line: string): boolean {
  const match = line.match(/^\s*(?:"([^"]*)"|'([^']*)'|([^:\s][^:]*?))\s*:/)
  if (!match) return false
  const key = match[1] ?? match[2] ?? match[3]?.trim() ?? ""
  return key === TITLE_KEY
}

/**
 * Put a page's title back at the head of its frontmatter text — the rollup's
 * half of the round trip. The value goes through the canonical serializer, so a
 * title carrying a colon, a `#`, or anything else YAML would misread is quoted
 * the same way every other frontmatter value is.
 */
export function injectTitleIntoFrontmatter(raw: string | null, title: string): string {
  const line = canonicalFrontmatterYaml({ [TITLE_KEY]: title })
  return raw === null ? line : `${line}\n${raw}`
}

/**
 * The title the rollup should emit for a page node, or null for none.
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
