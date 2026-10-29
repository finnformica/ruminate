import copy from "copy-to-clipboard"
import { useAtomValue, useSetAtom, useStore } from "jotai"
import React from "react"
import { blockRollup } from "../data/graph"
import { receivedSharesAtom, sharePermissions, sharedOriginAtom } from "../data/shared-mode"
import { useApplyOps } from "../data/store"
import { pinnedAtOf } from "../data/pins"
import { graphSnapshotAtom, isDatabaseModeAtom, isSignedOutAtom } from "../global-state"
import { useSetPinned } from "../hooks/pins"
import { copyAsMarkdown } from "../utils/copy-markdown"
import { type MenuEntry } from "./block-editor/block-context-menu"
import { CopyIcon16, EditIcon16, LinkIcon16, PinIcon16, ShareIcon16 } from "./icons"
import { shareDialogAtom } from "./share-note-dialog"

/**
 * **A block's menu outside its note, as entries** (`MenuEntry`): the block
 * menu (`block-context-menu.tsx`) cut to what reaches beyond the note and
 * does not edit — Copy, Copy link to block, Share — and then its pin
 * (`src/data/pins.ts`): **Unpin** on a pinned block, **Pin** on one that is
 * not (a search result in the palette). On a pinned block, **Rename** sets
 * the block's text, since the text is what its Pinned row is called — where
 * the reader may edit the note. A block of a note someone shared is not
 * offered a pin: its props are the owner's.
 *
 * One list on every surface that meets a block away from its note: the
 * sidebar's ⋯ on a pinned block (`nav-items.tsx`, and on a right-click of
 * the row) and a right-click on a block's row in the palette
 * (`results-editor.tsx`). The note's own editor keeps its full menu, with
 * the same Pin / Unpin item among the editing.
 *
 * A builder rather than the entries, as `useNoteMenuEntries` is: a list
 * builds a menu per row as it opens.
 */
export function useBlockViewMenuEntries() {
  const jotaiStore = useStore()
  const setPinned = useSetPinned()
  // Subscribed, so a row's menu follows the block's pin as it changes.
  const graph = useAtomValue(graphSnapshotAtom)
  // Sharing is the owner's: signed in, and not a note someone shared with
  // them (docs/sharing.md).
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const openShare = useSetAtom(shareDialogAtom)
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const applyOps = useApplyOps()

  return React.useCallback(
    (blockId: string, noteId: string): MenuEntry[] => {
      const node = graph.nodes.get(blockId)
      const pinned = node !== undefined && pinnedAtOf(node) !== null
      const shared = jotaiStore.get(sharedOriginAtom).has(noteId)
      const canShare = isDatabaseMode && !shared
      const copyBlock = () =>
        copyAsMarkdown(blockRollup(blockId, jotaiStore.get(graphSnapshotAtom)) ?? "")
      const copyLink = () => copy(`${window.location.origin}/notes/${noteId}?block=${blockId}`)
      // A block in a note someone shared is theirs: renamed only with `write`.
      const shareId = jotaiStore.get(sharedOriginAtom).get(noteId)
      const share =
        shareId === undefined
          ? undefined
          : jotaiStore.get(receivedSharesAtom).find((entry) => entry.id === shareId)
      const canRename = !isSignedOut && (!share || sharePermissions(share).write)
      const rename = () => {
        const current = jotaiStore.get(graphSnapshotAtom).nodes.get(blockId)?.text ?? ""
        const raw = window.prompt("Rename block", current)
        if (raw == null || raw === current) return
        applyOps([{ op: "setText", id: blockId, text: raw }])
      }
      return [
        { kind: "item", label: "Copy", icon: <CopyIcon16 />, onSelect: copyBlock },
        { kind: "item", label: "Copy link to block", icon: <LinkIcon16 />, onSelect: copyLink },
        {
          kind: "item",
          label: "Share",
          icon: <ShareIcon16 />,
          disabled: !canShare,
          onSelect: () => openShare(blockId),
        },
        ...(pinned
          ? ([
              {
                kind: "item",
                label: "Rename",
                icon: <EditIcon16 />,
                disabled: !canRename,
                onSelect: rename,
              },
            ] satisfies MenuEntry[])
          : []),
        ...(shared
          ? []
          : ([
              { kind: "separator" },
              {
                kind: "item",
                label: pinned ? "Unpin" : "Pin",
                icon: <PinIcon16 />,
                onSelect: () => setPinned([blockId], !pinned),
              },
            ] satisfies MenuEntry[])),
      ]
    },
    [jotaiStore, setPinned, graph, isDatabaseMode, openShare, isSignedOut, applyOps],
  )
}
