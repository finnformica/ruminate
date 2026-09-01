import { Link } from "@tanstack/react-router"
import { useMemo } from "react"
import { useNoteById } from "../hooks/note"
import { Note } from "../schema"
import { cx } from "../utils/cx"
import { formatDate } from "../utils/date"
import { NoteHoverCard } from "./note-hover-card"

type DateLinkProps = {
  date: string
  text?: string
  className?: string
}

export function DateLink({ date, text, className }: DateLinkProps) {
  const existingNote = useNoteById(date)

  // Create a minimal note object if no note exists
  const note: Note = useMemo(() => {
    if (existingNote) return existingNote
    return {
      id: date,
      content: "",
      type: "daily",
      displayName: formatDate(date),
      frontmatter: {},
      title: "",
      url: null,
      alias: null,
      pinned: false,
      updatedAt: null,
      dates: [],
      tags: [],
      tasks: [],
    }
  }, [existingNote, date])

  const linkText = text || formatDate(date)

  const link = (
    <Link
      className={cx(!text && "text-text-secondary", className)}
      to="/notes/$"
      params={{ _splat: date }}
      search={{
        query: undefined,
      }}
    />
  )

  return (
    <NoteHoverCard render={link} note={note} align="start">
      {linkText}
    </NoteHoverCard>
  )
}
