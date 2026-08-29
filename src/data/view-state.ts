import { useAtomValue } from "jotai"
import { selectAtom, useAtomCallback } from "jotai/utils"
import React from "react"
import { markdownFilesAtom } from "../global-state"
import { useWriteFiles } from "./store"
import { buildViewStateWrite, readNoteViewState } from "./view-state-parse"

/**
 * Per-note view state, stored one entry per note under
 * `.ruminate/view-state/<noteId>.json` (backed by the store's `view_state`
 * table and replicated to D1 alongside the owning note), so it persists
 * across reloads and devices — but it is kept out of note content so folding
 * a block never rewrites a note.
 */

const EMPTY: string[] = []

const sameIds = (a: string[], b: string[]) =>
  a === b || (a.length === b.length && a.every((id, i) => id === b[i]))

/**
 * Collapse state for one note: the set of collapsed block ids plus a toggle.
 *
 * Seeds from the synced sidecar on mount (the note page remounts per note, so a
 * fresh seed happens on every navigation). Toggles update local state
 * immediately for a snappy UI, and are persisted debounced (1s) — a burst of
 * folds collapses into a single write. A pending write is flushed on unmount
 * so navigating away never drops the last fold. Writes that would not change
 * the serialized content (e.g. fold-then-unfold) are skipped entirely.
 */
export function useCollapseState(noteId: string | undefined) {
  const persistedAtom = React.useMemo(
    () =>
      selectAtom(
        markdownFilesAtom,
        (files) => (noteId ? readNoteViewState(files, noteId) : EMPTY),
        sameIds,
      ),
    [noteId],
  )
  const persisted = useAtomValue(persistedAtom)

  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set(persisted))

  const writeFiles = useWriteFiles()
  const getMarkdownFiles = useAtomCallback(React.useCallback((get) => get(markdownFilesAtom), []))

  // Keep the latest set in a ref so the debounced flush reads current state.
  const latest = React.useRef(collapsed)
  latest.current = collapsed
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = React.useCallback(() => {
    timer.current = null
    if (!noteId) return
    // `buildViewStateWrite` returns null when nothing changed, so unchanged
    // state never produces a write.
    const updates = buildViewStateWrite(getMarkdownFiles(), noteId, [...latest.current])
    if (updates) writeFiles(updates)
  }, [noteId, getMarkdownFiles, writeFiles])

  const toggleCollapse = React.useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, 1000)
    },
    [flush],
  )

  // Flush any pending write when the note unmounts (navigation) so the last
  // toggle within the debounce window is not lost.
  const flushRef = React.useRef(flush)
  flushRef.current = flush
  React.useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
        flushRef.current()
      }
    },
    [],
  )

  return { collapsed, toggleCollapse }
}
