import type { Note } from "../schema"
import { CORPUS_ROOT_ID } from "./graph"
import type { FocusFrame } from "./panes"

/**
 * **The Root frame** (docs/graph-walk.md, section 2, decision 5): the frame
 * at the base of every pane's stack, rooted at the corpus root. It lists
 * every live note, so a note with no View is still one step from anywhere,
 * and Back and Shift+F come down to it.
 *
 * It is implicit: the URL does not write it (`layoutToSearch`) and a View
 * does not save it (`view-stack.ts`). Every reader puts it back at the base.
 */

/** What the Root frame is called: its crumb, its header and its sidebar
 * entry. Finn's choice was "Base" or "Root"; this is the one place to change. */
export const ROOT_LABEL = "Root"

/** The Root frame as a pane holds it. */
export const rootFrame = (): FocusFrame => ({ noteId: CORPUS_ROOT_ID, root: null, selected: null })

/** Is this frame the Root frame? */
export const isRootFrame = (frame: { noteId: string }): boolean => frame.noteId === CORPUS_ROOT_ID

/**
 * The Root frame's rows: every note given, first the notes the corpus root
 * links, in its `sort_key` order (`placed`, `orderedNoteIds`), then all the
 * others by title. Views are bookmarks, not rows: a block View is not here,
 * and a note is here whether or not it is listed in Views.
 */
export function rootFrameNotes(notes: readonly Note[], placed: readonly string[]): Note[] {
  const byId = new Map(notes.map((note) => [note.id, note]))
  const lead: Note[] = []
  const seen = new Set<string>()
  for (const id of placed) {
    const note = byId.get(id)
    if (!note || seen.has(id)) continue
    seen.add(id)
    lead.push(note)
  }
  const rest = notes
    .filter((note) => !seen.has(note.id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
  return [...lead, ...rest]
}
