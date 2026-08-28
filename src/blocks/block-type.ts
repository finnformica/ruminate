/**
 * A block's *type* is derived from its markdown content at render time (never
 * stored). This is what lets `# `, `- `, `[ ] ` behave like Notion shortcuts:
 * the content is the source of truth, and the editor styles/marks each block
 * from the leading token.
 */
export type BlockType =
  | { kind: "heading"; level: number }
  | { kind: "todo"; checked: boolean }
  | { kind: "quote" }
  | { kind: "bullet" }
  | { kind: "ordered"; number: number }
  | { kind: "paragraph" }

const HEADING_RE = /^(#{1,6})\s+/
// Accepts `[ ]`, `[x]`, `[X]`, and the shorthand `[]`.
const TODO_RE = /^\[([ xX]?)\]\s+/
const QUOTE_RE = /^>\s+/
const BULLET_RE = /^[-*]\s+/
// An ordered-list item: `1. `, `2) `, etc.
const ORDERED_RE = /^(\d+)[.)]\s+/

export function getBlockType(content: string): BlockType {
  const heading = HEADING_RE.exec(content)
  if (heading) return { kind: "heading", level: heading[1].length }

  const todo = TODO_RE.exec(content)
  if (todo) return { kind: "todo", checked: todo[1].toLowerCase() === "x" }

  if (QUOTE_RE.test(content)) return { kind: "quote" }
  if (BULLET_RE.test(content)) return { kind: "bullet" }

  const ordered = ORDERED_RE.exec(content)
  if (ordered) return { kind: "ordered", number: Number(ordered[1]) }

  return { kind: "paragraph" }
}

/** The block's text with its leading marker (`# `, `- `, `[ ] `, `> `, `1. `) removed. */
export function stripMarker(content: string): string {
  const type = getBlockType(content)
  switch (type.kind) {
    case "heading":
      return content.replace(HEADING_RE, "")
    case "todo":
      return content.replace(TODO_RE, "")
    case "quote":
      return content.replace(QUOTE_RE, "")
    case "bullet":
      return content.replace(BULLET_RE, "")
    case "ordered":
      return content.replace(ORDERED_RE, "")
    default:
      return content
  }
}

/**
 * The leading markdown marker (`# `, `- `, `[ ] `, `> `, `1. `) if `content`
 * begins with one, otherwise `null`. Used to detect when a marker typed at the
 * start of a block should switch the block to that type — the marker always
 * requires a trailing space, so `#foo` or a bare `-` never triggers a switch.
 */
export function leadingMarker(content: string): string | null {
  const type = getBlockType(content)
  if (type.kind === "paragraph") return null
  return content.slice(0, content.length - stripMarker(content).length)
}

/** Toggle a todo block's checkbox, returning the new content. */
export function toggleTodo(content: string): string {
  const type = getBlockType(content)
  if (type.kind !== "todo") return content
  return type.checked ? content.replace(/^\[[xX]\]/, "[ ]") : content.replace(/^\[[ ]?\]/, "[x]")
}

/** A block kind that carries a leading marker (everything but a paragraph). */
export type MarkerKind = Exclude<BlockType["kind"], "paragraph">

/** The canonical marker each kind starts with. Ordered items always get `1. `
 * — the renderer/serializer renumbers the list. */
const MARKER_OF: Record<MarkerKind, string> = {
  heading: "# ",
  todo: "[ ] ",
  quote: "> ",
  bullet: "- ",
  ordered: "1. ",
}

/**
 * Select-mode "turn into" keys: the marker character → the kind it toggles.
 * In select mode marker keys are *structural*, never typed text — the keymap
 * binds them to the `turnInto*` commands, and the multi-select handler applies
 * the same toggle across a selection.
 */
export const MARKER_KEYS: Record<string, MarkerKind> = {
  "#": "heading",
  "-": "bullet",
  "[": "todo",
  ">": "quote",
  "1": "ordered",
}

/**
 * Toggle `content` to the given kind: already that kind → strip back to a
 * paragraph; anything else → swap the leading marker. The body text is never
 * touched. (A checked todo counts as "already a todo" — `x` toggles the check.)
 */
export function toggleMarker(content: string, kind: MarkerKind): string {
  const body = stripMarker(content)
  return getBlockType(content).kind === kind ? body : MARKER_OF[kind] + body
}
