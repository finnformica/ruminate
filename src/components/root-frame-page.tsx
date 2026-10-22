import { Link } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import React from "react"
import { orderedNoteIds } from "../data/note-order"
import { ROOT_LABEL, rootFrameNotes } from "../data/root-frame"
import { graphSnapshotAtom, ownSortedNotesAtom } from "../global-state"
import type { Note } from "../schema"
import { cx } from "../utils/cx"
import { GridIcon16 } from "./icons"
import { NoteFavicon } from "./note-favicon"
import { PageLayout } from "./page-layout"
import { listRow } from "./ui/list"

/**
 * **The Root frame** (`src/data/root-frame.ts`): the base of every pane,
 * drawn as the list of every note — first the notes the corpus root links,
 * in its order, then the rest by title. Views are bookmarks and are not
 * rows here.
 *
 * Each row is a link to its note, so it opens in a new tab like any link.
 * A plain click opens the note in this pane instead (`onOpen`): a push onto
 * the pane's stack, so Back and Shift+F come back here and land on the row.
 */
export function RootFramePage({
  landing,
  leading,
  actions,
  onOpen,
  onActivate,
}: {
  /** The note to land on: the one the reader came back down from. */
  landing: string | null
  /** The first pane on screen (`PageLayout.secondary` is its opposite). */
  leading: boolean
  /** The pane's own buttons (split, close). */
  actions?: React.ReactNode
  /** Open a note in this pane. */
  onOpen: (note: Note) => void
  onActivate: () => void
}) {
  const notes = useAtomValue(ownSortedNotesAtom)
  const graph = useAtomValue(graphSnapshotAtom)
  const rows = React.useMemo(() => rootFrameNotes(notes, orderedNoteIds(graph)), [notes, graph])
  const listRef = React.useRef<HTMLUListElement>(null)

  // Back down to Root: the row left takes the keyboard.
  React.useEffect(() => {
    if (landing === null) return
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-note-id="${CSS.escape(landing)}"]`,
    )
    row?.focus()
  }, [landing])

  // ↑ and ↓ move between the rows, as in every list.
  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const links = [...(listRef.current?.querySelectorAll<HTMLElement>("a[data-note-id]") ?? [])]
    const at = links.indexOf(document.activeElement as HTMLElement)
    const next = event.key === "ArrowDown" ? at + 1 : at - 1
    if (next < 0 || next >= links.length) return
    event.preventDefault()
    links[next].focus()
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      data-testid="root-frame"
      className={cx("grid overflow-hidden", !leading && "border-l border-border-secondary")}
      onPointerDownCapture={onActivate}
    >
      <PageLayout secondary={!leading} title={ROOT_LABEL} icon={<GridIcon16 />} actions={actions}>
        <div className="p-4 @[480px]:p-5 @[640px]:p-10">
          <div className="mx-auto flex max-w-[700px] flex-col gap-1">
            {rows.length === 0 ? (
              <p className="px-3 text-text-secondary">No notes yet</p>
            ) : (
              // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
              <ul
                ref={listRef}
                aria-label={ROOT_LABEL}
                className="flex flex-col"
                onKeyDown={onKeyDown}
              >
                {rows.map((note) => (
                  <li key={note.id}>
                    <Link
                      to={note.type === "board" ? "/boards/$" : "/views/$"}
                      params={{ _splat: note.id }}
                      data-note-id={note.id}
                      className={cx(listRow(), "focus-ring text-text")}
                      onClick={(event) => {
                        if (!isPlainClick(event)) return
                        event.preventDefault()
                        onOpen(note)
                      }}
                    >
                      <span className="flex size-icon shrink-0 text-text-secondary">
                        <NoteFavicon note={note} />
                      </span>
                      <span className="truncate">{note.displayName || "Untitled"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </PageLayout>
    </div>
  )
}

/** A click that opens a link where it is: no modifier asking for a new tab. */
const isPlainClick = (event: React.MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
