/**
 * The property on a note's page that makes it a board (docs/boards.md):
 * `{ board: true }` among the page's metadata, beside its font and width.
 * A board is a note in every other way; the property is what gives it its
 * icon, its page and its place in the lists. Here on its own so the note
 * metadata (`src/data/note-meta.ts`) can read it without importing the
 * board module.
 */
export const BOARD_PROP = "board"

/**
 * The property on a block that makes it one of a board's features
 * (docs/boards.md, "Features"): `{ feature: { type, multi, meaning } }` in
 * the props of a direct child of the board's page, whose text is the
 * feature's label and whose children are its values. Read and written in
 * `src/data/boards.ts`; named here beside `BOARD_PROP`, the other property
 * a board is made of.
 */
export const FEATURE_PROP = "feature"
