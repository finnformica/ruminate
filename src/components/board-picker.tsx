import { atom, useAtom, useAtomValue, useStore } from "jotai"
import React from "react"
import { boardRow, linkBoardOps, newBoardOps } from "../data/boards"
import { childIdsOf } from "../data/graph"
import { applyOps, type Op } from "../data/ops"
import { sharedOriginAtom } from "../data/shared-mode"
import { useApplyOps } from "../data/store"
import { byUpdatedAt, graphSnapshotAtom, notesAtom } from "../global-state"
import { useCoarsePointer } from "../hooks/coarse-pointer"
import type { Note, NoteId } from "../schema"
import { cx } from "../utils/cx"
import { generateNoteId } from "../utils/note-id"
import type { BoardInsertion } from "./block-editor/block-editor"
import { PlusIcon16 } from "./icons"
import { NoteFavicon } from "./note-favicon"
import { listRow } from "./ui/list"
import { Popover } from "./ui/popover"
import { SearchField } from "./ui/search-field"
import { Sheet } from "./ui/sheet"

/** What the picker is for: a board at a row of the note `noteId`
 * (docs/boards.md, "A board in a note"), hung off the row (`anchor`). */
export interface BoardPickerRequest extends BoardInsertion {
  noteId: NoteId
  /** The row's line, for the popover to hang off; null on a phone, where
   * the picker is a sheet. */
  anchor: Element | null
}

/** The board picker's request, or null while it is closed. Set from the
 * slash menu's **Board**; the picker is mounted once, in the app root. */
export const boardPickerAtom = atom<BoardPickerRequest | null>(null)

/** How many boards the picker lists before anything is typed. */
export const RECENT_BOARDS = 8

/** What the picker lists, in order: the reader's own boards, most recently
 * updated first (the Views list's "Recently updated", `byUpdatedAt`),
 * narrowed by `query` — a substring of the name, whatever its case — and
 * without `noteId` (the note being edited: a board linked into its own
 * outline would be a loop for nothing) or any board already under
 * `parentId` (one row per parent). With nothing typed, the first
 * `RECENT_BOARDS`; typed, every match. */
function pickableBoards(
  notes: Iterable<Note>,
  shared: ReadonlyMap<string, string>,
  under: ReadonlySet<string>,
  noteId: NoteId,
  query: string,
): Note[] {
  const q = query.trim().toLowerCase()
  const boards = [...notes]
    .filter(
      (note) =>
        note.type === "board" &&
        note.id !== noteId &&
        !shared.has(note.id) &&
        !under.has(note.id) &&
        (q === "" || note.displayName.toLowerCase().includes(q)),
    )
    .sort(byUpdatedAt)
  return q === "" ? boards.slice(0, RECENT_BOARDS) : boards
}

/**
 * The board picker: what the slash menu's **Board** opens at the row
 * (docs/boards.md, "A board in a note"). A search box and, beneath it,
 * the reader's own boards — the most recently updated first, narrowed by
 * what is typed — and, last and always, **Create new board**: with
 * nothing typed it makes an untitled board (a blank name is allowed, as
 * **New board** allows), and with a name typed it reads Create “name”.
 * <kbd>Enter</kbd> picks the highlighted row, the arrows move it, and
 * <kbd>Esc</kbd> or a press outside closes the picker with nothing done.
 * A pick writes one batch — the one `link` for a board that exists
 * (`linkBoardOps`), or the board with its default features and the link
 * for a new one (`newBoardOps` + `linkBoardOps`), with no view row and no
 * navigation: the card appears in place, selected — and hands the editor
 * the row to put in the doc (`place`).
 *
 * On a desktop it is a popover hung off the row (`Popover`); on a phone,
 * where a popover under a finger has nowhere to be, it is a sheet from
 * the foot of the screen (`Sheet`, docs/mobile.md), as the Features editor
 * is. The same list either way. Signed out it works on the sample graph,
 * as the editor does.
 */
export function BoardPicker() {
  const [request, setRequest] = useAtom(boardPickerAtom)
  const coarse = useCoarsePointer()
  const open = request !== null
  const close = () => setRequest(null)
  if (coarse) {
    return (
      <Sheet open={open} onOpenChange={(next) => (next ? undefined : close())}>
        {request ? (
          <Sheet.Content title="Board" titleVisible handle size="fit">
            <BoardPickerList request={request} onDone={close} sheet />
          </Sheet.Content>
        ) : null}
      </Sheet>
    )
  }
  return (
    <Popover open={open} onOpenChange={(next) => (next ? undefined : close())} modal={false}>
      {request ? (
        <Popover.Content anchor={request.anchor} width={288} initialFocus={true}>
          <BoardPickerList request={request} onDone={close} />
        </Popover.Content>
      ) : null}
    </Popover>
  )
}

