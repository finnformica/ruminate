import { useNavigate } from "@tanstack/react-router"
import { useCallback } from "react"
import { generateNoteId } from "../utils/note-id"

export function useCreateNewNote() {
  const navigate = useNavigate()

  return useCallback(() => {
    const noteId = generateNoteId()

    navigate({
      to: "/notes/$",
      params: { _splat: noteId },
      search: { query: undefined },
    })
  }, [navigate])
}
