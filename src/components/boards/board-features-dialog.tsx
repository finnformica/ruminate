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
import { AlignLeftIcon16, GlobeIcon16, LinkIcon16, PlusIcon16, TrashIcon16 } from "../icons"

/** The types a feature can be, as the menu names them, and the glyph each
 * wears: lines of text for a name, a globe for a place, a link. */
const TYPE_LABELS: Record<FeatureType, string> = { text: "Text", link: "Link", place: "Place" }
const TYPES: readonly FeatureType[] = ["text", "place", "link"]
const TYPE_ICONS: Record<FeatureType, React.ReactNode> = {
  text: <AlignLeftIcon16 />,
  place: <GlobeIcon16 />,
  link: <LinkIcon16 />,
}

/**
 * **Features** in a board's ⋯ menu (docs/boards.md, "Features"): the
 * board's features, one block each in the page's order, every one edited
 * in place — the type's glyph, which is the type menu; the name; whether
 * a picture may carry several of its values; the delete; and, beneath,
 * what the model is told the feature means. Every change is written as it
 * is made, through the board's own writes, and the page shows it. **Add
 * feature** at the foot makes a text feature named "New feature" with its
 * name selected, ready to be typed over. The order is the page's: a
 * feature is reordered by moving its block in the outline. Deleting a
 * feature deletes its values, which nothing restores, so it asks first.
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
  // The feature whose deletion is being confirmed, if any.
  const [deleting, setDeleting] = React.useState<BoardFeature | null>(null)
  // The feature just added, whose name takes the focus, selected.
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const add = () => {
    const id = writes.addFeature()
    if (id) setFocusId(id)
  }
  return (
    // Focus is kept in the window but the page is not made inert, as the
    // inspector's is, so the toast that answers a deletion stays in reach.
    <Dialog open={open} modal="trap-focus" onOpenChange={(next) => (next ? undefined : onClose())}>
      {open ? (
        <Dialog.Content title="Features">
          <div data-testid="board-features" className="flex flex-col gap-4">
            {features.length > 0 ? (
              <div className="flex flex-col divide-y divide-border-secondary">
                {features.map((state) => (
                  <FeatureRow
                    key={state.feature.id}
                    state={state}
                    focus={state.feature.id === focusId}
                    writes={writes}
                    onDelete={() => setDeleting(state.feature)}
                  />
                ))}
              </div>
            ) : null}
            <Button className="self-start" onClick={add}>
              <PlusIcon16 />
              Add feature
            </Button>
          </div>
          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(next) => (next ? undefined : setDeleting(null))}
            title={`Delete “${deleting?.label.trim() || "Untitled"}”?`}
            confirmLabel="Delete"
            variant="danger"
            onConfirm={() => {
              if (deleting) writes.removeFeature(deleting.id)
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
 * One feature, in place. The name and the meaning are committed when the
 * box is left or Enter is pressed, as the inspector's caption is, so a
 * rename is one write rather than one a keystroke; the type and the
 * checkbox write as they change. The type's glyph opens the type menu; a
 * type cannot change between a name and a link while the feature has
 * values, since its value blocks are of the one kind, and those entries
 * are greyed. A link feature has no meaning line: the model is never
 * asked about it.
 */
function FeatureRow({
  state,
  focus,
  writes,
  onDelete,
}: {
  state: BoardFeatureState
  /** Whether the name takes the focus, selected: a feature just added. */
  focus: boolean
  writes: BoardWrites
  onDelete: () => void
}) {
  const { feature, values } = state
  const [name, setName] = React.useState(feature.label)
  const [meaning, setMeaning] = React.useState(feature.meaning)
  // The outline, or another device, may change it while the window is open.
  React.useEffect(() => setName(feature.label), [feature.label])
  React.useEffect(() => setMeaning(feature.meaning), [feature.meaning])
  const nameRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (!focus) return
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [focus])
  const commitName = () => {
    if (name.trim() === "") setName(feature.label)
    else writes.updateFeature(feature.id, { label: name })
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
  const shown = feature.label.trim() || "Untitled"
  return (
    <div data-testid="board-feature" className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      {/* One line where it fits. Where it does not — a phone's width with a
          coarse pointer's larger controls — the name keeps the line and the
          checkbox and the delete wrap beneath it, to the right. */}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu modal={false}>
          <DropdownMenu.Trigger
            render={
              <IconButton aria-label="Type" size="small" className="shrink-0">
                {TYPE_ICONS[feature.type]}
              </IconButton>
            }
          />
          <DropdownMenu.Content align="start" width={160}>
            {TYPES.map((type) => (
              <DropdownMenu.Item
                key={type}
                icon={TYPE_ICONS[type]}
                selected={feature.type === type}
                disabled={!canBecome(type)}
                onClick={() => writes.updateFeature(feature.id, { type })}
              >
                {TYPE_LABELS[type]}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu>
        <TextInput
          ref={nameRef}
          aria-label="Name"
          value={name}
          autoComplete="off"
          className="min-w-36 flex-1"
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={onEnter(commitName)}
        />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Checkbox
            id={`feature-multi-${feature.id}`}
            checked={feature.multi}
            onCheckedChange={(checked) => writes.updateFeature(feature.id, { multi: checked })}
          />
          <label htmlFor={`feature-multi-${feature.id}`} className="whitespace-nowrap">
            Several values
          </label>
          <IconButton
            aria-label="Delete feature"
            size="small"
            className="text-text-danger"
            tooltipSide="left"
            onClick={onDelete}
          >
            <TrashIcon16 />
          </IconButton>
        </div>
      </div>
      {/* The model is never asked about a link, so a link feature has
          nothing to tell it. */}
      {isLinkType(feature.type) ? null : (
        <TextInput
          aria-label={`Meaning of ${shown}`}
          value={meaning}
          placeholder="What the model is told"
          autoComplete="off"
          className="text-sm text-text-secondary"
          onChange={(event) => setMeaning(event.target.value)}
          onBlur={commitMeaning}
          onKeyDown={onEnter(commitMeaning)}
        />
      )}
    </div>
  )
}
