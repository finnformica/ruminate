import { useSetAtom } from "jotai"
import { useCallback, useEffect } from "react"
import { touchRecentAtom } from "../global-state"

/**
 * The note page's one seam for TOUCHING what it shows — what the Recent
 * lists are ranked from (`touchRecentAtom`, coalesced there). What is
 * touched is the DESTINATION: the block focused on, or else the note. It is
 * touched exactly when it is opened (this hook's mount, or `noteId` or
 * `focusBlockId` changing — so focusing on a block in the editor, and
 * leaving it, each touch where they land), edited, or a block in it folded
 * or unfolded — each an editor callback the page calls `touch` from. Never
 * by selecting, focusing or arrowing through it: reading a note is not
 * touching it.
 */
export function useTouchNote(noteId: string | undefined, focusBlockId?: string | null) {
  const touchRecent = useSetAtom(touchRecentAtom)
  const touch = useCallback(() => {
    if (noteId) touchRecent({ id: focusBlockId ?? noteId, noteId })
  }, [noteId, focusBlockId, touchRecent])
  // Opened.
  useEffect(touch, [touch])
  return touch
}
