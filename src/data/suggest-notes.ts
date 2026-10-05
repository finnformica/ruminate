import type { NotesFeature, NotesSuggestion } from "./auto-notes"
import { sessionFetch } from "./session-fetch"
import { readSuggestResponse, SuggestError } from "./suggest-tags"

/**
 * The request for a board's feature notes (docs/boards.md, "Features"):
 * `POST /api/boards/notes` as JSON — the board's name and its features,
 * all text already on the board (`NotesRequest`, src/data/auto-notes.ts).
 * The route's refusals (worker/handlers/board-notes.ts) come back as the
 * one `SuggestError` the tag request raises, with the words a toast shows
 * and the detail a person can copy out of it.
 */
export async function requestNotesSuggestion(
  board: string,
  features: NotesFeature[],
): Promise<NotesSuggestion> {
  const response = await sessionFetch(
    "/api/boards/notes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board, features }),
    },
    () => new SuggestError("signed_out", "Sign in to suggest notes."),
  )
  return readSuggestResponse(
    response,
    (body) => (body.notes ? { notes: body.notes } : undefined),
    "notes",
  )
}
