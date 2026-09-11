import type { Heading, Note, NoteId, Task } from "../schema"
import { isHeading } from "../blocks/markers"
import type { Block, BlockDoc } from "../blocks/types"
import {
  formatDate,
  formatWeek,
  isValidDateString,
  isValidWeekString,
  toDateStringUtc,
} from "../utils/date"
import { PAGE_TYPE, pageDoc, parseProps, propsJson, type GraphSnapshot } from "./graph"
import type { Op } from "./ops"
import { emittedPageTitle, isMintedNoteId } from "./page-identity"

/**
 * Note metadata from the graph: everything
 * the notes list, the sidebar, search and the calendar know about a page is
 * read off the page node's `text` and `props` and the blocks it reaches. No
 * markdown is parsed on the way — a `#tag` is found in a block's text, a
 * task is a `todo`/`done` block, the preview of an untitled note is its first
 * words.
 */

/**
 * A `#tag` in block text, as the syntax defines it (docs/markdown-syntax.md):
 * `#` at the start or after whitespace, then a letter, then letters, digits,
 * `_`, `-` or `/`.
 */
const TAG_RE = /(?:^|(?<=\s))#(\p{L}[\p{L}\p{N}_\-/]*)/gu
const TAGS_SCHEMA_RE = /^[\p{L}][\p{L}\p{N}_\-/]*$/u

/** A tag and every parent of it: `a/b/c` → `a`, `a/b`, `a/b/c`. */
function expandTag(tag: string, into: Set<string>) {
  const parts = tag.split("/")
  for (let i = 1; i <= parts.length; i += 1) into.add(parts.slice(0, i).join("/"))
}

/** Every tag in a text, parents included, in order of first appearance. */
export function tagsInText(text: string): string[] {
  const tags = new Set<string>()
  for (const match of text.matchAll(TAG_RE)) expandTag(match[1], tags)
  return [...tags]
}

/**
 * The page's props as JSON-safe entries — the shape the `props` column holds
 * and `setProps` writes (dates as ISO strings). A row still in the retired
 * raw-YAML shape (`{"frontmatter": "…"}`, written by app versions before
 * parsed entries) reads as no properties: the text is kept on the row, but
 * nothing parses YAML any more.
 */
export function pagePropsEntries(props: string | null): Record<string, unknown> {
  const parsed = parseProps(props)
  if (!parsed) return {}
  if (Object.keys(parsed).length === 1 && typeof parsed.frontmatter === "string") return {}
  return { ...parsed }
}

/**
 * The op that sets page props: the current entries with `patch` applied (a
 * `null` value removes the key) and `updated_at` stamped. Nothing when the
 * page is not in the graph.
 */
export function pagePropsOps(
  pageId: NoteId,
  patch: Record<string, unknown>,
  snapshot: GraphSnapshot,
): Op[] {
  const page = snapshot.nodes.get(pageId)
  if (!page || page.type !== PAGE_TYPE) return []
  const entries = pagePropsEntries(page.props)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete entries[key]
    else entries[key] = value instanceof Date ? value.toISOString() : value
  }
  entries.updated_at = new Date().toISOString()
  return [{ op: "setProps", id: pageId, props: propsJson(entries) }]
}

/** Blocks in document order with their depth (a block reached twice is
 * listed once, at its first depth). */
function blocksInOrder(doc: BlockDoc): { block: Block; depth: number }[] {
  const out: { block: Block; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) {
      const block = doc.blocks[id]
      if (!block || seen.has(id)) continue
      seen.add(id)
      out.push({ block, depth })
      walk(block.children, depth + 1)
    }
  }
  walk(doc.rootBlockIds, 0)
  return out
}

/** The date a props value names, if it is one: a YAML date (parsed to a
 * `Date`) or an ISO / `YYYY-MM-DD` string. */
function dateOf(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return toDateStringUtc(value)
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return toDateStringUtc(parsed)
  }
  return null
}

const PREVIEW_WORDS = 8

/**
 * The `Note` for a page node, or null when `id` is not a page. Pure over the
 * snapshot; `notesAtom` memoizes it per page.
 */
