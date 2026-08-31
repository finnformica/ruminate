import { useLocation, useNavigate } from "@tanstack/react-router"
import copy from "copy-to-clipboard"
import { useAtomValue } from "jotai"
import { isSignedOutAtom } from "../global-state"
import { copyAsMarkdown } from "../utils/copy-markdown"
import { useDeleteNote, useRenameNote, useSaveNote } from "../hooks/note"
import type { Width } from "../schema"
import { cx } from "../utils/cx"
import { parseFrontmatter, updateFrontmatterValue } from "../utils/frontmatter"
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
  onShare?: () => void
  canShare?: boolean
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
  content,
  pinned = false,
  className,
  align = "start",
  onContentChange,
  editor,
}: {
  noteId: string
  /** Current note content (the live editor value when open, else the saved file). */
  content: string
  pinned?: boolean
  className?: string
  align?: "start" | "end"
  /**
   * When the note is open in the editor, route frontmatter changes (pin) back
   * through it so the open editor stays in sync; otherwise they save directly.
   */
  onContentChange?: (content: string) => void
  editor?: EditorActions
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const saveNote = useSaveNote()
  const renameNote = useRenameNote()
  const deleteNote = useDeleteNote()

  // Compare the decoded path segment, not the raw pathname: a note id with a
  // space or other special character is percent-encoded in the URL, so a raw
  // `=== /notes/${noteId}` check would miss it and skip the post-delete redirect.
  const openNoteId = location.pathname.startsWith("/notes/")
    ? decodeURIComponent(location.pathname.slice("/notes/".length))
    : ""
  const isViewing = openNoteId === noteId

  const applyContent = (next: string) => {
    if (onContentChange) onContentChange(next)
    else saveNote({ id: noteId, content: next })
  }

  const togglePin = () => {
    applyContent(updateFrontmatterValue({ content, properties: { pinned: pinned ? null : true } }))
  }

  // Renaming sets the note's title (docs/page-identity-design.md). The id and
  // the URL are untouched, so there is nothing to navigate to afterwards and
  // no name to reject: any text is a valid title.
  const rename = () => {
    const { frontmatter } = parseFrontmatter(content)
    const current = typeof frontmatter.title === "string" ? frontmatter.title : ""
    const raw = window.prompt("Rename note", current)
    if (raw == null) return
    renameNote({ noteId, newTitle: raw, content })
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
        {editor?.showWidth && editor.onWidth ? (
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
        <DropdownMenu.Item
          icon={pinned ? <PinFillIcon16 className="text-text-pinned" /> : <PinIcon16 />}
          onClick={togglePin}
        >
          {pinned ? "Unpin" : "Pin"}
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={<CopyIcon16 />} onClick={() => copyAsMarkdown(content)}>
          Copy markdown
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={<CopyIcon16 />} onClick={() => copy(noteId)}>
          Copy ID
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={<EditIcon16 />} disabled={isSignedOut} onClick={rename}>
          Rename
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        {editor?.onShare ? (
          <DropdownMenu.Item
            icon={<ShareIcon16 />}
            disabled={!editor.canShare}
            onClick={editor.onShare}
          >
            Share
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item icon={<PrinterIcon16 />} onClick={() => window.print()}>
          Print
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          icon={<TrashIcon16 />}
          disabled={isSignedOut}
          onClick={remove}
        >
          Delete
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
