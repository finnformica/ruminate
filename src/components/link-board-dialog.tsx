import { atom, useAtom, useAtomValue, useStore } from "jotai"
import React from "react"
import { boardRow, linkBoardOps } from "../data/boards"
import { childIdsOf } from "../data/graph"
import { applyOps } from "../data/ops"
import { useApplyOps } from "../data/store"
import { graphSnapshotAtom, notesAtom } from "../global-state"
import type { Note, NoteId } from "../schema"
import { cx } from "../utils/cx"
import type { BoardInsertion } from "./block-editor/block-editor"
import { NoteFavicon } from "./note-favicon"
import { Dialog } from "./ui/dialog"
import { listRow } from "./ui/list"
import { SearchField } from "./ui/search-field"

/** What **Link board** asks: a board of the reader's own, put at a row of
 * the note `noteId` (docs/boards.md, "A board in a note"). */
export interface LinkBoardRequest {
  noteId: NoteId
  into: BoardInsertion
}

/** The Link board dialog's request, or null while it is closed. Set from
 * the slash menu's **Link board**; the dialog is mounted once, in the app
 * root. */
export const linkBoardDialogAtom = atom<LinkBoardRequest | null>(null)

/**
 * **Link board**: a picker over the reader's own boards — a search field
 * and the boards that match it, by name — and the one `link` that puts the
 * picked board where the row is (`linkBoardOps`). Enter or a click picks
 * the highlighted row; the arrows move it. Never offered: the note being
 * edited (a board linked into its own outline would be a loop for nothing)
 * and a board already under that parent (one row per parent). Signed out
 * it works on the sample graph, as the editor does.
 */
export function LinkBoardDialog() {
  const [request, setRequest] = useAtom(linkBoardDialogAtom)
  const notes = useAtomValue(notesAtom)
  const snapshot = useAtomValue(graphSnapshotAtom)
  const store = useStore()
  const apply = useApplyOps()
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const open = request !== null
  React.useEffect(() => {
    if (open) {
      setQuery("")
      setActive(0)
    }
  }, [open])
  const close = () => setRequest(null)

  const boards = React.useMemo(() => {
    if (!request) return []
    const under = new Set(childIdsOf(snapshot, request.into.parentId))
    const q = query.trim().toLowerCase()
    return [...notes.values()]
      .filter(
        (note) =>
          note.type === "board" &&
          note.id !== request.noteId &&
          !under.has(note.id) &&
          (q === "" || note.displayName.toLowerCase().includes(q)),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [request, notes, snapshot, query])
  const highlighted = Math.min(active, Math.max(0, boards.length - 1))

  const pick = (board: Note) => {
    if (!request) return
    const { parentId, placement, place } = request.into
    const current = store.get(graphSnapshotAtom)
    const ops = linkBoardOps(current, parentId, board.id, placement)
    close()
    if (ops.length === 0) return
    const now = Date.now()
    apply(ops)
    const row = boardRow(applyOps(current, ops, now), board.id)
    if (row) place(row)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {open ? (
        <Dialog.Content title="Link board">
          <div className="flex flex-col gap-2">
            <SearchField
              aria-label="Find a board"
              placeholder="Find a board…"
              value={query}
              autoComplete="off"
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setActive(boards.length === 0 ? 0 : (highlighted + 1) % boards.length)
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setActive(
                    boards.length === 0 ? 0 : (highlighted - 1 + boards.length) % boards.length,
                  )
                } else if (event.key === "Enter") {
                  event.preventDefault()
                  const board = boards[highlighted]
                  if (board) pick(board)
                }
              }}
            />
            <div
              role="listbox"
              aria-label="Boards"
              data-testid="link-board-list"
              className="max-h-[45vh] overflow-auto"
            >
              {boards.length === 0 ? (
                <div className="px-3 py-2 text-sm text-text-secondary">
                  {query.trim() === "" ? "No boards to link" : "No boards match"}
                </div>
              ) : (
                boards.map((board, index) => (
                  // The keys live on the search field; a row needs the pointer.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                  <div
                    key={board.id}
                    role="option"
                    aria-selected={index === highlighted}
                    tabIndex={-1}
                    data-board-id={board.id}
                    className={cx(listRow({ active: index === highlighted }))}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(board)}
                  >
                    <NoteFavicon note={board} />
                    <span className="grow truncate">{board.displayName || "Untitled"}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </Dialog.Content>
      ) : null}
    </Dialog>
  )
}
