/**
 * One-time (plus ingest-forward) normalization of near-miss block markers —
 * the deliberate end of byte preservation for misspelled markers.
 *
 * During the markdown→graph migration, ingest typed a block only on the
 * canonically-spelled marker (`[ ] `, `[x] `, `- `, `1. ` at run position…)
 * and kept every near-miss spelling verbatim as a `text` node. That byte
 * fidelity made sense while stored bytes were truth; now that the graph is
 * truth it is a wart: `[] buy milk` renders untyped and is invisible to
 * `type:todo` search, even though the editor's own `getBlockType`
 * (src/blocks/block-type.ts) already *displays* it as a todo.
 *
 * `normalizeBlockText` recognizes a conservative set of near-miss spellings
 * and returns the canonical typed form. The set deliberately mirrors what
 * `getBlockType` already treats as typed — normalizing exactly the
 * ingest/display mismatch — with these documented exceptions:
 *
 * - `#Heading` (no space) stays text. `#word` is the app's tag syntax
 *   (src/remark-plugins/tag.ts), so a heading intent is indistinguishable
 *   from a tag; `getBlockType` agrees (HEADING_RE requires a space). Same for
 *   `##foo` — the editor renders it as a paragraph, so ingest must not
 *   promote it.
 * - Ordered markers are capped at three digits (`999. ` normalizes, `1990. `
 *   does not). The graph's `ol` type renumbers by run position, so the typed
 *   number is discarded — fine for a stray `2)`, destructive for a year
 *   starting a sentence ("1990. That was the year…"). `getBlockType` accepts
 *   any digits; ingest stays conservative because normalizing is lossy.
 * - The marker must be followed by exactly one space and then content. A bare
 *   `[]` (nothing to check off), `[x]tight` (could be prose like "[x]marks"),
 *   and tab-separated markers all stay text — ambiguous, so verbatim wins.
 *
 * It runs at ingest (`docToGraphParts`), so every save normalizes what it
 * writes. Rows written before it existed keep their near-miss spelling until
 * their note is next saved. Keep it dependency-free.
 */

export interface NormalizedBlockText {
  type: "todo" | "done" | "ul" | "ol"
  text: string
}

/** `[] x` — the shorthand the canonical `[ ] ` marker is a near-miss of. */
const SHORTHAND_TODO_RE = /^\[\] (?=\S)/
/** `[X] x` — uppercase done marker (canonical is `[x] `). */
const CAPS_DONE_RE = /^\[X\] (?=\S)/
/** `* x` / `+ x` — CommonMark bullets the canonical `- ` is one of. The
 * single-space requirement keeps `**bold**` and `+1 point` untouched. */
const ALT_BULLET_RE = /^[*+] (?=\S)/
/** `2) x`, `01. x`, `7. x` (wrong run position) — near-miss ordered markers.
 * Three digits max: see the header note on why years stay text. */
const NEAR_ORDERED_RE = /^\d{1,3}[.)] (?=\S)/

/**
 * The canonical typed form of a near-miss marker spelling, or `null` when the
 * line is not a recognized near-miss (anything ambiguous stays text). Callers
 * must only apply this outside code fences, and only to lines the canonical
 * classifier (`classifyLine` in graph.ts) already left as `text`.
 */
export function normalizeBlockText(line: string): NormalizedBlockText | null {
  if (SHORTHAND_TODO_RE.test(line)) return { type: "todo", text: line.slice(3) }
  if (CAPS_DONE_RE.test(line)) return { type: "done", text: line.slice(4) }
  if (ALT_BULLET_RE.test(line)) return { type: "ul", text: line.slice(2) }
  const ordered = NEAR_ORDERED_RE.exec(line)
  if (ordered) return { type: "ol", text: line.slice(ordered[0].length) }
  return null
}
