import type { Note, NoteId } from "../schema"
import type { BlockHit } from "./block-search"

/** A note whose title matched the query's text, with how well (fast-fuzzy's
 * 0–1 — the scale a block hit's `score` is on). */
export interface ScoredNote {
  note: Note
  score: number
}

/** One row of a results list: a note (its title matched) or a block (its
 * text did, or its type was asked for), with the score it ranked on. */
export interface ResultRow {
  id: string
  noteId: NoteId
  kind: "note" | "block"
  score?: number
}

/**
 * The rows of a results list, in the order they are drawn: title-matched
 * notes and block hits ranked together, purely by score — a note whose title
 * matched well sits among the blocks that matched as well, never in a bucket
 * of its own. Both scores are fast-fuzzy's at the one threshold, so they
 * compare directly; a hit a bare filter listed (no text to score) counts as
 * 0. Ties keep the order given, notes before blocks. With an explicit
 * `sort:` the query's order is the order (`sorted`): the notes as sorted,
 * then the hits as sorted.
 */
export function rankResultRows(
  titleMatches: readonly ScoredNote[],
  hits: readonly BlockHit[],
  sorted = false,
): ResultRow[] {
  const notes: ResultRow[] = titleMatches.map(({ note, score }) => ({
    id: note.id,
    noteId: note.id,
    kind: "note",
    score,
  }))
  const blocks: ResultRow[] = hits.map((hit) => ({
    id: hit.blockId,
    noteId: hit.noteId,
    kind: "block",
    score: hit.score,
  }))
  const rows = [...notes, ...blocks]
  if (sorted) return rows
  // A stable sort: equal scores stay in the order given.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (b.row.score ?? 0) - (a.row.score ?? 0) || a.index - b.index)
    .map(({ row }) => row)
}
