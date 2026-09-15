import { linkLine, linkPropsOf } from "./link"
import { imageLine, imageUrlOfBlock, parseImageLine } from "./image"
import type { Block, BlockProps, BlockType } from "./types"

/**
 * **The block-type registry.** One entry per type, holding everything the
 * rest of the app needs to know about it: its markdown line (import and
 * export), how it behaves under Enter and Backspace, whether it can be
 * turned into, how search and the slash menu name it, and how it goes to
 * the clipboard. Every generic module — the parser, the serializer, the
 * commands, the keymap, the slash menu, search, the clipboard, the context
 * menu — reads this table instead of listing types itself, so adding a type
 * is adding an entry here (plus its row presentation in
 * `src/components/block-editor/block-kinds.tsx`).
 *
 * Entries are ordered as the slash menu and "Turn into" offer them; siblings
 * that are never offered (`done`, `h2`, `h3`, `note`) follow their family.
 */

/** A family groups types that toggle into each other and continue alike:
 * the heading levels are one family, an open and a checked to-do another. */
type BlockFamily =
  "text" | "bullet" | "ordered" | "todo" | "heading" | "quote" | "code" | "image" | "link" | "note"

interface SlashContext {
  /** Whether image uploads are switched on here. */
  images: boolean
}

export interface BlockTypeDef {
  readonly id: BlockType
  readonly family: BlockFamily
  /** The name people see (slash menu, Turn into). */
  readonly label: string
  /** Extra words the slash menu answers to (`/task` finds To-do). */
  readonly keywords: readonly string[]
  /** The markdown marker written before the text on export; a function for
   * a marker that depends on the block's position in its run (`1. `). */
  readonly marker: string | ((olPosition: number) => string)
  /** Import: read one canonical line as this type, or null. Absent, a
   * non-empty string `marker` is matched as a prefix. Tried in registry
   * order; the first match wins. */
  readonly fromLine?: (
    line: string,
    olPosition: number,
  ) => { text: string; props?: BlockProps } | null
  /** Export: the block's own lines. Absent: the marker and the first line
   * of text, then any continuation lines. */
  readonly toLines?: (block: Block, olPosition: number) => string[]
  /** The clipboard's plain (display markdown) lines. Absent: `toLines`. */
  readonly displayLines?: (block: Block, olPosition: number) => string[]
  /** The clipboard's HTML for a prose block, given the inline-rendered text.
   * Absent: a paragraph. List items are rendered by the list machinery. */
  readonly html?: (block: Pick<Block, "text" | "props">, inline: string) => string
  /** The typing shortcut: a marker typed at the very start of a block's
   * text switches its type. The regex must consume the marker; `type` may
   * pick a sibling (`[x] ` is `done`). */
  readonly typed?: { re: RegExp; type?: (match: RegExpExecArray) => BlockType }
  /** The select-mode key that toggles this type (`#` for a heading). */
  readonly turnIntoKey?: string
  /** A list item: Enter on an empty one leaves the list for the reader's
   * default new-block type (a paragraph when that is this list); display markdown
   * nests it under its parent; the clipboard groups runs into one list. */
  readonly listItem: boolean
  /** For list items: the HTML list element runs of them share. */
  readonly listTag?: "ul" | "ol"
  /** Backspace at the start of the text strips the type back to `text`. */
  readonly marked: boolean
  /** What Enter at the end creates next: a fixed type, or (absent) the
   * reader's default new-block type. */
  readonly continues?: BlockType
  /** What a same-type split (Shift+Enter) creates; absent: this type. */
  readonly splitsAs?: BlockType
  /** Offered by "Turn into" (menu, slash menu, select-mode keys). */
  readonly turnInto: boolean
  /** Offered by the slash menu even though it is not a plain type change
   * (an image asks for a file); gated on context. */
  readonly slash?: (context: SlashContext) => boolean
  /** How search names this type: the `type:` value people type and its
   * aliases. Null for a type that is never a search result (`note`). */
  readonly search: {
    readonly value: string
    readonly aliases?: readonly string[]
  } | null
}

