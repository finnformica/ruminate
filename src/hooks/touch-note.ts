import { useSetAtom } from "jotai"
import { useCallback, useEffect } from "react"
import { touchNoteAtom } from "../global-state"

/**
 * The note page's one seam for TOUCHING a note — what the palette's Recent
 * list is built from (`touchNoteAtom`, coalesced there). A note is touched
 * exactly when it is opened (this hook's mount, or `noteId` changing),
 * edited, a block in it folded or unfolded, or focused on — each an
 * editor callback the page wraps with `touching`. Never by selecting,
 * focusing or arrowing through it: reading a note is not touching it.
 */
export function useTouchNote(noteId: string | undefined) {
  const touchNote = useSetAtom(touchNoteAtom)
  // Opened.
  useEffect(() => {
    if (noteId) touchNote(noteId)
  }, [noteId, touchNote])
  const touch = useCallback(() => {
    if (noteId) touchNote(noteId)
  }, [noteId, touchNote])
  /** A callback that also touches the note: `touching(fn)` runs `fn` with
   * its arguments after noting the touch. */
  const touching = useCallback(
    <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        touch()
        fn(...args)
      },
    [touch],
  )
  return { touch, touching }
}
