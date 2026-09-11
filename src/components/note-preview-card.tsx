import { Link } from "@tanstack/react-router"
import copy from "copy-to-clipboard"
import { useAtomValue, useStore } from "jotai"
import React from "react"
import { rollup } from "../data/graph"
import { graphSnapshotAtom, isSignedOutAtom } from "../global-state"
import { useDeleteNote, useNoteById, useSetPageProps } from "../hooks/note"
import { NoteId } from "../schema"
import { copyAsMarkdown } from "../utils/copy-markdown"
import { cx } from "../utils/cx"
import { DropdownMenu } from "./dropdown-menu"
import { IconButton } from "./icon-button"
import { CopyIcon16, MoreIcon16, PinFillIcon16, PinIcon16, TrashIcon16 } from "./icons"
import { NotePreview } from "./note-preview"

type NoteCardProps = {
  id: NoteId
}

export const NotePreviewCard = React.memo(function NoteCard({ id }: NoteCardProps) {
  const note = useNoteById(id)
  const isSignedOut = useAtomValue(isSignedOutAtom)
  const setPageProps = useSetPageProps()
  const jotaiStore = useStore()
  const deleteNote = useDeleteNote()
  const [isDropdownOpen, setIsDropdownOpen] = React.useState(false)

  if (!note) return null

  return (
    <div className="group relative">
      <Link
        to="/notes/$"
        params={{ _splat: id }}
        search={{
          query: undefined,
        }}
        className={cx(
          "card-1 rounded-[calc(var(--border-radius-base)+6px)]! relative block w-full cursor-pointer overflow-hidden -outline-offset-1",
          "focus-visible:outline-hidden",
          "focus-visible:outline-2",
          "focus-visible:outline",
          "focus-visible:outline-border-focus",
          "[&:not(:focus-visible)]:group-hover:outline-2",
          "[&:not(:focus-visible)]:group-hover:outline",
          "[&:not(:focus-visible)]:group-hover:outline-[var(--neutral-7)]",
          "[&:not(:focus-visible)]:group-focus-within:outline-2",
          "[&:not(:focus-visible)]:group-focus-within:outline",
          "[&:not(:focus-visible)]:group-focus-within:outline-[var(--neutral-7)]",
        )}
      >
        <NotePreview note={note} className="coarse:pr-[52px]" />
      </Link>
      <div
        className={cx(
          "absolute right-1.5 top-1.5 rounded bg-bg-card opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100",
          note.pinned && "opacity-100!",
        )}
      >
        <IconButton
          aria-label={note.pinned ? "Unpin" : "Pin"}
          tooltipSide="left"
          disabled={isSignedOut}
          onClick={() => {
            if (isSignedOut) return
            setPageProps(id, { pinned: note.pinned ? null : true })
          }}
        >
          {note.pinned ? <PinFillIcon16 className="text-text-pinned" /> : <PinIcon16 />}
        </IconButton>
      </div>
      {note ? (
        <div
          className={cx(
            "absolute bottom-1.5 right-1.5 flex gap-1 rounded bg-bg-card opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100",
            isDropdownOpen && "opacity-100!",
          )}
        >
          <DropdownMenu open={isDropdownOpen} onOpenChange={setIsDropdownOpen} modal={false}>
            <DropdownMenu.Trigger
              render={
                <IconButton aria-label="Actions" disableTooltip>
                  <MoreIcon16 />
                </IconButton>
              }
            />
            <DropdownMenu.Content align="end" side="top">
              <DropdownMenu.Item
                icon={<CopyIcon16 />}
                onClick={() => copyAsMarkdown(rollup(id, jotaiStore.get(graphSnapshotAtom)) ?? "")}
              >
                Copy markdown
              </DropdownMenu.Item>
              <DropdownMenu.Item icon={<CopyIcon16 />} onClick={() => copy(id)}>
                Copy ID
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                variant="danger"
                icon={<TrashIcon16 />}
                disabled={isSignedOut}
                onClick={() => deleteNote(id)}
              >
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu>
        </div>
      ) : null}
    </div>
  )
})