export function noteFromPage(id: NoteId, snapshot: GraphSnapshot): Note | null {
  const page = snapshot.nodes.get(id)
  if (!page || page.type !== PAGE_TYPE) return null
  const doc = pageDoc(id, snapshot) as BlockDoc
  const blocks = blocksInOrder(doc)
  const props = pagePropsEntries(page.props)

  // Title: the page node's text (the id when untitled), else the first
  // heading block — the old markdown convention, still honoured for imports.
  let title = emittedPageTitle(id, page.text) ?? ""
  if (!title) {
    const heading = blocks.find(({ block }) => isHeading(block.type))
    if (heading) title = heading.block.text.trim()
  }
  const tags = new Set<string>()
  const tagList = Array.isArray(props.tags)
    ? props.tags.filter((tag): tag is string => typeof tag === "string" && TAGS_SCHEMA_RE.test(tag))
    : []
  for (const tag of tagList) expandTag(tag, tags)

  const tasks: Task[] = []
  const headings: Heading[] = []
  const texts: string[] = []
  for (const { block, depth } of blocks) {
    texts.push(block.text)
    // Headings are one type, sized by depth — a heading's level IS its depth.
    if (isHeading(block.type)) headings.push({ level: depth + 1, text: block.text.trim() })
    for (const tag of tagsInText(block.text)) tags.add(tag)
    if (block.type === "todo" || block.type === "done") {
      tasks.push({
        blockId: block.id,
        completed: block.type === "done",
        text: block.text.trim(),
        tags: tagsInText(block.text),
      })
    }
  }

  const dates = new Set<string>()
  for (const [key, value] of Object.entries(props)) {
    if (key === "updated_at") continue
    const date = dateOf(value)
    if (date) dates.add(date)
  }
  const type = isValidDateString(id) ? "daily" : isValidWeekString(id) ? "weekly" : "note"
  if (type === "daily") dates.add(id)

  const text = texts.join("\n")
  let displayName = ""
  switch (type) {
    case "daily":
      displayName = title || formatDate(id)
      break
    case "weekly":
      displayName = title || formatWeek(id)
      break
    case "note":
      if (title) displayName = title
      // An id a human wrote is a name; a minted one is opaque and never is.
      else if (id && !/^\d+$/.test(id) && !isMintedNoteId(id)) displayName = id
      else {
        const words = text.trim().split(/\s+/).filter(Boolean)
        displayName = words.length > 0 ? words.slice(0, PREVIEW_WORDS).join(" ") : "Empty note"
        if (words.length > PREVIEW_WORDS) displayName += "…"
      }
      break
  }

  let updatedAt: number | null = null
  if (typeof props.updated_at === "string") {
    const parsed = Date.parse(props.updated_at)
    if (!Number.isNaN(parsed)) updatedAt = parsed
  }

  return {
    id,
    type,
    displayName,
    props,
    title,
    pinned: props.pinned === true,
    updatedAt,
    dates: [...dates],
    tags: [...tags],
    tasks,
    headings,
    text,
  }
}

/**
 * A cheap identity for everything a page's `Note` depends on: the page row
 * and every row it reaches. Row objects are replaced when they change
 * (`applyOps`, a pull), so identities are the fingerprint — no content is
 * compared.
 */
function pageFingerprint(id: NoteId, snapshot: GraphSnapshot): object[] {
  const rows: object[] = [snapshot.nodes.get(id) as object]
  const seen = new Set<string>([id])
  const stack = [id]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const link of snapshot.childLinks.get(current) ?? []) {
      rows.push(link)
      const node = snapshot.nodes.get(link.destination_id)
      if (node) rows.push(node)
      if (seen.has(link.destination_id)) continue
      seen.add(link.destination_id)
      stack.push(link.destination_id)
    }
  }
  return rows
}

const sameRows = (a: object[], b: object[]) =>
  a.length === b.length && a.every((row, i) => row === b[i])

/**
 * A memoizing builder for the notes map: call it with each snapshot and only
 * pages whose reachable rows changed are re-derived; the rest keep their
 * `Note` object (so downstream memos and React keys stay stable). Pages that
 * disappear are evicted.
 */
export function createNotesBuilder() {
  const cache = new Map<NoteId, { rows: object[]; note: Note }>()
  return function buildNotes(snapshot: GraphSnapshot): Map<NoteId, Note> {
    const notes = new Map<NoteId, Note>()
    for (const node of snapshot.nodes.values()) {
      if (node.type !== PAGE_TYPE) continue
      const rows = pageFingerprint(node.id, snapshot)
      const cached = cache.get(node.id)
      if (cached && sameRows(cached.rows, rows)) {
        notes.set(node.id, cached.note)
        continue
      }
      const note = noteFromPage(node.id, snapshot)
      if (!note) continue
      cache.set(node.id, { rows, note })
      notes.set(node.id, note)
    }
    for (const id of cache.keys()) if (!notes.has(id)) cache.delete(id)
    return notes
  }
}
