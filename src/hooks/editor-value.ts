import { useAtomValue } from "jotai"
import { useCallback, useMemo, useState } from "react"
import { githubRepoAtom } from "../global-state"
import { GitHubRepository, Note, NoteId } from "../schema"
import { parseFrontmatter } from "../utils/frontmatter"
import {
  clearNoteDraft,
  getNoteDraftEntry,
  hashNoteContent,
  setNoteDraft,
} from "../utils/note-draft"

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

type EditorSeed = {
  value: string
  /** Provenance of `value`: `hashNoteContent` of the note content it is based on (null = unknown). */
  baseHash: string | null
  remoteNotice: boolean
}

/**
 * Seed the editor at mount, using each draft's recorded provenance to catch
 * the stale-device incident: device B reopens a note whose localStorage draft
 * was based on an older version, the repo has since pulled a newer one, and
 * without provenance the stale draft would silently mask (and, on save,
 * overwrite) the newer note.
 *
 * May clear a provenly no-op draft as a side effect — idempotent, so safe in a
 * lazy state initializer (which StrictMode may run twice).
 */
function seedEditorState({
  githubRepo,
  noteId,
  note,
  defaultValue,
}: {
  githubRepo: GitHubRepository | null
  noteId: NoteId
  note: Note | undefined
  defaultValue: string
}): EditorSeed {
  const entry = getNoteDraftEntry({ githubRepo, noteId })
  const noteContent = note?.content

  if (entry === null) {
    return {
      value: noteContent ?? defaultValue,
      baseHash: noteContent !== undefined ? hashNoteContent(noteContent) : null,
      remoteNotice: false,
    }
  }

  // No saved note yet (new note / template): the draft is all there is.
  if (noteContent === undefined) {
    return { value: entry.value, baseHash: entry.baseHash, remoteNotice: false }
  }

  // Draft identical to the current note: nothing unsaved.
  if (entry.value === noteContent) {
    return { value: noteContent, baseHash: hashNoteContent(noteContent), remoteNotice: false }
  }

  const noteHash = hashNoteContent(noteContent)

  // The note hasn't moved since the draft was written: an ordinary draft.
  if (entry.baseHash === noteHash) {
    return { value: entry.value, baseHash: entry.baseHash, remoteNotice: false }
  }

  // Unknown provenance (legacy bare-string draft): load as before, silently.
  if (entry.baseHash === null) {
    return { value: entry.value, baseHash: null, remoteNotice: false }
  }

  // The note advanced while the draft slept.
  if (hashNoteContent(entry.value) === entry.baseHash) {
    // The draft is an unmodified copy of the old version — no real edits.
    // This is the silent-revert incident: seeding from it would show (and
    // later save) stale content. Drop it and show the newer note.
    clearNoteDraft({ githubRepo, noteId })
    return { value: noteContent, baseHash: noteHash, remoteNotice: false }
  }

  if (sameExceptTimestamp(noteContent, entry.value)) {
    // The user's own save landing (only `updated_at` differs): adopt silently.
    clearNoteDraft({ githubRepo, noteId })
    return { value: noteContent, baseHash: noteHash, remoteNotice: false }
  }

  // Real edits based on an older version of the note: keep them visible, but
  // raise the remote notice immediately (not waiting for a further pull) so
  // the user knows the note moved on — and a plain save is blocked until they
  // choose (see `canSaveSilently`).
  return { value: entry.value, baseHash: entry.baseHash, remoteNotice: true }
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
 *
 * Drafts carry provenance (the hash of the note content they were based on),
 * so the notice is also raised at MOUNT when a persisted draft predates the
 * current note (see `seedEditorState`), and while the notice is up
 * `canSaveSilently` is false — a plain save is blocked so a stale editor can
 * never silently overwrite a newer note.
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

  // Computed once at mount (lazy initializer); see `seedEditorState`.
  const [seed] = useState(() => seedEditorState({ githubRepo, noteId, note, defaultValue }))

  const [editorValue, _setEditorValue] = useState(seed.value)

  // Track previous note content to detect external changes
  const [prevNoteContent, setPrevNoteContent] = useState(note?.content)

  // Provenance of the current editor value: the hash of the note content it
  // is based on (null = unknown). Threaded into every draft write so a
  // reloaded draft can be recognized as stale after the note advances.
  const [editorBaseHash, setEditorBaseHash] = useState(seed.baseHash)

  // The note changed remotely while the user had unsaved local edits — either
  // detected live (an external change while editing) or at mount (a persisted
  // draft whose recorded base shows the note advanced while the draft slept).
  const [remoteNotice, setRemoteNotice] = useState(seed.remoteNotice)

  // Adjust state during render when note content changes externally (no effect needed)
  // See: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  if (note?.content !== prevNoteContent) {
    const draft = getNoteDraftEntry({ githubRepo, noteId })?.value ?? null
    // A stale no-op draft — byte-identical to the pre-change note content —
    // carries no real edits (e.g. a draft written and never cleaned up before
    // the note round-tripped). It must not count as local work: without this,
    // every later pull would raise a phantom "updated on another device"
    // notice on a note the user never touched.
    const draftIsStaleNoop = draft !== null && draft === prevNoteContent
    const hasLocalEdits = editorValue !== prevNoteContent || (draft !== null && !draftIsStaleNoop)
    setPrevNoteContent(note?.content)
    if (note?.content !== undefined) {
      if (!hasLocalEdits) {
        // No unsaved work — show the new (pulled) content immediately, and
        // clear the stale no-op draft (if any) so it can't linger.
        if (draftIsStaleNoop) clearNoteDraft({ githubRepo, noteId })
        _setEditorValue(note.content)
        setEditorBaseHash(hashNoteContent(note.content))
        setRemoteNotice(false)
      } else if (note.content === editorValue) {
        // The external change caught up with the local value (a save landing).
        setEditorBaseHash(hashNoteContent(note.content))
        setRemoteNotice(false)
      } else if (sameExceptTimestamp(note.content, editorValue)) {
        // The user's own save landing: useSaveNote stamps `updated_at` into
        // the frontmatter, so the saved note is byte-different from the editor
        // value by an invisible timestamp. Adopt it silently — raising the
        // remote notice here made every ⌘S cry "updated on another device".
        _setEditorValue(note.content)
        setEditorBaseHash(hashNoteContent(note.content))
        clearNoteDraft({ githubRepo, noteId })
        setRemoteNotice(false)
      } else {
        // Unsaved local edits — keep them, surface the notice. The base hash
        // deliberately stays put: the editor value is still rooted in the
        // OLD content, and draft writes must keep saying so.
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
        // Persist with provenance so a reloaded draft knows what it was based on.
        setNoteDraft({ githubRepo, noteId, value, baseHash: editorBaseHash })
      } else {
        clearNoteDraft({ githubRepo, noteId })
        // Back in sync with the saved note — that's the new base.
        if (note) setEditorBaseHash(hashNoteContent(note.content))
      }
    },
    [note, defaultValue, githubRepo, noteId, editorBaseHash],
  )

  const discardChanges = useCallback(() => {
    // Reset editor value to the last saved state of the note
    _setEditorValue(note?.content ?? defaultValue)
    setEditorBaseHash(note ? hashNoteContent(note.content) : null)
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
    /**
     * False while `remoteNotice` is up — the editor value is known to be
     * based on an older version than `note.content`, so a plain ⌘S/Save must
     * not commit (it would silently overwrite the newer version). The
     * explicit override ("Save mine anyway") saves regardless; dismissing the
     * notice re-enables plain saves.
     */
    canSaveSilently: !remoteNotice,
    loadRemoteVersion,
    dismissRemoteNotice,
  }
}