/** The picker's box and rows, the same in the popover and the sheet. */
function BoardPickerList({
  request,
  onDone,
  sheet = false,
}: {
  request: BoardPickerRequest
  /** Called once a pick is written or the picker is given up. */
  onDone: () => void
  /** Drawn in a sheet: the rows take a finger's height. */
  sheet?: boolean
}) {
  const notes = useAtomValue(notesAtom)
  const shared = useAtomValue(sharedOriginAtom)
  const snapshot = useAtomValue(graphSnapshotAtom)
  const store = useStore()
  const apply = useApplyOps()
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)

  const boards = React.useMemo(
    () =>
      pickableBoards(
        notes.values(),
        shared,
        new Set(childIdsOf(snapshot, request.parentId)),
        request.noteId,
        query,
      ),
    [notes, shared, snapshot, request.parentId, request.noteId, query],
  )
  // The rows: the boards, then the one that creates.
  const count = boards.length + 1
  const highlighted = Math.min(active, count - 1)
  const name = query.trim()

  React.useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    row?.scrollIntoView?.({ block: "nearest" })
  }, [highlighted, boards])

  /** Write the batch that puts `boardId` where the row is — making the
   * board first when `make` says so — and hand the editor its row. */
  const write = (boardId: string, make: Op[]) => {
    const current = store.get(graphSnapshotAtom)
    const now = Date.now()
    const ops = [
      ...make,
      ...linkBoardOps(applyOps(current, make, now), request.parentId, boardId, request.placement),
    ]
    onDone()
    if (ops.length === make.length && make.length === 0) return
    apply(ops)
    const row = boardRow(applyOps(current, ops, now), boardId)
    if (row) request.place(row)
  }
  const pickBoard = (board: Note) => write(board.id, [])
  const create = () => {
    const id = generateNoteId()
    write(id, newBoardOps(store.get(graphSnapshotAtom), id, name))
  }
  const pick = (index: number) => {
    const board = boards[index]
    if (board) pickBoard(board)
    else create()
  }

  const row = (index: number) =>
    cx(listRow({ active: index === highlighted }), sheet && "h-11 coarse:h-11")

  return (
    <div className={cx("flex flex-col gap-1", sheet ? "px-2 pb-2" : "p-1")}>
      <SearchField
        aria-label="Find or name a board"
        placeholder="Find or name a board…"
        value={query}
        autoComplete="off"
        // The keyboard lands here as the picker opens (the popover's
        // `initialFocus`; a sheet's own focus); the rows answer to it.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setActive((highlighted + 1) % count)
          } else if (event.key === "ArrowUp") {
            event.preventDefault()
            setActive((highlighted - 1 + count) % count)
          } else if (event.key === "Enter") {
            event.preventDefault()
            pick(highlighted)
          } else if (event.key === "Escape") {
            event.preventDefault()
            onDone()
          }
        }}
      />
      <div
        ref={listRef}
        role="listbox"
        aria-label="Boards"
        data-testid="board-picker-list"
        // Reachable by pointer and screen readers, never by Tab: the keys
        // live on the search field.
        tabIndex={-1}
        className={cx("overflow-auto", sheet ? "max-h-[60svh]" : "max-h-[45svh]")}
        // A press on a row must not blur the box: the keys stay with it.
        onMouseDown={(event) => event.preventDefault()}
      >
        {boards.map((board, index) => (
          // The keys live on the search field; a row needs the pointer.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <div
            key={board.id}
            role="option"
            aria-selected={index === highlighted}
            tabIndex={-1}
            data-board-id={board.id}
            className={row(index)}
            onMouseEnter={() => setActive(index)}
            onClick={() => pickBoard(board)}
          >
            <NoteFavicon note={board} />
            <span className="grow truncate">{board.displayName || "Untitled"}</span>
          </div>
        ))}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
        <div
          role="option"
          aria-selected={highlighted === boards.length}
          tabIndex={-1}
          data-testid="board-picker-create"
          className={row(boards.length)}
          onMouseEnter={() => setActive(boards.length)}
          onClick={create}
        >
          <span className="grid size-icon shrink-0 place-items-center text-text-secondary">
            <PlusIcon16 />
          </span>
          <span className="grow truncate">
            {name === "" ? "Create new board" : `Create “${name}”`}
          </span>
        </div>
      </div>
    </div>
  )
}
