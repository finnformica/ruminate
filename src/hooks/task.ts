import React from "react"
import { useGetNoteContents, useWriteNotes } from "../data/store"
import { updateFrontmatterValue } from "../utils/frontmatter"
import { getNoteDraft, setNoteDraft } from "../utils/note-draft"

/**
 * Appends a task line to note content.
 * If the note ends with a list, adds to the end of the list.
 * Otherwise, adds a blank line separator then the task.
 */
function appendTaskToNote(content: string, taskLine: string): string {
  if (!content.trim()) {
    return taskLine
  }

  const trimmed = content.trimEnd()
  const lines = trimmed.split("\n")
  const lastLine = lines[lines.length - 1] || ""

  // Check if ends with list item: "- ", "* ", "+ ", "1. " etc
  const endsWithList = /^(\s*[-*+]|\s*\d+\.)\s/.test(lastLine)

  if (endsWithList) {
    return trimmed + "\n" + taskLine
  } else {
    return trimmed + "\n\n" + taskLine
  }
}

/**
 * Adds updated_at timestamp to content
 */
function addUpdatedTimestamp(content: string): string {
  return updateFrontmatterValue({
    content,
    properties: { updated_at: new Date() },
  })
}

export function useMoveTask() {
  const getNoteContents = useGetNoteContents()
  const writeNotes = useWriteNotes()

  return React.useCallback(
    (params: {
      sourceNoteId: string
      targetNoteId: string
      sourceMarkdown: string
      nodeStart: number
      nodeEnd: number
    }) => {
      const { sourceNoteId, targetNoteId, sourceMarkdown, nodeStart, nodeEnd } = params

      // Extract task from source markdown
      let start = nodeStart
      while (start > 0 && sourceMarkdown[start - 1] !== "\n") start--
      const taskLine = sourceMarkdown.slice(start, nodeEnd).trim()
      const endWithNewline = sourceMarkdown[nodeEnd] === "\n" ? nodeEnd + 1 : nodeEnd
      const newSourceContent = sourceMarkdown.slice(0, start) + sourceMarkdown.slice(endWithNewline)

      // Check for drafts
      const sourceDraft = getNoteDraft(sourceNoteId)
      const targetDraft = getNoteDraft(targetNoteId)
      const sourceHasDraft = sourceDraft !== null
      const targetHasDraft = targetDraft !== null

      // Build target content (use draft if exists, else saved note)
      const noteContents = getNoteContents()
      const targetBaseContent = targetDraft ?? noteContents[targetNoteId] ?? ""
      const newTargetContent = appendTaskToNote(targetBaseContent, taskLine)

      // Update drafts for dirty files (immediate write since we navigate after)
      if (sourceHasDraft) {
        setNoteDraft({ noteId: sourceNoteId, value: newSourceContent, immediate: true })
      }
      if (targetHasDraft) {
        setNoteDraft({ noteId: targetNoteId, value: newTargetContent, immediate: true })
      }

      // Save clean notes only
      const notesToSave: Record<string, string> = {}
      if (!sourceHasDraft) {
        notesToSave[sourceNoteId] = addUpdatedTimestamp(newSourceContent)
      }
      if (!targetHasDraft) {
        notesToSave[targetNoteId] = addUpdatedTimestamp(newTargetContent)
      }

      if (Object.keys(notesToSave).length > 0) {
        writeNotes(notesToSave)
      }
    },
    [getNoteContents, writeNotes],
  )
}
