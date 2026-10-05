import React from "react"
import { boardLinkUrl, isLinkType, type BoardFeature, type ValueRef } from "../../data/boards"
import { Button } from "../ui/button"
import { Dialog } from "../ui/dialog"
import { TextInput } from "../ui/text-input"

/**
 * Naming a new value for a feature — "New location", with a box for the
 * name, from the picker; "New link", with a box for the address and one
 * for a title, from **Add link** — in the app's own dialog, so a phone
 * shows the same window as a desktop rather than its native prompt. Enter
 * or **Add** makes the value and
 * gives it to the picture; the name is trimmed, and an empty one adds
 * nothing. An address is taken with or without its scheme, and one that
 * is not a web address cannot be added; the title is the card's name, and
 * left blank the card is named by the address's host until the page's own
 * title arrives. The window closes on its own once the value is added.
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
  const [title, setTitle] = React.useState("")
  // Fresh boxes each time it opens.
  React.useEffect(() => {
    if (feature) {
      setText("")
      setTitle("")
    }
  }, [feature])
  const link = feature !== null && isLinkType(feature.type)
  // What would be added: the name, or the address — nothing when neither.
  const ref: ValueRef | null = link
    ? boardLinkUrl(text) !== null
      ? { url: text, title }
      : null
    : text.trim() !== ""
      ? { text: text.trim() }
      : null
  const submit = () => {
    if (!feature || !ref) return
    onAdd(feature, ref)
    onClose()
  }
  const label = feature?.label.trim().toLowerCase() || "value"
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
                {link ? "Address" : feature.label.trim() || "Value"}
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
            {link ? (
              <div className="flex flex-col gap-2">
                <label htmlFor="new-value-title" className="text-sm leading-4 text-text-secondary">
                  Title
                </label>
                <TextInput
                  id="new-value-title"
                  value={title}
                  placeholder="Optional"
                  autoComplete="off"
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
            ) : null}
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
