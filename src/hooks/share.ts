import { useAtomValue } from "jotai"
import { selectAtom } from "jotai/utils"
import React from "react"
import { receivedSharesAtom, sharePermissions, sharedOriginAtom } from "../data/shared-mode"
import type { ReceivedShareSummary } from "../data/shares"
import type { NoteId } from "../schema"

/** What the UI needs to know about a shared note: whose share it is in, and
 * which verbs the owner granted (docs/sharing.md). */
export interface NoteShare {
  share: ReceivedShareSummary
  canWrite: boolean
  canDelete: boolean
}

/**
 * The share a note (or block) came from, or null for the user's own. Null
 * signed out too — the sample notes are nobody's share.
 */
export function useNoteShare(id: NoteId | undefined): NoteShare | null {
  const shareIdAtom = React.useMemo(
    () => selectAtom(sharedOriginAtom, (origin) => (id === undefined ? undefined : origin.get(id))),
    [id],
  )
  const shareId = useAtomValue(shareIdAtom)
  const shareAtom = React.useMemo(
    () =>
      selectAtom(receivedSharesAtom, (shares) =>
        shareId === undefined ? undefined : shares.find((entry) => entry.id === shareId),
      ),
    [shareId],
  )
  const share = useAtomValue(shareAtom)
  return React.useMemo(() => {
    if (!share) return null
    const verbs = sharePermissions(share)
    return { share, canWrite: verbs.write, canDelete: verbs.delete }
  }, [share])
}
