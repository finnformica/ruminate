import { useNavigate } from "@tanstack/react-router"
import { atom, useAtom } from "jotai"
import React from "react"
import { useMakeBoard } from "../hooks/board"
import { generateNoteId } from "../utils/note-id"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { TextInput } from "./ui/text-input"

/** Whether the New board dialog is open. Set from the header's **New** menu
 * and its shortcut; the dialog itself is mounted once, in the app root. */
export const newBoardDialogAtom = atom(false)

/**
 * **New board** (docs/boards.md): a name, then a board. A board is a note
 * whose root is of type `board`, so making one is making that node — with
 * the default features written onto its page (`useMakeBoard`) and the row
 * that lists it — and opening it on its board page rather than its
 * outline. The name is the note's title and can be blank, as a note's can.
 * A board made inside a note takes another road: the board picker at the
 * row (`board-picker.tsx`).
 */
export function NewBoardDialog() {
  const [open, setOpen] = useAtom(newBoardDialogAtom)
  const [name, setName] = React.useState("")
  const makeBoard = useMakeBoard()
  const navigate = useNavigate()
  React.useEffect(() => {
    if (open) setName("")
  }, [open])
  const close = () => setOpen(false)
  const submit = () => {
    const id = generateNoteId()
    makeBoard(id, { title: name })
    close()
    void navigate({ to: "/boards/$", params: { _splat: id } })
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
