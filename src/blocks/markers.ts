import { normalizeBlockText } from "./normalize-block-text"
import { BLOCK_TYPE_DEFS, defOf } from "./registry"
import type { BlockProps, BlockType } from "./types"

/**
 * The marker helpers, every one derived from the registry (`registry.ts`):
 * a block's type is data (`Block.type`), and the markdown marker that
 * represents it — `# `, `- `, `[ ] `, `> `, `1. ` — is spelled once, in its
 * registry entry. The parser (import) and the serializer (export) read the
 * marker through here; the editor's typing shortcut (`leadingMarker`) reads
 * each entry's `typed` pattern, which is how the app keeps the feel of
 * markdown without storing any.
 */

/** The marker a block of `type` carries on export; an ordered item takes its
 * 1-based position in its run of consecutive ordered siblings. */
export function markerFor(type: BlockType, olPosition = 1): string {
  const marker = defOf(type).marker
  return typeof marker === "function" ? marker(olPosition) : marker
}

/** Headings carry a single `#` on export regardless of how many were typed —
 * their size comes from outline depth — so `## Foo` reads as `# Foo`. */
function normalizeHeadingMarker(line: string): string {
  return line.replace(/^#{2,6}(\s)/, "#$1")
}

/**
 * Classify one line of canonical markdown into `{ type, text }` — the import
 * half. Each registry entry is tried in order: its own reader (`fromLine`)
 * where it has one, else its marker as a prefix. `olPosition` is the 1-based
 * position the line would take in the current run of ordered siblings (an
 * ordered marker is only typed `ol` when its number matches; any other
 * number survives as a near-miss the normalization pass then folds into the
 * run — see `normalize-block-text.ts`). Inside a code fence nothing is a
 * marker.
 */
export function classifyLine(
  line: string,
  olPosition: number,
  inFence: boolean,
): { type: BlockType; text: string; props?: BlockProps } {
  if (inFence) return { type: "text", text: line }
  const canonical = normalizeHeadingMarker(line)
  for (const def of BLOCK_TYPE_DEFS) {
    if (def.fromLine) {
      const read = def.fromLine(canonical, olPosition)
      if (read)
        return { type: def.id, text: read.text, ...(read.props ? { props: read.props } : {}) }
      continue
    }
    if (typeof def.marker === "string" && def.marker !== "" && canonical.startsWith(def.marker)) {
      return { type: def.id, text: canonical.slice(def.marker.length) }
    }
  }
  const normalized = normalizeBlockText(canonical)
  if (normalized) return normalized
  return { type: "text", text: canonical }
}

/**
 * The editor's typing shortcut: a marker typed at the very start of a
 * block's text — `# `, `- `, `[ ] `, `> `, `1. ` — becomes the block's type,
 * and the marker itself is dropped. Returns the type and the text after the
 * marker, or null when the text does not begin with one. A marker always
 * needs its trailing space, so `#foo` (a tag) or a bare `-` never switches.
 */
export function leadingMarker(text: string): { type: BlockType; text: string } | null {
  for (const def of BLOCK_TYPE_DEFS) {
    if (!def.typed) continue
    const match = def.typed.re.exec(text)
    if (!match) continue
    return {
      type: def.typed.type ? def.typed.type(match) : def.id,
      text: text.slice(match[0].length),
    }
  }
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
export const DEFAULT_NEW_BLOCK_MARKER = markerFor(DEFAULT_NEW_BLOCK_TYPE)

/**
 * Select-mode "turn into" keys: the marker character → the type it toggles.
 * In select mode marker keys are *structural*, never typed text — the keymap
 * binds them to the `turnInto*` commands, and the multi-select handler applies
 * the same toggle across a selection.
 */
export const TURN_INTO_KEYS: Readonly<Record<string, BlockType>> = Object.fromEntries(
  BLOCK_TYPE_DEFS.filter((def) => def.turnIntoKey).map((def) => [def.turnIntoKey!, def.id]),
)

export const isHeading = (type: BlockType): boolean => defOf(type).family === "heading"

export const isTodo = (type: BlockType): boolean => defOf(type).family === "todo"

/** A list item: bullet, numbered, or a checkbox (Enter continues the list). */
export const isListItem = (type: BlockType): boolean => defOf(type).listItem

/**
 * Toggle a block to `target`: already that type (or its family: a checked
 * todo is "already a todo", every heading level is a heading) → back to
 * plain text; anything else → the target.
 */
export function toggleType(current: BlockType, target: BlockType): BlockType {
  return defOf(current).family === defOf(target).family ? "text" : target
}
