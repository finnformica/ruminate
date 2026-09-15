import { useAtomValue } from "jotai"
import { selectAtom } from "jotai/utils"
import React from "react"
import { receivedSharesAtom, sharedOriginAtom } from "../data/shared-mode"
import type { ReceivedShareSummary } from "../data/shares"
import type { NoteId } from "../schema"

/**
 * The share a note (or block) came from, or null for the user's own
 * (docs/sharing.md). Null signed out too — the sample notes are nobody's
 * share.
 */
export function useNoteShare(id: NoteId | undefined): ReceivedShareSummary | null {
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
  return useAtomValue(shareAtom) ?? null
}
