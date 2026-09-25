import { useLocation, useNavigate } from "@tanstack/react-router"
import copy from "copy-to-clipboard"
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai"
import React from "react"
import { graphSnapshotAtom, isSignedOutAtom, notesAtom } from "../global-state"
import { useFeature } from "../data/features"
import { blockRollup, rollup } from "../data/graph"
import { receivedSharesAtom, sharePermissions, sharedOriginAtom } from "../data/shared-mode"
import { copyAsMarkdown } from "../utils/copy-markdown"
import { developerDebugPreferenceAtom, useIsDeveloper } from "../hooks/is-developer"
import { useNoteShare } from "../hooks/share"
import { useRenameNote } from "../hooks/note"
import { deleteNoteDialogAtom } from "./delete-note-dialog"
import { shareDialogAtom } from "./share-note-dialog"
import type { Width } from "../schema"
import { cx } from "../utils/cx"
import { MenuItems, type MenuEntry } from "./block-editor/block-context-menu"
import { DropdownMenu } from "./ui/dropdown-menu"
import { IconButton } from "./ui/icon-button"
import {
  ArrowDownIcon16,
  ArrowUpIcon16,
  CopyIcon16,
  EditIcon16,
  MoreIcon16,
  PrinterIcon16,
  ShareIcon16,
  TrashIcon16,
  WidthFixedIcon16,
  WidthFullIcon16,
} from "./icons"

/**
 * The row's place in the manual order, when the list it sits in has one
 * (`src/data/views.ts`). Reordering by drag alone would be reachable by
 * pointer alone, so the sidebar hands the menu the same two moves — which is
 * also the only way to reorder on a touch screen.
 */
export interface ReorderActions {
  onMoveUp?: () => void
  onMoveDown?: () => void
}

/** Move up and Move down as menu entries, greyed where there is nowhere to
 * go: what every sidebar row's menu leads with in the manual sort. */
export function reorderEntries(reorder: ReorderActions): MenuEntry[] {
  return [
    {
      kind: "item",
      label: "Move up",
      icon: <ArrowUpIcon16 />,
      disabled: !reorder.onMoveUp,
      onSelect: () => reorder.onMoveUp?.(),
    },
    {
      kind: "item",
      label: "Move down",
      icon: <ArrowDownIcon16 />,
      disabled: !reorder.onMoveDown,
      onSelect: () => reorder.onMoveDown?.(),
    },
  ]
}

/** What the open note's header adds to the menu. */
interface EditorActions {
  showWidth?: boolean
  width?: Width
  onWidth?: (width: Width) => void
  /** Called after the open note is deleted, so the page can navigate away. */
  onDeleted?: () => void
  /**
   * The block the page is focused on, if any. What the menu copies follows
   * the view: focused in, **Copy markdown** takes that block and everything
   * beneath it — what is on screen — rather than the whole note behind it.
   */
  focusBlockId?: string | null
}

/**
 * **The note's menu, as entries** (`MenuEntry`, one list for every surface):
 * Copy markdown, Copy ID, Share…, Rename, then Print, then Delete. The
 * sidebar's ⋯ on a note row draws it (`NoteActionsMenu`), the open note's
 * header draws it with its own extras around it, and the Views page draws
 * it on a right-click of a note's row (`results-editor.tsx`) — so a note has
 * one menu wherever it is met.
 *
 * A hook that returns a builder rather than the entries: the surfaces that
 * list many notes (the Views page) build a list per row at the moment the
 * menu opens, so what varies per note is read from the store then, not
 * subscribed to per row. Nothing here touches the router, so a surface
 * outside one (a story) can draw the menu too; where deleting should lead
 * somewhere, the caller says so (`onDeleted`).
 *
 * A note someone shared with the user (docs/sharing.md): its rows are the
 * owner's, so the verbs the owner granted decide what the menu offers.
 * Sharing is the owner's alone: an own note, signed in, the feature on for
 * this account (src/data/feature-flags.ts).
 */
