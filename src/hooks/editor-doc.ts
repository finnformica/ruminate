import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { serialize } from "../blocks/serialize"
import type { BlockDoc } from "../blocks/types"
import { pageDoc, type GraphSnapshot } from "../data/graph"

export const AUTOSAVE_DEBOUNCE_MS = 1000

/**
 * The note page's editor state with write-through autosave: a doc walked
 * from the graph (`pageDoc`) — or, for a note that does not exist yet, the
 * given default (a template, imported) — handed to `onSave` a moment after
 * every change, and flushed immediately when the page hides or the editor
 * unmounts, so the store is always the source of truth and nothing is lost
 * on refresh or navigation.
 *
 * When the note changes underneath us in the graph (a D1 pull bringing
 * another device's edits, or our own save landing with a stamped
 * `updated_at`):
 * - with no unflushed local edits, the editor re-seeds from the graph, so
 *   pulled changes appear immediately;
 * - mid-edit, the local doc wins and the next autosave flush settles it —
 *   per-row last-writer-wins, same as the replica layer.
 *
 * "Changed" is judged on the doc's serialization: the same bytes are the same
 * note, whatever object holds them.
 */
export function useEditorDoc({
  noteId,
  snapshot,
  defaultDoc,
  onSave,
}: {
  noteId: string | undefined
  /** The live graph (`graphSnapshotAtom`). */
  snapshot: GraphSnapshot
  /** What a note that is not in the graph yet starts as (a template, or empty). */
  defaultDoc: BlockDoc
  /** Persist one editor doc (the route's save path: stamp `updated_at` → write the store). */
  onSave: (doc: BlockDoc) => void
}) {
  // The note's doc as the graph holds it, and its bytes — the change signal.
  const stored = useMemo(
    () => (noteId === undefined ? null : pageDoc(noteId, snapshot)),
    [noteId, snapshot],
  )
  const storedKey = useMemo(() => (stored ? serialize(stored) : undefined), [stored])

  const [editorDoc, _setEditorDoc] = useState<BlockDoc>(() => stored ?? defaultDoc)
  const editorKey = useMemo(() => serialize(editorDoc), [editorDoc])

  // Track the previous stored bytes to detect external changes.
  const [prevStoredKey, setPrevStoredKey] = useState(storedKey)

  // What the editor was last seeded/synced to. Never undefined (unlike
  // `prevStoredKey`), so "the user changed something" stays a real
  // comparison even before the note has loaded.
  const [baseKey, setBaseKey] = useState(() => serialize(stored ?? defaultDoc))

  // The last doc handed to onSave (its bytes) — edits newer than this are
  // unflushed local work an external change must never clobber.
  const [lastSavedKey, setLastSavedKey] = useState<string | null>(null)

  // Latest values for flushes that fire outside the render cycle (the
  // debounce timer, hide/pagehide, unmount).
  const latest = useRef({ editorDoc, onSave })
  useEffect(() => {
    latest.current = { editorDoc, onSave }
  })

  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<BlockDoc | null>(null)

  /** Cancel the debounce and save the pending edit right now (⌘S, hide, unmount). */
  const flushNow = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const doc = pendingRef.current
    if (doc === null) return
    pendingRef.current = null
    // An external re-seed can supersede a pending no-op edit (typed and
    // reverted); saving those stale blocks would overwrite the newer content
    // the editor now shows.
    if (doc !== latest.current.editorDoc) return
    setLastSavedKey(serialize(doc))
    latest.current.onSave(doc)
  }, [])

  const setEditorDoc = useCallback(
    (doc: BlockDoc) => {
      _setEditorDoc(doc)
      latest.current.editorDoc = doc
      pendingRef.current = doc
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(flushNow, AUTOSAVE_DEBOUNCE_MS)
    },
    [flushNow],
  )

  // Mirror replica-sync's hide-flush: backgrounding or leaving the page inside
  // the debounce window must not strand the last edits. Unmount (note switch,
  // navigation) flushes too.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushNow()
    }
    window.addEventListener("pagehide", flushNow)
    document.addEventListener("visibilitychange", onHidden)
    return () => {
      window.removeEventListener("pagehide", flushNow)
      document.removeEventListener("visibilitychange", onHidden)
      flushNow()
    }
  }, [flushNow])

  // Adjust state during render when the stored note changes externally (no effect needed)
  // See: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  if (storedKey !== prevStoredKey) {
    setPrevStoredKey(storedKey)
    if (stored !== null && storedKey !== undefined) {
      // Compare against what the editor was last SEEDED with, not the previous
      // stored bytes: on a cold load the note is absent for a beat (the store
      // is still opening), so the editor seeds from `defaultDoc` — and
      // comparing that against `undefined` read as "the user has edits",
      // leaving the arriving note unrendered behind a blank editor.
      const hasUnflushedEdits = editorKey !== baseKey && editorKey !== lastSavedKey
      if (!hasUnflushedEdits) {
        _setEditorDoc(stored)
        setBaseKey(storedKey)
      }
    }
  }

  return { editorDoc, setEditorDoc, flushNow }
}
