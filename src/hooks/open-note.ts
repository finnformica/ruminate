import { useNavigate } from "@tanstack/react-router"
import { useStore } from "jotai"
import React from "react"
import { notesAtom } from "../global-state"
import type { NoteId } from "../schema"

/**
 * Where a note opens: a board (docs/boards.md) on its board page, every
 * other note on its outline — focused on a block when one is given. The one
 * place that decides, so the sidebar, the Views page and the palette agree.
 */
export function useOpenNote() {
  const navigate = useNavigate()
  const store = useStore()
  return React.useCallback(
    (noteId: NoteId, block?: string) => {
      if (store.get(notesAtom).get(noteId)?.type === "board") {
        return navigate({ to: "/boards/$", params: { _splat: noteId } })
      }
      return navigate({
        to: "/views/$",
        params: { _splat: noteId },
        search: { query: undefined, block },
      })
    },
    [navigate, store],
  )
}
