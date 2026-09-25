import copy from "copy-to-clipboard"
import { useAtomValue, useSetAtom, useStore } from "jotai"
import React from "react"
import { useFeature } from "../data/features"
import { blockRollup } from "../data/graph"
import { sharedOriginAtom } from "../data/shared-mode"
import { viewRootIdsAtom } from "../data/views"
import { graphSnapshotAtom, isDatabaseModeAtom } from "../global-state"
import { REMOVE_VIEW, useWriteView } from "../hooks/views"
import { copyAsMarkdown } from "../utils/copy-markdown"
import { type MenuEntry } from "./block-editor/block-context-menu"
import { reorderEntries, type ReorderActions } from "./note-actions-menu"
import { CopyIcon16, LinkIcon16, PlusIcon16, ShareIcon16, TrashIcon16 } from "./icons"
import { shareDialogAtom } from "./share-note-dialog"

/**
 * **A block's menu outside its note, as entries** (`MenuEntry`): the block
 * menu (`block-context-menu.tsx`) cut to what reaches beyond the note and
 * does not edit — Copy, Copy link to block, Share… — and then the block's
 * place in Views: **Remove from Views** on a block view, **Add to Views** on
 * a block that is not one yet (a search result in the palette).
 *
 * One list on every surface that meets a block away from its note: the
 * sidebar's ⋯ on a block view (`nav-items.tsx`, with the list's moves ahead
 * of it) and a right-click on a block's row on the Views page and in the
 * palette (`results-editor.tsx`). The note's own editor keeps its full menu,
 * with the same Add to / Remove from Views item among the editing.
 *
 * A builder rather than the entries, as `useNoteMenuEntries` is: the Views
 * page builds a list per row as its menu opens.
 */
export function useBlockViewMenuEntries() {
  const jotaiStore = useStore()
  const writeView = useWriteView()
  const viewRoots = useAtomValue(viewRootIdsAtom)
  // Sharing is the owner's: signed in, the feature on, and not a note
  // someone shared with them (docs/sharing.md).
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const sharingEnabled = useFeature("sharing")
  const openShare = useSetAtom(shareDialogAtom)

  return React.useCallback(
    (blockId: string, noteId: string, options: { reorder?: ReorderActions } = {}): MenuEntry[] => {
      const inViews = viewRoots.has(blockId)
      const canShare =
        isDatabaseMode && sharingEnabled && !jotaiStore.get(sharedOriginAtom).has(noteId)
      const copyBlock = () =>
        copyAsMarkdown(blockRollup(blockId, jotaiStore.get(graphSnapshotAtom)) ?? "")
      const copyLink = () => copy(`${window.location.origin}/views/${noteId}?block=${blockId}`)
      return [
        ...(options.reorder ? reorderEntries(options.reorder) : []),
        { kind: "item", label: "Copy", icon: <CopyIcon16 />, onSelect: copyBlock },
        { kind: "item", label: "Copy link to block", icon: <LinkIcon16 />, onSelect: copyLink },
        {
          kind: "item",
          label: "Share…",
          icon: <ShareIcon16 />,
          disabled: !canShare,
          onSelect: () => openShare(blockId),
        },
        { kind: "separator" },
        inViews
          ? {
              kind: "item",
              label: "Remove from Views",
              icon: <TrashIcon16 />,
              onSelect: () => writeView(blockId, REMOVE_VIEW),
            }
          : {
              kind: "item",
              label: "Add to Views",
              icon: <PlusIcon16 />,
              onSelect: () => writeView(blockId, { pinned: true }),
            },
      ]
    },
    [jotaiStore, writeView, viewRoots, isDatabaseMode, sharingEnabled, openShare],
  )
}