export function useNoteMenuEntries() {
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const jotaiStore = useStore()
  const renameNote = useRenameNote()
  // Delete asks first (`delete-note-dialog.tsx`); the menu only opens it.
  const requestDelete = useSetAtom(deleteNoteDialogAtom)
  const sharingEnabled = useFeature("sharing")
  const openShare = useSetAtom(shareDialogAtom)

  return React.useCallback(
    (noteId: string, options: { focusBlockId?: string | null; onDeleted?: () => void } = {}) => {
      const shareId = jotaiStore.get(sharedOriginAtom).get(noteId)
      const share =
        shareId === undefined
          ? undefined
          : jotaiStore.get(receivedSharesAtom).find((entry) => entry.id === shareId)
      const verbs = share ? sharePermissions(share) : null
      const canRename = !isSignedOut && (verbs === null || verbs.write)
      const canDelete = !isSignedOut && (verbs === null || verbs.delete)
      const canShare = !isSignedOut && verbs === null && sharingEnabled

      // Copy what the view holds, not what the note holds: focused on a
      // block, that block and everything beneath it. A focused block the
      // graph has since lost falls back to the note, which is what the page
      // itself falls back to.
      const copyMarkdown = () => {
        const graph = jotaiStore.get(graphSnapshotAtom)
        const focused = options.focusBlockId ? blockRollup(options.focusBlockId, graph) : null
        copyAsMarkdown(focused ?? rollup(noteId, graph) ?? "")
      }

      // Renaming sets the note's title (docs/graph-storage.md). The id and
      // the URL are untouched, so there is nothing to navigate to afterwards
      // and no name to reject: any text is a valid title.
      const rename = () => {
        const current = jotaiStore.get(notesAtom).get(noteId)?.title ?? ""
        const raw = window.prompt("Rename note", current)
        if (raw == null) return
        renameNote({ noteId, newTitle: raw })
      }

      const remove = () => requestDelete({ noteId, onDeleted: options.onDeleted })

      return [
        { kind: "item", label: "Copy markdown", icon: <CopyIcon16 />, onSelect: copyMarkdown },
        { kind: "item", label: "Copy ID", icon: <CopyIcon16 />, onSelect: () => copy(noteId) },
        {
          kind: "item",
          label: "Share…",
          icon: <ShareIcon16 />,
          disabled: !canShare,
          onSelect: () => openShare(noteId),
        },
        {
          kind: "item",
          label: "Rename",
          icon: <EditIcon16 />,
          disabled: !canRename,
          onSelect: rename,
        },
        { kind: "separator" },
        { kind: "item", label: "Print", icon: <PrinterIcon16 />, onSelect: () => window.print() },
        { kind: "separator" },
        {
          kind: "item",
          label: "Delete",
          icon: <TrashIcon16 />,
          danger: true,
          disabled: !canDelete,
          onSelect: remove,
        },
      ] satisfies MenuEntry[]
    },
    [jotaiStore, isSignedOut, sharingEnabled, renameNote, requestDelete, openShare],
  )
}

/**
 * The one note-actions menu, used both by the open note's header and by each
 * sidebar row — so the actions and styling stay identical. Its entries are
 * `useNoteMenuEntries`'; the header's extras (width, the developer toggles)
 * sit around them, and the sidebar's moves before them.
 */
export function NoteActionsMenu({
  noteId,
  className,
  align = "start",
  editor,
  reorder,
}: {
  noteId: string
  className?: string
  align?: "start" | "end"
  editor?: EditorActions
  reorder?: ReorderActions
}) {
  const entriesFor = useNoteMenuEntries()
  const navigate = useNavigate()
  const location = useLocation()
  // The header menu passes onDeleted (it's always the open note); the
  // sidebar menu falls back to the path check so deleting the note you're
  // viewing from the list also takes you home. Compare the decoded path
  // segment, not the raw pathname: a note id with a space or other special
  // character is percent-encoded in the URL, so a raw `=== /views/${noteId}`
  // check would miss it and skip the redirect.
  const openNoteId = location.pathname.startsWith("/views/")
    ? decodeURIComponent(location.pathname.slice("/views/".length))
    : ""
  const onDeleted =
    editor?.onDeleted ??
    (openNoteId === noteId
      ? () => navigate({ to: "/", search: { query: undefined }, replace: true })
      : undefined)
  // Developer mode (`src/hooks/is-developer.ts`): the debug toggles live at
  // the bottom of the open note's menu, for the developer's account only.
  const isDeveloper = useIsDeveloper()
  const [debug, setDebug] = useAtom(developerDebugPreferenceAtom)
  // Width is a prop on the note node — the owner's — so a shared note has
  // none.
  const share = useNoteShare(noteId)

  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton
            aria-label="Note actions"
            size="small"
            disableTooltip
            className={cx("shrink-0", className)}
          >
            <MoreIcon16 />
          </IconButton>
        }
      />
      <DropdownMenu.Content align={align}>
        {editor?.showWidth && editor.onWidth && share === null ? (
          <>
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Width</DropdownMenu.GroupLabel>
              <DropdownMenu.Item
                icon={<WidthFixedIcon16 />}
                selected={editor.width === "fixed"}
                onClick={() => editor.onWidth?.("fixed")}
              >
                Fixed
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<WidthFullIcon16 />}
                selected={editor.width === "full"}
                onClick={() => editor.onWidth?.("full")}
              >
                Full
              </DropdownMenu.Item>
            </DropdownMenu.Group>
            <DropdownMenu.Separator />
          </>
        ) : null}
        <MenuItems
          entries={[
            ...(reorder ? reorderEntries(reorder) : []),
            ...entriesFor(noteId, { focusBlockId: editor?.focusBlockId, onDeleted }),
          ]}
        />
        {editor && isDeveloper ? (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Group>
              <DropdownMenu.GroupLabel>Developer</DropdownMenu.GroupLabel>
              <DropdownMenu.Item
                selected={debug.blockIds === true}
                closeOnClick={false}
                onClick={() => setDebug({ ...debug, blockIds: !debug.blockIds })}
              >
                Show block ids
              </DropdownMenu.Item>
              <DropdownMenu.Item
                selected={debug.blockMetadata === true}
                closeOnClick={false}
                onClick={() => setDebug({ ...debug, blockMetadata: !debug.blockMetadata })}
              >
                Show block metadata
              </DropdownMenu.Item>
            </DropdownMenu.Group>
          </>
        ) : null}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
