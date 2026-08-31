import React from "react"
import { useGetNoteContents, useWriteNotes } from "../data/store"
import { updateTag } from "../utils/update-tag"

export function useRenameTag() {
  const getNoteContents = useGetNoteContents()
  const writeNotes = useWriteNotes()

  return React.useCallback(
    async (oldName: string, newName: string) => {
      const noteContents = getNoteContents()
      const updates: Record<string, string> = {}

      for (const [id, content] of Object.entries(noteContents)) {
        const newContent = updateTag({ fileContent: content, oldName, newName })
        if (newContent !== content) {
          updates[id] = newContent
        }
      }

      writeNotes(updates)
    },
    [getNoteContents, writeNotes],
  )
}

export function useDeleteTag() {
  const getNoteContents = useGetNoteContents()
  const writeNotes = useWriteNotes()

  return React.useCallback(
    async (tagName: string) => {
      const noteContents = getNoteContents()
      const updates: Record<string, string> = {}

      for (const [id, content] of Object.entries(noteContents)) {
        const newContent = updateTag({ fileContent: content, oldName: tagName, newName: null })
        if (newContent !== content) {
          updates[id] = newContent
        }
      }

      writeNotes(updates)
    },
    [getNoteContents, writeNotes],
  )
}
