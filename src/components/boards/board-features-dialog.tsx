import React from "react"
import {
  isLinkType,
  type BoardFeature,
  type BoardFeatureState,
  type FeatureType,
} from "../../data/boards"
import type { BoardWrites } from "../../hooks/board"
import { Button } from "../ui/button"
import { Checkbox } from "../ui/checkbox"
import { ConfirmDialog } from "../ui/confirm-dialog"
import { Dialog } from "../ui/dialog"
import { DropdownMenu } from "../ui/dropdown-menu"
import { IconButton } from "../ui/icon-button"
import { TextInput } from "../ui/text-input"
import {
  ArrowDownIcon16,
  ArrowUpIcon16,
  ChevronDownIcon16,
  PlusIcon16,
  TrashIcon16,
} from "../icons"

/** The types a feature can be, as the menu names them. */
const TYPE_LABELS: Record<FeatureType, string> = { text: "Text", link: "Link", place: "Place" }
const TYPES: readonly FeatureType[] = ["text", "place", "link"]

/**
 * **Features…** in a board's ⋯ menu (docs/boards.md, "Features"): the
 * board's features as rows, each its label, its type, whether a picture
 * may carry several of its values, and what the model is told it means,
 * with a step up or down among the others and a remove. Every change is
 * written as it is made, through the board's own writes, and the page
 * shows it — the inspector's pickers and the Filter menu follow a rename
 * at once, since the feature is its block. Removing a feature deletes its
 * values, which nothing restores, so it asks first. **Add feature** puts
 * a new text feature at the foot, its label ready to be typed over.
 */
export function BoardFeaturesDialog({
  open,
  features,
  writes,
  onClose,
}: {
  open: boolean
  features: BoardFeatureState[]
  writes: BoardWrites
  onClose: () => void
}) {
  // The feature whose removal is being confirmed, if any.
  const [removing, setRemoving] = React.useState<BoardFeature | null>(null)
  // The feature just added, whose label takes the focus.
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const add = () => {
    const id = writes.addFeature()
    if (id) setFocusId(id)
  }
  return (
    // Focus is kept in the window but the page is not made inert, as the
    // inspector's is, so the toast that answers a removal stays in reach.
    <Dialog open={open} modal="trap-focus" onOpenChange={(next) => (next ? undefined : onClose())}>
      {open ? (
        <Dialog.Content title="Features">
          <div data-testid="board-features" className="flex flex-col gap-4">
            {features.length === 0 ? (
              <p className="leading-5 text-text-secondary">No features yet.</p>
            ) : (
              <div className="flex flex-col divide-y divide-border-secondary">
                {features.map((state, index) => (
                  <FeatureRow
                    key={state.feature.id}
                    state={state}
                    first={index === 0}
                    last={index === features.length - 1}
                    focus={state.feature.id === focusId}
                    writes={writes}
                    onRemove={() => setRemoving(state.feature)}
                  />
                ))}
              </div>
            )}
            <Button className="self-start" onClick={add}>
              <PlusIcon16 />
              Add feature
            </Button>
          </div>
          <ConfirmDialog
            open={removing !== null}
            onOpenChange={(next) => (next ? undefined : setRemoving(null))}
            title={`Remove “${removing?.label.trim() || "Untitled"}”?`}
            confirmLabel="Remove"
            variant="danger"
            onConfirm={() => {
              if (removing) writes.removeFeature(removing.id)
            }}
          >
            Its values are deleted and come off every picture; the pictures stay on the board.
          </ConfirmDialog>
        </Dialog.Content>
      ) : null}
    </Dialog>
  )
}

/**
 * One feature's row. The label and the meaning are committed when the
 * box is left or Enter is pressed, as the inspector's caption is, so a
 * rename is one write rather than one a keystroke; the type and the
 * checkbox write as they change. A type cannot change between a name and
 * a link while the feature has values, since its value blocks are of the
 * one kind: those entries are greyed.
 */
function FeatureRow({
  state,
  first,
  last,
  focus,
  writes,
  onRemove,
}: {
  state: BoardFeatureState
  first: boolean
  last: boolean
  focus: boolean
  writes: BoardWrites
  onRemove: () => void
}) {
  const { feature, values } = state
  const [label, setLabel] = React.useState(feature.label)
  const [meaning, setMeaning] = React.useState(feature.meaning)
  // The outline, or another device, may change it while the row is open.
  React.useEffect(() => setLabel(feature.label), [feature.label])
  React.useEffect(() => setMeaning(feature.meaning), [feature.meaning])
  const labelRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (focus) labelRef.current?.select()
  }, [focus])
  const commitLabel = () => {
    if (label.trim() === "") setLabel(feature.label)
    else writes.updateFeature(feature.id, { label })
  }
  const commitMeaning = () => writes.updateFeature(feature.id, { meaning })
  // Enter commits and leaves the box, as it does in the inspector.
  const onEnter = (commit: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      commit()
      event.currentTarget.blur()
    }
  }
  const canBecome = (type: FeatureType) =>
    values.length === 0 || isLinkType(type) === isLinkType(feature.type)
  const name = feature.label.trim() || "Untitled"
  return (
    <div data-testid="board-feature" className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <TextInput
          ref={labelRef}
          aria-label="Label"
          value={label}
          autoComplete="off"
          onChange={(event) => setLabel(event.target.value)}
          onBlur={commitLabel}
          onKeyDown={onEnter(commitLabel)}
        />
        <DropdownMenu modal={false}>
          <DropdownMenu.Trigger
            render={
              <Button aria-label={`Type of ${name}`} className="shrink-0 gap-1.5">
                {TYPE_LABELS[feature.type]}
                <ChevronDownIcon16 className="text-text-secondary" />
              </Button>
            }
          />
          <DropdownMenu.Content align="end" width={160}>
            {TYPES.map((type) => (
              <DropdownMenu.Item
                key={type}
                selected={feature.type === type}
                disabled={!canBecome(type)}
                onClick={() => writes.updateFeature(feature.id, { type })}
              >
                {TYPE_LABELS[type]}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`feature-multi-${feature.id}`}
          checked={feature.multi}
          onCheckedChange={(checked) => writes.updateFeature(feature.id, { multi: checked })}
        />
        <label htmlFor={`feature-multi-${feature.id}`} className="flex-1 leading-4">
          Several values
        </label>
        <IconButton
          aria-label={`Move ${name} up`}
          size="small"
          disabled={first}
          onClick={() => writes.moveFeature(feature.id, "up")}
        >
          <ArrowUpIcon16 />
        </IconButton>
        <IconButton
          aria-label={`Move ${name} down`}
          size="small"
          disabled={last}
          onClick={() => writes.moveFeature(feature.id, "down")}
        >
          <ArrowDownIcon16 />
        </IconButton>
        <IconButton aria-label={`Remove ${name}`} size="small" onClick={onRemove}>
          <TrashIcon16 />
        </IconButton>
      </div>
      {/* The model is never asked about a link, so a link feature has
          nothing to tell it. */}
      {isLinkType(feature.type) ? null : (
        <TextInput
          aria-label={`Meaning of ${name}`}
          value={meaning}
          placeholder="What the model is told"
          autoComplete="off"
          onChange={(event) => setMeaning(event.target.value)}
          onBlur={commitMeaning}
          onKeyDown={onEnter(commitMeaning)}
        />
      )}
    </div>
  )
}
