import { useCallback, useEffect, useRef, useState } from "react"
import { Note } from "../schema"

export const AUTOSAVE_DEBOUNCE_MS = 1000

/**
 * The note page's editor state with write-through autosave: a local markdown
 * string seeded from the note (or a template), handed to `onSave` a moment
 * after every change, and flushed immediately when the page hides or the
 * editor unmounts — so the store is always the source of truth and nothing is
 * lost on refresh or navigation.
 *
 * When the note's content changes underneath us (a D1 pull bringing another
 * device's edits, or our own save round-tripping with a stamped `updated_at`):
 * - with no unflushed local edits, the editor re-seeds to the new content, so
 *   pulled changes appear immediately;
 * - mid-edit, the local value wins and the next autosave flush settles it —
 *   per-row last-writer-wins, same as the replica layer.
 */
export function useEditorValue({
  note,
  defaultValue,
  onSave,
}: {
  note: Note | undefined
  defaultValue: string
  /** Persist one editor value (the route's save path: stamp `updated_at` → write the store). */
  onSave: (value: string) => void
}) {
  const [editorValue, _setEditorValue] = useState(() => note?.content ?? defaultValue)

  // Track previous note content to detect external changes
  const [prevNoteContent, setPrevNoteContent] = useState(note?.content)

  // What the editor was last seeded/synced to. Never undefined (unlike
  // `prevNoteContent`), so "the user changed something" stays a real
  // comparison even before the note has loaded.
  const [baseValue, setBaseValue] = useState(() => note?.content ?? defaultValue)

  // The last value handed to onSave — edits newer than this are unflushed
  // local work an external note change must never clobber.
  const [lastSavedValue, setLastSavedValue] = useState<string | null>(null)

  // Latest values for flushes that fire outside the render cycle (the
  // debounce timer, hide/pagehide, unmount).
  const latest = useRef({ editorValue, onSave })
  useEffect(() => {
    latest.current = { editorValue, onSave }
  })

  const timerRef = useRef<number | null>(null)
  const pendingRef = useRef<string | null>(null)

  /** Cancel the debounce and save the pending edit right now (⌘S, hide, unmount). */
  const flushNow = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const value = pendingRef.current
    if (value === null) return
    pendingRef.current = null
    // An external re-seed can supersede a pending no-op edit (typed and
    // reverted); saving those stale bytes would overwrite the newer content
    // the editor now shows.
    if (value !== latest.current.editorValue) return
    setLastSavedValue(value)
    latest.current.onSave(value)
  }, [])

  const setEditorValue = useCallback(
    (value: string) => {
      _setEditorValue(value)
      latest.current.editorValue = value
      pendingRef.current = value
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

  // Adjust state during render when note content changes externally (no effect needed)
  // See: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  if (note?.content !== prevNoteContent) {
    setPrevNoteContent(note?.content)
    if (note?.content !== undefined) {
      // Compare against what the editor was last SEEDED with, not the previous
      // note content: on a cold load the note is undefined for a beat (the
      // store is still opening), so the editor seeds from `defaultValue` — and
      // comparing that against `undefined` read as "the user has edits",
      // leaving the arriving note unrendered behind a blank editor.
      const hasUnflushedEdits = editorValue !== baseValue && editorValue !== lastSavedValue
      if (!hasUnflushedEdits) {
        _setEditorValue(note.content)
        setBaseValue(note.content)
      }
    }
  }

  return { editorValue, setEditorValue, flushNow }
}
