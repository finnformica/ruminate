import { useAtomValue } from "jotai"
import React from "react"
import { blockIndexAtom } from "../global-state"
import { useNoteById } from "../hooks/note"
import { NoteFavicon } from "./note-favicon"
import { PillButton } from "./pill-button"
import { XIcon12 } from "./icons"

/**
 * An `in:` scope as a removable pill — the note (or note › block) the results
 * are limited to, named for a human even though the query carries an id.
 * Shared by the ⌘K palette (which scopes itself to the open note) and the
 * results page (which shows every `in:` in the query this way, next to the
 * tag pills).
 */
export function ScopePill({
  value,
  exclude = false,
  onRemove,
}: {
  /** The `in:` value: a note id, a block id, or a note name. */
  value: string
  exclude?: boolean
  onRemove: () => void
}) {
  const index = useAtomValue(blockIndexAtom)
  const noteById = useNoteById(value)
  const block = noteById ? undefined : index.getBlock(value)
  const note = noteById ?? block?.note

  return (
    <PillButton data-scope={value} variant="primary" onClick={onRemove}>
      {note ? <NoteFavicon note={note} className="-ml-0.5 size-4" /> : null}
      {exclude ? <span className="italic">not in</span> : <span>in</span>}
      <span className="max-w-64 truncate">
        {note ? note.displayName : value}
        {block ? (
          <>
            <span className="px-1 opacity-60">›</span>
            {block.text.trim() || "…"}
          </>
        ) : null}
      </span>
      <XIcon12 className="-mr-0.5" />
    </PillButton>
  )
}
