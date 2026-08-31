import { useAtomValue } from "jotai"
import { selectAtom, useAtomCallback } from "jotai/utils"
import React from "react"
import { dateMentionsAtom, githubUserAtom, notesAtom } from "../global-state"
import { useDeleteNoteFile, useWriteNotes } from "../data/store"
import { Note, NoteId } from "../schema"
import { parseFrontmatter, updateFrontmatterValue } from "../utils/frontmatter"
import { deleteGist } from "../utils/gist"
import { resolveNoteId } from "../utils/note-alias"

const EMPTY_MENTIONS: NoteId[] = []

const shallowEqualIds = (a: NoteId[], b: NoteId[]) => {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function useNoteById(id: NoteId | undefined) {
  const noteAtom = React.useMemo(
    () => selectAtom(notesAtom, (notes) => (id ? notes.get(id) : undefined)),
    [id],
  )
  const note = useAtomValue(noteAtom)
  return note
}

/**
 * Resolve a note URL's id: itself when a live note exists, the live note's id
 * when the id is a former id recorded in `aliases` (the route redirects
 * there), or null when the id is brand new (the route shows the new-note
 * editor). See `resolveNoteId` in src/utils/note-alias.ts.
 */
export function useResolvedNoteId(id: NoteId | undefined) {
  const resolvedAtom = React.useMemo(
    () => selectAtom(notesAtom, (notes) => (id ? resolveNoteId(notes, id) : null)),
    [id],
  )
  return useAtomValue(resolvedAtom)
}

/** Get the notes referencing a date/week id (via frontmatter date properties),
 * even if no note exists for that id */
export function useDateMentions(id: NoteId | undefined) {
  const mentionsAtom = React.useMemo(
    () =>
      selectAtom(
        dateMentionsAtom,
        (index) => (id ? (index.get(id) ?? EMPTY_MENTIONS) : EMPTY_MENTIONS),
        shallowEqualIds,
      ),
    [id],
  )
  return useAtomValue(mentionsAtom)
}

export function useSaveNote() {
  const writeNotes = useWriteNotes()

  const saveNote = React.useCallback(
    ({ id, content }: Pick<Note, "id" | "content">) => {
      // Add updated_at timestamp to frontmatter — this is also what makes the
      // replica's incremental pulls work (docs/graph-storage.md).
      const contentWithTimestamp = updateFrontmatterValue({
        content,
        properties: { updated_at: new Date() },
      })

      writeNotes({ [id]: contentWithTimestamp })
    },
    [writeNotes],
  )

  return saveNote
}

/**
 * Rename a note — which, since ids are minted and opaque
 * (docs/page-identity-design.md), is simply **setting its title**.
 *
 * The title travels as the projection-owned `title:` frontmatter key, so this
 * writes one property and ingest lifts it onto the page node's `text`. Nothing
 * else moves: the id, the URL, every deep link and every block row are
 * untouched, and exactly one row changes, so a rename cannot clobber a
 * concurrent edit under per-row LWW.
 *
 * The old world's failure modes are gone with the old world: there is no
 * filename charset to violate and no uniqueness to collide with, because the
 * title is no longer an identifier.
 */
export function useRenameNote() {
  const writeNotes = useWriteNotes()

  return React.useCallback(
    (params: { noteId: NoteId; newTitle: string; content: string }): boolean => {
      const { noteId, newTitle, content } = params
      if (!noteId) return false

      const title = newTitle.trim()
      const { frontmatter } = parseFrontmatter(content)
      const current = typeof frontmatter.title === "string" ? frontmatter.title : ""
      if (title === current) return false

      writeNotes({
        // An emptied title clears the key rather than storing "", so the note
        // falls back to its content preview like any untitled note.
        [noteId]: updateFrontmatterValue({
          content,
          properties: { title: title || null },
        }),
      })
      return true
    },
    [writeNotes],
  )
}

export function useDeleteNote() {
  const deleteNoteFile = useDeleteNoteFile()
  const githubUser = useAtomValue(githubUserAtom)
  const getNoteById = useAtomCallback(
    React.useCallback((get, set, id: NoteId) => {
      const notes = get(notesAtom)
      return notes.get(id)
    }, []),
  )

  const deleteNote = React.useCallback(
    async (id: NoteId) => {
      // If the note has a gist ID, delete the gist
      const note = getNoteById(id)
      if (typeof note?.frontmatter.gist_id === "string" && githubUser?.token) {
        await deleteGist({
          githubToken: githubUser.token,
          gistId: note.frontmatter.gist_id,
        })
      }

      deleteNoteFile(id)
    },
    [deleteNoteFile, githubUser, getNoteById],
  )

  return deleteNote
}
