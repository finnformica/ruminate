import { Note, NoteId } from "../schema"

/**
 * Resolve a note URL's id to the note the route should show.
 *
 * This is what keeps every pre-minting bookmark alive. Notes used to be keyed
 * by their titles, so `/notes/Flow Engineering` was a real URL; the page
 * identity migration recorded each page's former id in its `aliases` (see
 * `pagePropsWithAlias`, src/data/page-identity.ts), and this resolver turns
 * such a URL into the minted id the route redirects to. No bookmark 404s, and
 * none of them mints a duplicate note.
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
