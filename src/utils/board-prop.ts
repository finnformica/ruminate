/**
 * The property on a note's page that makes it a board (docs/boards.md):
 * `{ board: true }` among the page's metadata, beside its font and width.
 * A board is a note in every other way; the property is what gives it its
 * icon, its page and its place in the lists. Here on its own so the note
 * metadata (`src/data/note-meta.ts`) can read it without importing the
 * board module.
 */
export const BOARD_PROP = "board"
