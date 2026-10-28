import { useNavigate } from "@tanstack/react-router"
import { atom, useAtom } from "jotai"
import React from "react"
import { useMakeTracker } from "../hooks/tracker"
import { generateNoteId } from "../utils/note-id"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { TextInput } from "./ui/text-input"

/** Whether the New tracker dialog is open. Set from the header's **New**
 * menu; the dialog itself is mounted once, in the app root. */
export const newTrackerDialogAtom = atom(false)

/**
 * **New tracker** (docs/trackers.md): a name, then a tracker. A tracker is a
 * note whose root is of type `tracker`, so making one is making that node
 * (`useMakeTracker`) with the row that lists it, and opening it on its own
 * page rather than its outline. The name is the note's title and can be
 * blank, as a note's can.
 */
export function NewTrackerDialog() {
  const [open, setOpen] = useAtom(newTrackerDialogAtom)
  const [name, setName] = React.useState("")
  const makeTracker = useMakeTracker()
  const navigate = useNavigate()
  React.useEffect(() => {
    if (open) setName("")
  }, [open])
  const close = () => setOpen(false)
  const submit = () => {
    const id = generateNoteId()
    makeTracker(id, { title: name })
    close()
    void navigate({ to: "/trackers/$", params: { _splat: id } })
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {open ? (
        <Dialog.Content title="New tracker">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <div className="flex flex-col gap-2">
              <label htmlFor="new-tracker-name" className="text-sm leading-4 text-text-secondary">
                Name
              </label>
              <TextInput
                id="new-tracker-name"
                value={name}
                placeholder="Habits"
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