const codeLanguage = (block: Pick<Block, "props">): string => {
  const language = block.props?.language
  return typeof language === "string" ? language : ""
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const heading = (id: BlockType, level: 1 | 2 | 3): BlockTypeDef => ({
  id,
  family: "heading",
  label: "Heading",
  keywords: ["header", "h1", "heading"],
  marker: "#".repeat(level) + " ",
  html: (_block, inline) => `<h${level}>${inline}</h${level}>`,
  // Only the first level is typed by hand and offered; the others are read
  // from stored data (size comes from outline depth, never from the marker).
  ...(level === 1 ? { typed: { re: /^#{1,6}\s+/ }, turnIntoKey: "#" } : {}),
  listItem: false,
  marked: true,
  turnInto: level === 1,
  search: { value: id },
})

// The `[ ]` marker: `[ ]`, `[x]`, `[X]`, and the shorthand `[]`.
const TODO_TYPED_RE = /^\[([ xX]?)\]\s+/
const todoTyped = {
  re: TODO_TYPED_RE,
  type: (match: RegExpExecArray): BlockType => (match[1].toLowerCase() === "x" ? "done" : "todo"),
}
// The clipboard's html flavor writes the box as the literal `[ ]` / `[x]`
// text, not an `<input type="checkbox">`: the composers that take the html
// flavor over the plain one (Slack, Claude, Google Docs, mail) drop a form
// control on paste, which left the item as its text behind a stray space.
// The text survives everywhere, and reads back as a GFM task item (a list
// item beginning `[ ]`) wherever markdown is understood, Ruminate included.
const todoHtml = (checked: boolean) => (_block: unknown, inline: string) =>
  `[${checked ? "x" : " "}] ${inline}`

const ORDERED_RE = /^(0|[1-9]\d*)\. /

export const BLOCK_TYPE_DEFS: readonly BlockTypeDef[] = [
  {
    id: "text",
    family: "text",
    label: "Text",
    keywords: ["paragraph", "plain"],
    marker: "",
    listItem: false,
    marked: false,
    turnInto: true,
    search: { value: "text" },
  },
  {
    id: "ul",
    family: "bullet",
    label: "Bullet list",
    keywords: ["unordered", "ul", "bullet"],
    marker: "- ",
    typed: { re: /^[-*]\s+/ },
    turnIntoKey: "-",
    listItem: true,
    listTag: "ul",
    marked: true,
    continues: "ul",
    turnInto: true,
    search: { value: "bullet", aliases: ["ul"] },
  },
  {
    id: "ol",
    family: "ordered",
    label: "Numbered list",
    keywords: ["ordered", "ol", "numbered"],
    marker: (olPosition) => `${olPosition}. `,
    // An ordered marker is only this type when its number is the position
    // it would take in the run: the serializer renumbers by position, and
    // any other number is a near-miss the normalisation pass folds in.
    fromLine: (line, olPosition) => {
      const match = ORDERED_RE.exec(line)
      return match && match[1] === String(olPosition) ? { text: line.slice(match[0].length) } : null
    },
    typed: { re: /^\d+[.)]\s+/ },
    turnIntoKey: "1",
    listItem: true,
    listTag: "ol",
    marked: true,
    continues: "ol",
    turnInto: true,
    search: { value: "ordered", aliases: ["ol"] },
  },
  {
    id: "todo",
    family: "todo",
    label: "To-do",
    keywords: ["todo", "task", "checkbox"],
    marker: "[ ] ",
    typed: todoTyped,
    turnIntoKey: "[",
    listItem: true,
    listTag: "ul",
    // Stored as a bare `[ ] text`; GFM needs the list bullet in front.
    displayLines: (block) => [`- [ ] ${block.text}`],
    html: todoHtml(false),
    marked: true,
    continues: "todo",
    turnInto: true,
    search: { value: "todo" },
  },
  {
    id: "done",
    family: "todo",
    label: "To-do",
    keywords: [],
    marker: "[x] ",
    listItem: true,
    listTag: "ul",
    displayLines: (block) => [`- [x] ${block.text}`],
    html: todoHtml(true),
    marked: true,
    continues: "todo",
    splitsAs: "todo",
    turnInto: false,
    search: { value: "done" },
  },
  heading("h1", 1),
  heading("h2", 2),
  heading("h3", 3),
  {
    id: "quote",
    family: "quote",
    label: "Quote",
    keywords: ["blockquote", "callout"],
    marker: "> ",
    typed: { re: /^>\s+/ },
    turnIntoKey: ">",
    html: (_block, inline) => `<blockquote><p>${inline}</p></blockquote>`,
    listItem: false,
    marked: true,
    turnInto: true,
    search: { value: "quote" },
  },
  {
    id: "code",
    family: "code",
    label: "Code",
    keywords: ["code", "snippet", "pre", "fence", "monospace"],
    marker: "",
    // The typing shortcut is a backtick and a space — the code span's own
    // fence, one character of it — and the same key turns into code in
    // select mode. Export is still the three-backtick fence (`toLines`).
    typed: { re: /^`[ \t]+/ },
    turnIntoKey: "`",
    // A fence spans lines, so import is the parser's (`parse.ts` reads the
    // fence as one block); export writes it back.
    toLines: (block) => [`\`\`\`${codeLanguage(block)}`, ...block.text.split("\n"), "```"],
    html: (block, _inline) => {
      const language = codeLanguage(block)
      const cls = language ? ` class="language-${escapeHtml(language)}"` : ""
      return `<pre><code${cls}>${escapeHtml(block.text)}</code></pre>`
    },
    listItem: false,
    marked: true,
    splitsAs: "text",
    turnInto: true,
    search: { value: "code" },
  },
  {
    id: "image",
    family: "image",
    label: "Image",
    keywords: ["picture", "photo", "upload", "img"],
    marker: "",
    fromLine: (line) => parseImageLine(line),
    toLines: (block) => [imageLine(block)],
    html: (block) => {
      // A figure: the picture, and beneath it a caption that says there is
      // one — `[image: caption]`, or `[image]` uncaptioned. The bytes are
      // never fetched at copy time; an app that can load the <img> shows it
      // (an external picture; an uploaded one is behind the session, so
      // only Ruminate can), and every other composer drops the <img> and
      // keeps the caption, so a pasted note still shows where its pictures
      // were and what they were of.
      //
      // Same-origin asset paths are made absolute so the picture resolves
      // wherever the html lands (another app; Ruminate reads the payload).
      //
      // Read off `globalThis` rather than `window`: the registry is now
      // imported by the Worker too (the MCP server parses and serializes
      // markdown, worker/mcp/tools.ts), and `worker/tsconfig.json` has no DOM
      // lib, so a bare `window` is a type error there. Identical in a browser;
      // an empty origin off it, where no clipboard is reading this anyway.
      const url = imageUrlOfBlock(block)
      const origin = (globalThis as { location?: { origin?: string } }).location?.origin ?? ""
      const src = url.startsWith("/") ? origin + url : url
      const caption = block.text.trim()
      const label = caption === "" ? "[image]" : `[image: ${caption}]`
      return (
        `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(block.text)}">` +
        `<figcaption>${escapeHtml(label)}</figcaption></figure>`
      )
    },
    listItem: false,
    // The picture is the marker: Backspace at the caption's start must not
    // quietly turn the block into a paragraph (delete the row instead).
    marked: false,
    splitsAs: "text",
    // Not a type change (it asks for a file), so not in "Turn into"; the
    // slash menu offers it where uploads are on.
    turnInto: false,
    slash: (context) => context.images,
    search: { value: "image" },
  },
  {
    id: "link",
    family: "link",
    label: "Link",
    keywords: ["bookmark", "url", "web"],
    // Graph-only: no `fromLine`, so a `[title](url)` line imports as the
    // inline link it reads as (`src/blocks/link.ts`); export writes the
    // block as that line.
    marker: "",
    toLines: (block) => [linkLine(block)],
    // A paragraph holding the link: the title as its text, the address as
    // its href, which every composer keeps and which reads back as the
    // inline link. The preview is not carried: it is the page's, fetched
    // again on demand.
    html: (block, inline) => `<p><a href="${escapeHtml(linkPropsOf(block).url)}">${inline}</a></p>`,
    listItem: false,
    // The card is the marker: Backspace at the title's start must not
    // quietly turn the block into a paragraph (delete the row instead).
    marked: false,
    splitsAs: "text",
    // Made from a link, never from a blank line: the hover card on a link
    // in the text turns it into one (`link-hover-card.tsx`), so neither
    // "Turn into" nor the slash menu offers it.
    turnInto: false,
    slash: () => false,
    search: { value: "link" },
  },
  {
    id: "note",
    family: "note",
    label: "Note",
    keywords: [],
    marker: "",
    listItem: false,
    marked: false,
    splitsAs: "text",
    turnInto: false,
    search: null,
  },
]

const DEFS_BY_ID = new Map(BLOCK_TYPE_DEFS.map((def) => [def.id, def]))

/** The registry entry for a type. */
export function defOf(type: BlockType): BlockTypeDef {
  return DEFS_BY_ID.get(type) ?? DEFS_BY_ID.get("text")!
}

/** The type of the same family that is offered and typed by hand: `todo`
 * for a checked to-do, `h1` for any heading. */
export function canonicalOf(type: BlockType): BlockType {
  const family = defOf(type).family
  return BLOCK_TYPE_DEFS.find((def) => def.family === family)?.id ?? type
}

/** The `type:` search vocabulary: value → the types it matches, with the
 * family groups (`task`, `heading`, `list`) alongside each type's own names. */
interface SearchGroup {
  readonly value: string
  readonly families: readonly BlockFamily[]
}
const SEARCH_GROUPS: readonly SearchGroup[] = [
  { value: "task", families: ["todo"] },
  { value: "heading", families: ["heading"] },
  { value: "list", families: ["bullet", "ordered"] },
]

/** The families in the order the search vocabulary lists them (the picker's
 * order, and the docs'): to-dos and headings first, as the most searched. */
const SEARCH_FAMILY_ORDER: readonly BlockFamily[] = [
  "todo",
  "heading",
  "bullet",
  "ordered",
  "quote",
  "code",
  "image",
  "link",
  "text",
]

/** Every `type:` value that names blocks, and the types each matches. */
export function searchTypeValues(): Record<string, readonly BlockType[]> {
  const values: Record<string, BlockType[]> = {}
  for (const def of BLOCK_TYPE_DEFS) {
    if (!def.search) continue
    for (const name of [def.search.value, ...(def.search.aliases ?? [])]) values[name] = [def.id]
  }
  for (const group of SEARCH_GROUPS) {
    values[group.value] = BLOCK_TYPE_DEFS.filter(
      (def) => def.search && group.families.includes(def.family),
    ).map((def) => def.id)
  }
  return values
}

/** The markdown glyph the qualifier picker draws beside a `type:` row: the
 * type's marker, or what stands for it where the marker is not a prefix
 * (a numbered item's number, a code fence, an image's `![]`, a link
 * block's `[]()`, a paragraph's pilcrow). */
function searchGlyph(def: BlockTypeDef): string {
  if (typeof def.marker === "function") return def.marker(1).trim()
  if (def.marker.trim() !== "") return def.marker.trim()
  switch (def.family) {
    case "code":
      return "```"
    case "image":
      return "![]"
    case "link":
      return "[]()"
    default:
      return "¶"
  }
}

/** The qualifier picker's `type:` rows for blocks, in vocabulary order,
 * each with its glyph and its name capitalised. Headings are offered as
 * the one `heading` (its levels, `h1`…`h3`, stay typed values only); the
 * to-dos as `todo`, `done` and then `task`; lists as `bullet` and
 * `ordered` (the `list` group stays a typed value only). */
export function searchTypeOptions(): { value: string; label: string; glyph: string }[] {
  const rows: { value: string; label: string; glyph: string }[] = []
  const row = (value: string, glyph: string) => ({
    value,
    label: value.charAt(0).toUpperCase() + value.slice(1),
    glyph,
  })
  for (const family of SEARCH_FAMILY_ORDER) {
    const members = BLOCK_TYPE_DEFS.filter((def) => def.family === family && def.search)
    const group = SEARCH_GROUPS.find((g) => g.families[0] === family)
    if (family === "heading" && group) {
      rows.push(row(group.value, searchGlyph(members[0])))
      continue
    }
    for (const def of members) rows.push(row(def.search!.value, searchGlyph(def)))
    if (family === "todo" && group) rows.push(row(group.value, searchGlyph(members[0])))
  }
  return rows
}
