import { useAtomValue } from "jotai"
import { useAtomCallback } from "jotai/utils"
import React from "react"
import { markdownFilesAtom } from "../global-state"
import {
  startStorageMirror,
  stopStorageMirror,
  storageEngineAtom,
  verifyStorageMirror,
} from "./storage-mirror"
import { useWriteNotes } from "./store"

/**
 * Mounts the storage mirror (see `storage-mirror.ts`). Rendered once from the
 * app root; everything it does is gated on the experimental
 * `storageEngineAtom` flag, so with the flag off this is inert.
 *
 * The two effects are the read-side choke points of the trial:
 * - flag flipped on → open + ingest (writes go through `mirrorFileWrites`,
 *   wired inside `store.ts`'s `useWriteFiles`/`useDeleteNoteFile` — the single
 *   funnel all note and view-state writes already pass through);
 * - `markdownFilesAtom` changed (a save committed, a pull repopulated the
 *   worktree, a follower tab refreshed) → shadow-read verify pass.
 */
export function useStorageMirror() {
  const engine = useAtomValue(storageEngineAtom)
  const markdownFiles = useAtomValue(markdownFilesAtom)
  const writeNotes = useWriteNotes()
  const getFiles = useAtomCallback(React.useCallback((get) => get(markdownFilesAtom), []))

  React.useEffect(() => {
    if (engine !== "database") return
    startStorageMirror({ getFiles, writeNotes })
    return () => stopStorageMirror()
  }, [engine, getFiles, writeNotes])

  React.useEffect(() => {
    if (engine !== "database") return
    verifyStorageMirror(markdownFiles)
  }, [engine, markdownFiles])
}
