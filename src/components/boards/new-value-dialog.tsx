import React from "react"
import { boardLinkUrl, type BoardFeature, type ValueRef } from "../../data/boards"
import { Button } from "../ui/button"
import { Dialog } from "../ui/dialog"
import { TextInput } from "../ui/text-input"

/**
 * Naming a new value for a feature — "New location", with a box for the
 * name; "New link", with a box for the address — in the app's own dialog,
 * so a phone shows the same window as a desktop rather than its native
 * prompt. Enter or **Add** makes the value and gives it to the picture; the
 * name is trimmed, and an empty one adds nothing. An address is taken
 * with or without its scheme, and one that is not a web address cannot be
 * added. The window closes on its own once the value is added.
 */
export function NewValueDialog({
  feature,
  onAdd,
  onClose,
}: {
  /** The feature a value is being named for, or null while nothing is. */
  feature: BoardFeature | null
  onAdd: (feature: BoardFeature, ref: ValueRef) => void
  onClose: () => void
}) {
  const [text, setText] = React.useState("")
  // A fresh box each time it opens.
  React.useEffect(() => {
    if (feature) setText("")
  }, [feature])
  const link = feature?.kind === "link"
  // What would be added: the name, or the address — nothing when neither.
  const ref: ValueRef | null = link
    ? boardLinkUrl(text) !== null
      ? { url: text }
      : null
    : text.trim() !== ""
      ? { text: text.trim() }
      : null
  const submit = () => {
    if (!feature || !ref) return
    onAdd(feature, ref)
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
                placeholder={link ? "https://" : `A ${label}…`}
                inputMode={link ? "url" : undefined}
                autoCapitalize={link ? "off" : undefined}
                autoComplete="off"
                spellCheck={false}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={ref === null}>
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
