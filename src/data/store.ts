import { atom, useSetAtom } from "jotai"
import { useAtomCallback } from "jotai/utils"
import React from "react"
import { globalStateMachineAtom, markdownFilesAtom } from "../global-state"
import type { NoteId } from "../schema"
import { mirrorDeleteFile, mirrorFileWrites } from "./storage-mirror"

/**
 * The storage seam.
 *
 * This module is the ONLY place that knows notes are persisted as `<id>.md`
 * files driven through the XState machine. Everything above it works in terms
 * of note ids and note content; the file-path convention, the `WRITE_FILES` /
 * `DELETE_FILE` events, and the raw `markdownFiles` shape all live here.
 *
 * Swapping the backing store (e.g. to SQLite) means reimplementing this
 * module — callers do not change.
 *
 * Note ids map 1:1 to files as `<id>.md`. Non-note files that happen to live in
 * the repo (e.g. `.ruminate/view-state.json`) are intentionally excluded from
 * the note accessors below, so note-wide operations never touch them.
 */

const noteIdToPath = (id: NoteId) => `${id}.md`

/** Raw markdown of every note, keyed by note id (the `.md` suffix removed). */
const noteContentsAtom = atom((get) => {
  const files = get(markdownFilesAtom)
  const contents: Record<NoteId, string> = {}
  for (const filepath in files) {
    if (!filepath.endsWith(".md")) continue
    contents[filepath.replace(/\.md$/, "")] = files[filepath]
  }
  return contents
})

/**
 * Low-level: write/delete arbitrary repo files (path -> content, or `null` to
 * delete). Used within the data layer only — code outside `src/data` should use
 * the note-oriented API so it never depends on the file-path convention.
 */
export function useWriteFiles() {
  const send = useSetAtom(globalStateMachineAtom)
  return React.useCallback(
    (files: Record<string, string | null>, commitMessage?: string) => {
      send({ type: "WRITE_FILES", markdownFiles: files, commitMessage })
      // Dual-write (experimental database store): git first — the machine event
      // above is the canonical write — then mirror into the SQL store. A no-op
      // unless the storage flag is on; never throws, never blocks the git path.
      mirrorFileWrites(files)
    },
    [send],
  )
}

/**
 * Persist a batch of note writes/deletes. Keys are note ids; a string value
 * writes that note, `null` deletes it. The single write primitive the
 * higher-level note hooks build on.
 */
export function useWriteNotes() {
  const writeFiles = useWriteFiles()
  return React.useCallback(
    (updates: Record<NoteId, string | null>, commitMessage?: string) => {
      const files: Record<string, string | null> = {}
      for (const [id, content] of Object.entries(updates)) {
        files[noteIdToPath(id)] = content
      }
      writeFiles(files, commitMessage)
    },
    [writeFiles],
  )
}

/** Delete a single note, preserving the machine's dedicated delete/commit path. */
export function useDeleteNoteFile() {
  const send = useSetAtom(globalStateMachineAtom)
  return React.useCallback(
    (id: NoteId) => {
      send({ type: "DELETE_FILE", filepath: noteIdToPath(id) })
      // Dual-write (see `useWriteFiles`): mirror the delete into the SQL store.
      mirrorDeleteFile(noteIdToPath(id))
    },
    [send],
  )
}

/** Imperatively read all note contents (id -> markdown) inside a callback. */
export function useGetNoteContents() {
  return useAtomCallback(React.useCallback((get) => get(noteContentsAtom), []))
}
