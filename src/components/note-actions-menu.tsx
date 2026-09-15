import { useLocation, useNavigate } from "@tanstack/react-router"
import copy from "copy-to-clipboard"
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai"
import { graphSnapshotAtom, isSignedOutAtom } from "../global-state"
import { useFeature } from "../data/features"
import { rollup } from "../data/graph"
import { copyAsMarkdown } from "../utils/copy-markdown"
import { developerDebugPreferenceAtom, useIsDeveloper } from "../hooks/is-developer"
import { useDeleteNote, useNoteById, useRenameNote, useSetNoteProps } from "../hooks/note"
import { useNoteShare } from "../hooks/share"
import { shareDialogAtom } from "./share-note-dialog"
import type { Width } from "../schema"
import { cx } from "../utils/cx"
import { DropdownMenu } from "./dropdown-menu"
import { IconButton } from "./icon-button"
import {
  CopyIcon16,
  EditIcon16,
  MoreIcon16,
  PinFillIcon16,
  PinIcon16,
  PrinterIcon16,
  ShareIcon16,
  TrashIcon16,
  WidthFixedIcon16,
  WidthFullIcon16,
} from "./icons"

/** Editor-context actions, shown only when the note is open in the editor. */
interface EditorActions {
  showWidth?: boolean
  width?: Width
  onWidth?: (width: Width) => void
  /** Called after the open note is deleted, so the page can navigate away. */
  onDeleted?: () => void
}

/**
 * The one note-actions menu, used both by the open note's header and by each
 * sidebar row — so the actions and styling stay identical. It works off a
 * note's id + content directly (not the open editor), and the caller opts into
 * the editor-only extras (discard, width, share) by passing `editor`.
 */
export function NoteActionsMenu({
  noteId,
  pinned = false,
  className,
  align = "start",
  editor,
}: {
  noteId: string
  pinned?: boolean
  className?: string
  align?: "start" | "end"
  editor?: EditorActions
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const setNoteProps = useSetNoteProps()
  const note = useNoteById(noteId)
  const jotaiStore = useStore()
  const renameNote = useRenameNote()
  const deleteNote = useDeleteNote()
  // Developer mode (`src/hooks/is-developer.ts`): the debug toggles live at
  // the bottom of the open note's menu, for the developer's account only.
  const isDeveloper = useIsDeveloper()
  const [debug, setDebug] = useAtom(developerDebugPreferenceAtom)
  // A note someone shared with the user (docs/sharing.md): its rows are the
  // owner's and the share is read-only, so nothing here may change it.
  // Pinning and width are props on the note node — the owner's node, and
  // the owner's pin — so a shared note has neither.
  const share = useNoteShare(noteId)
  const canRename = !isSignedOut && share === null
  const canDelete = !isSignedOut && share === null
  // Sharing is the owner's: an own note, signed in (docs/sharing.md), and
  // the feature on for this account (src/data/feature-flags.ts).
  const sharingEnabled = useFeature("sharing")
  const canShare = !isSignedOut && share === null && sharingEnabled
  const openShare = useSetAtom(shareDialogAtom)

  // Compare the decoded path segment, not the raw pathname: a note id with a
  // space or other special character is percent-encoded in the URL, so a raw
  // `=== /notes/${noteId}` check would miss it and skip the post-delete redirect.
  const openNoteId = location.pathname.startsWith("/notes/")
    ? decodeURIComponent(location.pathname.slice("/notes/".length))
    : ""
  const isViewing = openNoteId === noteId

  const togglePin = () => setNoteProps(noteId, { pinned: pinned ? null : true })

  // Renaming sets the note's title (docs/graph-storage.md). The id and
  // the URL are untouched, so there is nothing to navigate to afterwards and
  // no name to reject: any text is a valid title.
  const rename = () => {
    const current = note?.title ?? ""
    const raw = window.prompt("Rename note", current)
    if (raw == null) return
    renameNote({ noteId, newTitle: raw })
  }

  const remove = () => {
    deleteNote(noteId)
    // The header menu passes onDeleted (it's always the open note); the sidebar
    // menu falls back to the path check so deleting the note you're viewing from
    // the list also takes you home.
    if (editor?.onDeleted) editor.onDeleted()
    else if (isViewing) {
      navigate({ to: "/", search: { query: undefined }, replace: true })
    }
  }

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
        {share === null ? (
          <DropdownMenu.Item
            icon={pinned ? <PinFillIcon16 className="text-text-pinned" /> : <PinIcon16 />}
            onClick={togglePin}
          >
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item
          icon={<CopyIcon16 />}
          onClick={() => copyAsMarkdown(rollup(noteId, jotaiStore.get(graphSnapshotAtom)) ?? "")}
        >
          Copy markdown
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={<CopyIcon16 />} onClick={() => copy(noteId)}>
          Copy ID
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={<ShareIcon16 />}
          disabled={!canShare}
          onClick={() => openShare(noteId)}
        >
          Share…
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={<EditIcon16 />} disabled={!canRename} onClick={rename}>
          Rename
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={<PrinterIcon16 />} onClick={() => window.print()}>
          Print
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          icon={<TrashIcon16 />}
          disabled={!canDelete}
          onClick={remove}
        >
          Delete
        </DropdownMenu.Item>
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
