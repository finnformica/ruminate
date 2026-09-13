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
import { NOTE_TYPE, noteDoc, parseProps, propsJson, type GraphSnapshot } from "./graph"
import type { Op } from "./ops"
import { emittedNoteTitle, isMintedNoteId } from "./note-identity"

/**
 * Note metadata from the graph: everything
 * the notes list, the sidebar, search and the calendar know about a note is
 * read off the note node's `text` and `props` and the blocks it reaches. No
 * markdown is parsed on the way — a task is a `todo`/`done` block, the
 * preview of an untitled note is its first words.
 */

/**
 * The note's props as JSON-safe entries — the shape the `props` column holds
 * and `setProps` writes (dates as ISO strings). A row still in the retired
 * raw-YAML shape (`{"frontmatter": "…"}`, written by app versions before
 * parsed entries) reads as no properties: the text is kept on the row, but
 * nothing parses YAML any more.
 */
export function notePropsEntries(props: string | null): Record<string, unknown> {
  const parsed = parseProps(props)
  if (!parsed) return {}
  if (Object.keys(parsed).length === 1 && typeof parsed.frontmatter === "string") return {}
  return { ...parsed }
}

/**
 * The op that sets note props: the current entries with `patch` applied (a
 * `null` value removes the key) and `updated_at` stamped. Nothing when the
 * note is not in the graph.
 */
export function notePropsOps(
  noteId: NoteId,
  patch: Record<string, unknown>,
  snapshot: GraphSnapshot,
): Op[] {
  const note = snapshot.nodes.get(noteId)
  if (!note || note.type !== NOTE_TYPE) return []
  const entries = notePropsEntries(note.props)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete entries[key]
    else entries[key] = value instanceof Date ? value.toISOString() : value
  }
  entries.updated_at = new Date().toISOString()
  return [{ op: "setProps", id: noteId, props: propsJson(entries) }]
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
 * The `Note` for a note node, or null when `id` is not one. Pure over the
 * snapshot; `notesAtom` memoizes it per note.
 */
export function noteFromNode(id: NoteId, snapshot: GraphSnapshot): Note | null {
  const note = snapshot.nodes.get(id)
  if (!note || note.type !== NOTE_TYPE) return null
  const doc = noteDoc(id, snapshot) as BlockDoc
  const blocks = blocksInOrder(doc)
  const props = notePropsEntries(note.props)

  // Title: the note node's text (the id when untitled), else the first
  // heading block — the old markdown convention, still honoured for imports.
  let title = emittedNoteTitle(id, note.text) ?? ""
  if (!title) {
    const heading = blocks.find(({ block }) => isHeading(block.type))
    if (heading) title = heading.block.text.trim()
  }
  const tasks: Task[] = []
  const headings: Heading[] = []
  const texts: string[] = []
  for (const { block, depth } of blocks) {
    texts.push(block.text)
    // Headings are one type, sized by depth — a heading's level IS its depth.
    if (isHeading(block.type)) headings.push({ level: depth + 1, text: block.text.trim() })
    if (block.type === "todo" || block.type === "done") {
      tasks.push({
        blockId: block.id,
        completed: block.type === "done",
        text: block.text.trim(),
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
    tasks,
    headings,
    text,
  }
}

/**
 * A cheap identity for everything a note's `Note` depends on: the note row
 * and every row it reaches. Row objects are replaced when they change
 * (`applyOps`, a pull), so identities are the fingerprint — no content is
 * compared.
 */
function noteFingerprint(id: NoteId, snapshot: GraphSnapshot): object[] {
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
 * notes whose reachable rows changed are re-derived; the rest keep their
 * `Note` object (so downstream memos and React keys stay stable). Notes that
 * disappear are evicted.
 */
export function createNotesBuilder() {
  const cache = new Map<NoteId, { rows: object[]; note: Note }>()
  return function buildNotes(snapshot: GraphSnapshot): Map<NoteId, Note> {
    const notes = new Map<NoteId, Note>()
    for (const node of snapshot.nodes.values()) {
      if (node.type !== NOTE_TYPE) continue
      const rows = noteFingerprint(node.id, snapshot)
      const cached = cache.get(node.id)
      if (cached && sameRows(cached.rows, rows)) {
        notes.set(node.id, cached.note)
        continue
      }
      const note = noteFromNode(node.id, snapshot)
      if (!note) continue
      cache.set(node.id, { rows, note })
      notes.set(node.id, note)
    }
    for (const id of cache.keys()) if (!notes.has(id)) cache.delete(id)
    return notes
  }
}
