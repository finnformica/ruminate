import { atom, useSetAtom } from "jotai"
import { useCallback } from "react"
import type { NoteId } from "../schema"
import type { ResultRow } from "../utils/rank-results"

/**
 * **The ⌘K palette as a picker.** The palette is one search over the
 * corpus — the query box over the result rows — and any part of the app can
 * borrow it to ask the reader for a note, a block or a value: the note
 * header's Filter asks for a parent row, a link could ask for a note to
 * link to, a move could ask where to. The asker opens it with a request
 * (`usePalettePicker`), and the palette hands the pick back through it
 * rather than navigating.
 *
 * What the palette does with a request (`command-menu.tsx`): it opens with
 * the request's query set — as ⌘P presets `type:heading in:<note>` — and
 * its placeholder; the rows a request keeps are listed (`keep`), the rest
 * left out; the typed text is offered as the first row when the request
 * words it (`textRow`), and ↵ on the query picks it; a row picked (↵, a
 * click) is handed back as the block or the note it is; Esc, a click
 * outside or ⌘K cancels. Nothing of the palette's own — the date row, the
 * create-a-note footer, ⌘↵, ⌘P — is offered while it is a picker.
 */

/** What a picker hands back. */
export type PaletteChoice =
  | { kind: "block"; noteId: NoteId; blockId: string }
  | { kind: "note"; noteId: NoteId }
  | { kind: "text"; text: string }

export interface PaletteRequest {
  /** The query the palette opens with (`in:<note>`), its qualifiers as
   * pills. The reader can still change it. */
  query?: string
  placeholder?: string
  /** The dialog's accessible name. */
  label?: string
  /** List blocks even for a query that would list notes (a bare `in:`),
   * so a picker of rows shows rows from the first keystroke. */
  blocks?: boolean
  /** Only the rows this keeps are listed — a picker of parents, of notes.
   * Applies to search results; the palette's Recent and Views lists, shown
   * with nothing typed, are browsed as they are. */
  keep?: (row: ResultRow) => boolean
  /** Offer the typed text itself as the first row, worded by this
   * ("Contains “alice”"): a picker that takes a value as well as a row. */
  textRow?: (text: string) => string
  /** The pick. The palette has closed by the time it is called. */
  onPick: (choice: PaletteChoice) => void
  /** Told when the palette closes without a pick. */
  onCancel?: () => void
}

/** Whether the palette is open — ⌘K's toggle, and the nav bar's button. */
export const isCommandMenuOpenAtom = atom(false)

/** The request the palette is open for, when it is a picker. */
export const paletteRequestAtom = atom<PaletteRequest | null>(null)

/** Open the palette as a picker. */
export function usePalettePicker() {
  const setRequest = useSetAtom(paletteRequestAtom)
  return useCallback((request: PaletteRequest) => setRequest(request), [setRequest])
}
