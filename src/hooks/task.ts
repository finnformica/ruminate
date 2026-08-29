import React from "react"
import { useGetNoteContents, useWriteNotes } from "../data/store"
import { updateFrontmatterValue } from "../utils/frontmatter"

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

      const noteContents = getNoteContents()
      const targetBaseContent = noteContents[targetNoteId] ?? ""
      const newTargetContent = appendTaskToNote(targetBaseContent, taskLine)

      writeNotes({
        [sourceNoteId]: addUpdatedTimestamp(newSourceContent),
        [targetNoteId]: addUpdatedTimestamp(newTargetContent),
      })
    },
    [getNoteContents, writeNotes],
  )
}
