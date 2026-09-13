import type { NoteId, NoteType } from "../schema"
import { isValidDateString, isValidWeekString } from "./date"

/**
 * Which kind of note an id names — read off the id alone, because that is
 * where it lives: a daily note's id IS its date (`2026-08-31`), a weekly
 * note's its week (`2026-W35`), and everything else is a minted `blk_` id.
 *
 * A leaf function, deliberately: both the metadata layer
 * (`src/data/note-meta.ts`, deriving a `Note`) and the row that draws a note
 * (`block-kinds.tsx`, hanging its favicon in the marker slot) need it, and
 * neither should have to reach into the other.
 */
export function noteTypeOf(id: NoteId): NoteType {
  if (isValidDateString(id)) return "daily"
  if (isValidWeekString(id)) return "weekly"
  return "note"
}
