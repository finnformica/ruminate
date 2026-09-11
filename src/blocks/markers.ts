import { parseImageLine } from "./image"
import { normalizeBlockText } from "./normalize-block-text"
import type { BlockProps, BlockType } from "./types"

/**
 * **Every marker spelling lives here.** A block's type is data
 * (`Block.type`); the markdown marker that *represents* a type — `# `, `- `,
 * `[ ] `, `> `, `1. ` — exists in exactly two places: the parser (import) and
 * the serializer (export), both of which read this table. The one other use
 * is the editor's typing shortcut (`leadingMarker`): a marker typed at the
 * start of a block is stripped and becomes the block's type, which is how
 * the app keeps the feel of markdown without storing any.
 */

/**
 * The type → marker map (docs/graph-schema-v2.md). `ol` is renumbered by run
 * position (`markerFor`), `code` is fenced, `image` is a whole-line
 * `![caption](url)` (`image.ts`), `page` is a note root: those are handled
 * structurally by the serializer.
 */
const MARKER_OF_TYPE: Readonly<Record<BlockType, string>> = {
  text: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  todo: "[ ] ",
  done: "[x] ",
  ul: "- ",
  ol: "1. ",
  quote: "> ",
  code: "",
  image: "",
  page: "",
}

/** The marker a block of `type` carries on export; an ordered item takes its
 * 1-based position in its run of consecutive ordered siblings. */
export function markerFor(type: BlockType, olPosition = 1): string {
  return type === "ol" ? `${olPosition}. ` : MARKER_OF_TYPE[type]
}

/** Headings carry a single `#` on export regardless of how many were typed —
 * their size comes from outline depth — so `## Foo` reads as `# Foo`. */
function normalizeHeadingMarker(line: string): string {
  return line.replace(/^#{2,6}(\s)/, "#$1")
}

const OL_RE = /^(0|[1-9]\d*)\. /

/**
 * Classify one line of canonical markdown into `{ type, text }` — the import
 * half of the table above. `olPosition` is the 1-based position the line
 * would take in the current run of ordered siblings: an ordered marker is
 * only typed `ol` when its number matches, because the serializer renumbers
 * by run position and any other number must survive… as a near-miss, which
 * the normalization pass then folds into the run (see
 * `normalize-block-text.ts` for exactly which spellings are recognized and
 * which stay text). Inside a code fence nothing is a marker.
 */
export function classifyLine(
  line: string,
  olPosition: number,
  inFence: boolean,
): { type: BlockType; text: string; props?: BlockProps } {
  if (inFence) return { type: "text", text: line }
  // A line that is nothing but a markdown image is an image block: the
  // caption is its text and the URL its props.
  const image = parseImageLine(line)
  if (image) return { type: "image", text: image.text, props: image.props }
  const canonical = normalizeHeadingMarker(line)
  for (const type of ["h1", "todo", "done", "ul", "quote"] as const) {
    const marker = MARKER_OF_TYPE[type]
    if (canonical.startsWith(marker)) return { type, text: canonical.slice(marker.length) }
  }
  const ordered = OL_RE.exec(canonical)
  if (ordered && ordered[1] === String(olPosition)) {
    return { type: "ol", text: canonical.slice(ordered[0].length) }
  }
  const normalized = normalizeBlockText(canonical)
  if (normalized) return normalized
  return { type: "text", text: canonical }
}

const HEADING_RE = /^#{1,6}\s+/
// Accepts `[ ]`, `[x]`, `[X]`, and the shorthand `[]`.
const TODO_RE = /^\[([ xX]?)\]\s+/
const QUOTE_RE = /^>\s+/
const BULLET_RE = /^[-*]\s+/
// An ordered-list item: `1. `, `2) `, etc.
const ORDERED_RE = /^\d+[.)]\s+/

/**
 * The editor's typing shortcut: a marker typed at the very start of a
 * block's text — `# `, `- `, `[ ] `, `> `, `1. ` — becomes the block's type,
 * and the marker itself is dropped. Returns the type and the text after the
 * marker, or null when the text does not begin with one. A marker always
 * needs its trailing space, so `#foo` (a tag) or a bare `-` never switches.
 */
export function leadingMarker(text: string): { type: BlockType; text: string } | null {
  const heading = HEADING_RE.exec(text)
  if (heading) return { type: "h1", text: text.slice(heading[0].length) }
  const todo = TODO_RE.exec(text)
  if (todo) {
    return {
      type: todo[1].toLowerCase() === "x" ? "done" : "todo",
      text: text.slice(todo[0].length),
    }
  }
  const quote = QUOTE_RE.exec(text)
  if (quote) return { type: "quote", text: text.slice(quote[0].length) }
  const bullet = BULLET_RE.exec(text)
  if (bullet) return { type: "ul", text: text.slice(bullet[0].length) }
  const ordered = ORDERED_RE.exec(text)
  if (ordered) return { type: "ol", text: text.slice(ordered[0].length) }
  return null
}

/** The type a marker string stands for (`"- "` → `ul`, `""` → `text`) — how a
 * marker-shaped preference (Settings → Editor, "New block markdown") reads. */
export function typeOfMarker(marker: string): BlockType {
  return leadingMarker(marker + "x")?.type ?? "text"
}

/** What Enter makes a new block unless the user has chosen otherwise: a fresh
 * unordered list item — and the marker that preference is spelled with. */
export const DEFAULT_NEW_BLOCK_TYPE: BlockType = "ul"
export const DEFAULT_NEW_BLOCK_MARKER = MARKER_OF_TYPE[DEFAULT_NEW_BLOCK_TYPE]

/**
 * Select-mode "turn into" keys: the marker character → the type it toggles.
 * In select mode marker keys are *structural*, never typed text — the keymap
 * binds them to the `turnInto*` commands, and the multi-select handler applies
 * the same toggle across a selection.
 */
export const TURN_INTO_KEYS: Readonly<Record<string, BlockType>> = {
  "#": "h1",
  "-": "ul",
  "[": "todo",
  ">": "quote",
  "1": "ol",
}

export const isHeading = (type: BlockType): boolean =>
  type === "h1" || type === "h2" || type === "h3"

export const isTodo = (type: BlockType): boolean => type === "todo" || type === "done"

/** A list item: bullet, numbered, or a checkbox (Enter continues the list). */
export const isListItem = (type: BlockType): boolean =>
  type === "ul" || type === "ol" || isTodo(type)

/**
 * Toggle a block to `target`: already that type → back to plain text;
 * anything else → the target. A checked todo counts as "already a todo" (the
 * checkbox toggles the check), and every heading level counts as a heading.
 */
export function toggleType(current: BlockType, target: BlockType): BlockType {
  const same =
    current === target ||
    (isTodo(current) && isTodo(target)) ||
    (isHeading(current) && isHeading(target))
  return same ? "text" : target
}
