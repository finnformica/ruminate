import { atom } from "jotai"
import { useAtomCallback } from "jotai/utils"
import React from "react"
import { isDatabaseModeAtom, markdownFilesAtom, sampleGraphAtom } from "../global-state"
import type { NoteId } from "../schema"
import { databaseApplyOps, databaseDeleteFile, databaseWriteFiles } from "./database-mode"
import { applyOps, type Op } from "./ops"

/**
 * The storage seam.
 *
 * This module is the ONLY place that knows notes are persisted as `<id>.md`
 * entries in a repo-file-shaped map. Everything above it works in terms of
 * note ids and note content; the file-path convention and the raw
 * `markdownFiles` shape live here.
 *
 * Writes route to the database runtime (`src/data/database-mode.ts`): the
 * files atom updates synchronously, the local SQL store persists the write,
 * and the replica queue pushes it to D1. Signed out (sample notes) the
 * runtime is not mounted and writes are no-ops.
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
function useWriteFiles() {
  return React.useCallback((files: Record<string, string | null>) => {
    databaseWriteFiles(files)
  }, [])
}

/**
 * Persist a batch of note writes/deletes. Keys are note ids; a string value
 * writes that note, `null` deletes it. The single write primitive the
 * higher-level note hooks build on.
 */
export function useWriteNotes() {
  const writeFiles = useWriteFiles()
  return React.useCallback(
    (updates: Record<NoteId, string | null>) => {
      const files: Record<string, string | null> = {}
      for (const [id, content] of Object.entries(updates)) {
        files[noteIdToPath(id)] = content
      }
      writeFiles(files)
    },
    [writeFiles],
  )
}

/**
 * Apply a batch of graph ops (`src/data/ops.ts`) — the editor's change path.
 * Signed in they go to the database runtime (graph atom at once, store and
 * replica behind it); signed out they apply to the in-memory sample graph.
 */
export function useApplyOps() {
  return useAtomCallback(
    React.useCallback((get, set, ops: readonly Op[]) => {
      if (ops.length === 0) return
      if (get(isDatabaseModeAtom)) databaseApplyOps(ops)
      else set(sampleGraphAtom, applyOps(get(sampleGraphAtom), ops, Date.now()))
    }, []),
  )
}

/** Delete a single note. */
export function useDeleteNoteFile() {
  return React.useCallback((id: NoteId) => {
    databaseDeleteFile(noteIdToPath(id))
  }, [])
}

/** Imperatively read all note contents (id -> markdown) inside a callback. */
export function useGetNoteContents() {
  return useAtomCallback(React.useCallback((get) => get(noteContentsAtom), []))
}
