import { useNavigate } from "@tanstack/react-router"
import { atom, useAtom, useStore } from "jotai"
import React from "react"
import { boardRow, linkBoardOps, newBoardOps } from "../data/boards"
import { applyOps } from "../data/ops"
import { useApplyOps } from "../data/store"
import { graphSnapshotAtom } from "../global-state"
import { useMakeBoard } from "../hooks/board"
import { generateNoteId } from "../utils/note-id"
import type { BoardInsertion } from "./block-editor/block-editor"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { TextInput } from "./ui/text-input"

/**
 * What **New board** is for: a board of its own, opened on its page (`{}`),
 * or — `/board` in a note (docs/boards.md, "A board in a note") — a board
 * put at a row of the note being edited, where the card then stands.
 */
export interface NewBoardRequest {
  into?: BoardInsertion
}

/** The New board dialog's request, or null while it is closed. Set from
 * the header's **New** menu and its shortcut (`{}`), and from the slash
 * menu's **Board** (with where the board goes); the dialog itself is
 * mounted once, in the app root. */
export const newBoardDialogAtom = atom<NewBoardRequest | null>(null)

/**
 * **New board** (docs/boards.md): a name, then a board. A board is a note
 * whose root is of type `board`, so making one is making that node with
 * the default features written onto its page (`newBoardOps`) — and, asked
 * from the header, listing it and opening it on its board page rather than
 * its outline (`useMakeBoard`). Asked from a note (`into`), the board is
 * made and linked where the row is in ONE batch (`linkBoardOps`), with no
 * view row: a board made inside a note is not in the Views list — the note
 * is its place, and **Add to Views** lists it from there (docs/metadata.md,
 * "Views") — and nothing navigates: the card appears in place, selected.
 * The name is the note's title and can be blank, as a note's can.
 */
export function NewBoardDialog() {
  const [request, setRequest] = useAtom(newBoardDialogAtom)
  const [name, setName] = React.useState("")
  const makeBoard = useMakeBoard()
  const store = useStore()
  const apply = useApplyOps()
  const navigate = useNavigate()
  const open = request !== null
  React.useEffect(() => {
    if (open) setName("")
  }, [open])
  const close = () => setRequest(null)
  const submit = () => {
    const id = generateNoteId()
    const into = request?.into
    close()
    if (!into) {
      makeBoard(id, { title: name })
      void navigate({ to: "/boards/$", params: { _splat: id } })
      return
    }
    const snapshot = store.get(graphSnapshotAtom)
    const made = newBoardOps(snapshot, id, name)
    const now = Date.now()
    const ops = [
      ...made,
      ...linkBoardOps(applyOps(snapshot, made, now), into.parentId, id, into.placement),
    ]
    apply(ops)
    const row = boardRow(applyOps(snapshot, ops, now), id)
    if (row) into.place(row)
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {open ? (
        <Dialog.Content title="New board">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <div className="flex flex-col gap-2">
              <label htmlFor="new-board-name" className="text-sm leading-4 text-text-secondary">
                Name
              </label>
              <TextInput
                id="new-board-name"
                value={name}
                placeholder="Home inspiration"
                autoComplete="off"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="primary">
                Create
              </Button>
              <Button type="button" onClick={close}>
                Cancel
              </Button>
            </div>
          </form>
        </Dialog.Content>
      ) : null}
    </Dialog>
  )
}
