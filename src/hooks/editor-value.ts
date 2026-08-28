import { useAtomValue } from "jotai"
import { useCallback, useMemo, useState } from "react"
import { githubRepoAtom } from "../global-state"
import { Note, NoteId } from "../schema"
import { parseFrontmatter } from "../utils/frontmatter"
import { clearNoteDraft, getNoteDraft, setNoteDraft } from "../utils/note-draft"

/** True when two note strings differ only in the `updated_at` frontmatter —
 * i.e. one is the other after a save stamped its timestamp (useSaveNote). */
function sameExceptTimestamp(a: string, b: string): boolean {
  const split = (markdown: string) => {
    const { frontmatter, content } = parseFrontmatter(markdown)
    const { updated_at: _ignored, ...rest } = frontmatter
    return { rest, body: content.trim() }
  }
  const pa = split(a)
  const pb = split(b)
  return pa.body === pb.body && JSON.stringify(pa.rest) === JSON.stringify(pb.rest)
}

/**
 * The note page's editor state: a local markdown string seeded from the note
 * (or a draft / template), kept in sync with external note changes.
 *
 * When the note's content changes underneath us (a git pull bringing another
 * device's edits, a save round-tripping through the state machine):
 * - with no unsaved local edits, the editor value is re-seeded to the new
 *   content, so pulled changes appear immediately (no page refresh);
 * - with unsaved local edits, the local value is preserved and `remoteNotice`
 *   turns on so the page can show a non-blocking "note updated remotely"
 *   notice. `loadRemoteVersion` discards the local edits in favor of the
 *   remote content (the user's explicit choice); `dismissRemoteNotice` hides
 *   the notice and keeps editing.
 *
 * Unsaved local edits are detected by comparing against the note content the
 * editor was last seeded from (plus the persisted draft), *not* only the
 * localStorage draft — draft writes are debounced, so a pull landing within
 * the debounce window must still never clobber in-progress typing.
 */
export function useEditorValue({
  noteId,
  note,
  defaultValue,
}: {
  noteId: NoteId
  note: Note | undefined
  defaultValue: string
}) {
  const githubRepo = useAtomValue(githubRepoAtom)

  const [editorValue, _setEditorValue] = useState(() => {
    return getNoteDraft({ githubRepo, noteId }) ?? note?.content ?? defaultValue
  })

  // Track previous note content to detect external changes
  const [prevNoteContent, setPrevNoteContent] = useState(note?.content)

  // The note changed remotely while the user had unsaved local edits.
  const [remoteNotice, setRemoteNotice] = useState(false)

  // Adjust state during render when note content changes externally (no effect needed)
  // See: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  if (note?.content !== prevNoteContent) {
    const hasLocalEdits =
      editorValue !== prevNoteContent || getNoteDraft({ githubRepo, noteId }) !== null
    setPrevNoteContent(note?.content)
    if (note?.content !== undefined) {
      if (!hasLocalEdits) {
        // No unsaved work — show the new (pulled) content immediately.
        _setEditorValue(note.content)
        setRemoteNotice(false)
      } else if (note.content === editorValue) {
        // The external change caught up with the local value (a save landing).
        setRemoteNotice(false)
      } else if (sameExceptTimestamp(note.content, editorValue)) {
        // The user's own save landing: useSaveNote stamps `updated_at` into
        // the frontmatter, so the saved note is byte-different from the editor
        // value by an invisible timestamp. Adopt it silently — raising the
        // remote notice here made every ⌘S cry "updated on another device".
        _setEditorValue(note.content)
        clearNoteDraft({ githubRepo, noteId })
        setRemoteNotice(false)
      } else {
        // Unsaved local edits — keep them, surface the notice.
        setRemoteNotice(true)
      }
    }
  }

  const isDraft = useMemo(() => {
    return editorValue !== (note ? note.content : defaultValue)
  }, [note, editorValue, defaultValue])

  const setEditorValue = useCallback(
    (value: string) => {
      _setEditorValue(value)

      if (note ? value !== note.content : value !== defaultValue) {
        setNoteDraft({ githubRepo, noteId, value })
      } else {
        clearNoteDraft({ githubRepo, noteId })
      }
    },
    [note, defaultValue, githubRepo, noteId],
  )

  const discardChanges = useCallback(() => {
    // Reset editor value to the last saved state of the note
    _setEditorValue(note?.content ?? defaultValue)
    clearNoteDraft({ githubRepo, noteId })
    setRemoteNotice(false)
  }, [note, defaultValue, githubRepo, noteId])

  /** Discard the unsaved local edits and load the remote version. */
  const loadRemoteVersion = discardChanges

  const dismissRemoteNotice = useCallback(() => setRemoteNotice(false), [])

  return {
    editorValue,
    setEditorValue,
    isDraft,
    discardChanges,
    remoteNotice,
    loadRemoteVersion,
    dismissRemoteNotice,
  }
}
