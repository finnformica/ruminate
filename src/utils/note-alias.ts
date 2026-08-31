import { Note, NoteId } from "../schema"
import { parseFrontmatter, updateFrontmatterValue } from "./frontmatter"

/**
 * Record a note's former id in its `aliases` frontmatter. Called on rename so
 * the old note URL keeps working: the route resolver (`resolveNoteId`) sees
 * the dead id in `aliases` and redirects to the live note. Renames chain —
 * each rename appends the newly dead id, so every former id stays resolvable.
 */
export function recordRenameAlias({ content, oldId }: { content: string; oldId: NoteId }): string {
  const { frontmatter } = parseFrontmatter(content)
  const aliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases.map(String) : []
  if (aliases.includes(oldId)) return content
  return updateFrontmatterValue({
    content,
    properties: { aliases: [...aliases, oldId] },
  })
}

/**
 * Resolve a note URL's id to the note the route should show.
 *
 * - The id of a live note resolves to itself — a live note always wins, even
 *   over another note claiming the same id as an alias.
 * - A dead id claimed by a live note's `aliases` resolves to that note (the
 *   route redirects there).
 * - Otherwise `null`: the id is genuinely new and the route shows the
 *   new-note editor.
 */
export function resolveNoteId(notes: Map<NoteId, Note>, id: NoteId): NoteId | null {
  if (notes.has(id)) return id
  for (const note of notes.values()) {
    if (note.aliases.includes(id)) return note.id
  }
  return null
}
