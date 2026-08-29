import { useAtomValue } from "jotai"
import React from "react"
import { useDayActivity } from "../data/history"
import type { ChangedNote } from "../data/history-parse"
import { isDatabaseModeAtom } from "../global-state"
import { BlockNoteEditor } from "./block-editor/block-note-editor"
import { LoadingIcon16 } from "./icons"
import { NoteLink } from "./note-link"

/** onChange is never called in read-only mode; provided to satisfy the prop. */
const noop = () => {}

/**
 * Read-only "what was written that day" view for a past calendar date: a
 * roll-up of every note touched that day, reconstructed from git history via
 * GitHub. Rendered instead of the editable daily note when the date is not
 * today.
 */
export function DayActivity({ date }: { date: string }) {
  const isDatabaseMode = useAtomValue(isDatabaseModeAtom)
  const state = useDayActivity(date)

  // Past-day reconstruction works off git commit history, which database mode
  // doesn't have (D1 stores current state only — see docs/graph-storage.md).
  if (isDatabaseMode) {
    return <Message>History for past days isn’t available in database mode.</Message>
  }

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 text-text-secondary">
        <LoadingIcon16 />
        Loading what was written…
      </div>
    )
  }

  if (state.status === "offline") {
    return <Message>History for past days isn’t available offline.</Message>
  }

  if (state.status === "error") {
    return <Message>Couldn’t load history: {state.message}</Message>
  }

  if (state.status === "empty") {
    return <Message>Nothing was written on this day.</Message>
  }

  // The daily note for this date reads like a journal, so surface it first;
  // everything else follows in the order GitHub returned.
  const sortedNotes = [...state.data.notes].sort((a, b) => {
    if (a.noteId === date) return -1
    if (b.noteId === date) return 1
    return 0
  })

  return (
    <div className="flex flex-col gap-8">
      {sortedNotes.map((note) => (
        <ChangedNoteSection key={note.noteId} note={note} />
      ))}
    </div>
  )
}

function ChangedNoteSection({ note }: { note: ChangedNote }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-content font-bold">
        <NoteLink id={note.noteId} />
      </h2>
      {note.addedText ? (
        <BlockNoteEditor value={note.addedText} onChange={noop} readOnly />
      ) : (
        <p className="italic text-text-secondary">{statusLabel(note.status)}</p>
      )}
    </section>
  )
}

function Message({ children }: { children: React.ReactNode }) {
  return <p className="text-text-secondary">{children}</p>
}

function statusLabel(status: string): string {
  switch (status) {
    case "removed":
      return "Removed this day"
    case "renamed":
      return "Renamed this day"
    default:
      return "Changed this day"
  }
}
