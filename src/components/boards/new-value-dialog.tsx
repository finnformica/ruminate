import React from "react"
import type { BoardFeature } from "../../data/boards"
import { Button } from "../ui/button"
import { Dialog } from "../ui/dialog"
import { TextInput } from "../ui/text-input"

/**
 * Naming a new value for a feature — "New location", with a box for the
 * name — in the app's own dialog, so a phone shows the same window as a
 * desktop rather than its native prompt. Enter or **Add** makes the value
 * and gives it to the picture; the name is trimmed, and an empty one adds
 * nothing. The window closes on its own once the value is added.
 */
export function NewValueDialog({
  feature,
  onAdd,
  onClose,
}: {
  /** The feature a value is being named for, or null while nothing is. */
  feature: BoardFeature | null
  onAdd: (feature: BoardFeature, text: string) => void
  onClose: () => void
}) {
  const [text, setText] = React.useState("")
  // A fresh box each time it opens.
  React.useEffect(() => {
    if (feature) setText("")
  }, [feature])
  const name = text.trim()
  const submit = () => {
    if (!feature || name === "") return
    onAdd(feature, name)
    onClose()
  }
  const label = feature?.label.toLowerCase() ?? "value"
  return (
    <Dialog open={feature !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      {feature ? (
        <Dialog.Content title={`New ${label}`}>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <div className="flex flex-col gap-2">
              <label htmlFor="new-value" className="text-sm leading-4 text-text-secondary">
                {feature.label}
              </label>
              <TextInput
                id="new-value"
                value={text}
                placeholder={`A ${label}…`}
                autoComplete="off"
                spellCheck={false}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={name === ""}>
                Add
              </Button>
              <Button type="button" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </form>
        </Dialog.Content>
      ) : null}
    </Dialog>
  )
}
