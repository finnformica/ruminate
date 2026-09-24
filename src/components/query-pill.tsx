import { useAtomValue } from "jotai"
import React from "react"
import { blockIndexAtom } from "../global-state"
import { useNoteById } from "../hooks/note"
import { parseQualifierToken } from "../utils/search"
import { XIcon12 } from "./icons"
import { NoteFavicon } from "./note-favicon"
import { PillButton } from "./ui/pill-button"

/**
 * One qualifier of the query as a removable pill beneath the query box —
 * the box lifts every finished `key:value` out of its line and shows it
 * this way (query-box.tsx), on the Views page and in the ⌘K palette alike.
 * An `in:` scope is named for a human (the note, or note › block) even
 * though the token carries an id; any other qualifier reads as typed.
 * Clicking a pill takes the whole token out of the query.
 */
export function QueryPill({ token, onRemove }: { token: string; onRemove: () => void }) {
  const filter = parseQualifierToken(token)
  if (filter?.key === "in") {
    return (
      <>
        {filter.values.map((value) => (
          <ScopePill key={value} value={value} exclude={filter.exclude} onRemove={onRemove} />
        ))}
      </>
    )
  }
  const [key, ...rest] = token.split(":")
  return (
    <PillButton data-filter={token} variant="primary" onClick={onRemove}>
      <span className="opacity-70">{key}:</span>
      <span className="max-w-64 truncate">{rest.join(":").replace(/^"|"$/g, "")}</span>
      <XIcon12 className="-mr-0.5" />
    </PillButton>
  )
}

/** An `in:` scope: the note (or note › block) the results are limited to. */
function ScopePill({
  value,
  exclude,
  onRemove,
}: {
  /** The `in:` value: a note id, a block id, or a note name. */
  value: string
  exclude: boolean
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
