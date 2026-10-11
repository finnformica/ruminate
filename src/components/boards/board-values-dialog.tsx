import { useAtomValue } from "jotai"
import React from "react"
import { hostOf } from "../../blocks/link"
import {
  isLinkType,
  valueImageIds,
  type BoardFeatureState,
  type BoardValue,
} from "../../data/boards"
import { graphSnapshotAtom } from "../../global-state"
import type { BoardWrites } from "../../hooks/board"
import { ConfirmDialog } from "../ui/confirm-dialog"
import { Dialog } from "../ui/dialog"
import { IconButton } from "../ui/icon-button"
import { TextInput } from "../ui/text-input"
import { TrashIcon16 } from "../icons"

/**
 * **The Values editor** (docs/boards.md, "Values"): one feature's values as
 * a list, each a flush box holding its name — a link's title — that
 * commits when it is left or Enter is pressed and renames the block, and a
 * delete beside it, which asks first: the value comes off every picture
 * that carries it, and a tombstone has no way back. Reached from a
 * picker's **Edit values…** in the picture's window and from the Values
 * column of the Features editor, so a link feature, which has no picker,
 * can be tidied too. Nothing here is a new kind of write: a rename is the
 * block's text, a delete is the outline's Delete.
 */
export function BoardValuesDialog({
  state,
  writes,
  onClose,
}: {
  /** The feature whose values are shown, or null while none are. */
  state: BoardFeatureState | null
  writes: BoardWrites
  onClose: () => void
}) {
  const [deleting, setDeleting] = React.useState<BoardValue | null>(null)
  const label = state?.feature.label.trim() || "Untitled"
  return (
    <Dialog open={state !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      {state ? (
        <Dialog.Content title={`${label} values`}>
          {state.values.length === 0 ? (
            <p className="text-text-secondary">No values yet.</p>
          ) : (
            <ul data-testid="board-values" className="-mx-2 flex flex-col">
              {state.values.map((value) => (
                <ValueRow
                  key={value.id}
                  state={state}
                  value={value}
                  writes={writes}
                  onDelete={() => setDeleting(value)}
                />
              ))}
            </ul>
          )}
          <DeleteValueDialog
            state={state}
            value={deleting}
            writes={writes}
            onClose={() => setDeleting(null)}
          />
        </Dialog.Content>
      ) : null}
    </Dialog>
  )
}

/**
 * One value: its name in a flush box, as the Features editor holds a
 * feature's, committed on blur or Enter; a refused name — blank, or one
 * another value has — puts the name it has back. A link value shows its
 * host beneath the title, so two pages with one title can be told apart.
 */
function ValueRow({
  state,
  value,
  writes,
  onDelete,
}: {
  state: BoardFeatureState
  value: BoardValue
  writes: BoardWrites
  onDelete: () => void
}) {
  const [name, setName] = React.useState(value.text)
  // The outline, or another device, may rename it while the window is open.
  React.useEffect(() => setName(value.text), [value.text])
  const commit = () => {
    if (name.trim() === value.text) return
    if (!writes.renameValue(state.feature.id, value.id, name)) setName(value.text)
  }
  const shown = value.text.trim() || "Untitled"
  return (
    <li
      data-testid="board-value"
      className="flex items-center gap-1 border-t border-border-secondary first:border-t-0"
    >
      <div className="flex min-w-0 flex-1 flex-col py-[3px]">
        <TextInput
          variant="flush"
          aria-label={`Name of ${shown}`}
          value={name}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              commit()
              event.currentTarget.blur()
            }
          }}
        />
        {isLinkType(state.feature.type) && value.link ? (
          <span className="truncate px-2.5 text-sm text-text-secondary coarse:px-3">
            {hostOf(value.link.url)}
          </span>
        ) : null}
      </div>
      <IconButton
        aria-label={`Delete ${shown}`}
        size="small"
        className="shrink-0 text-text-danger"
        tooltipSide="left"
        onClick={onDelete}
      >
        <TrashIcon16 />
      </IconButton>
    </li>
  )
}

/**
 * The question a delete asks (docs/design-principles.md, Confirmation):
 * named for the value, saying how many pictures it comes off and that a
 * picture left with nothing else holding it goes back to Unassigned.
 */
function DeleteValueDialog({
  state,
  value,
  writes,
  onClose,
}: {
  state: BoardFeatureState
  value: BoardValue | null
  writes: BoardWrites
  onClose: () => void
}) {
  const snapshot = useAtomValue(graphSnapshotAtom)
  const count = value ? valueImageIds(snapshot, value.id).length : 0
  const carried =
    count === 0
      ? "No picture carries it."
      : count === 1
        ? "It comes off the one picture that carries it; left with nothing else, that picture goes back to Unassigned."
        : `It comes off the ${count} pictures that carry it; a picture left with nothing else goes back to Unassigned.`
  return (
    <ConfirmDialog
      open={value !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={`Delete “${value?.text.trim() || "Untitled"}”?`}
      confirmLabel="Delete"
      variant="danger"
      onConfirm={() => {
        if (value) writes.deleteValue(state.feature.id, value.id)
      }}
    >
      {carried} This cannot be undone.
    </ConfirmDialog>
  )
}
