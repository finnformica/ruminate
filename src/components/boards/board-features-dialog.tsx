import React from "react"
import { isLinkType, type BoardFeatureState, type FeatureType } from "../../data/boards"
import type { BoardWrites } from "../../hooks/board"
import { Button } from "../ui/button"
import { Checkbox } from "../ui/checkbox"
import { ConfirmDialog } from "../ui/confirm-dialog"
import { Dialog } from "../ui/dialog"
import { DropdownMenu } from "../ui/dropdown-menu"
import { listRow } from "../ui/list"
import { TextInput } from "../ui/text-input"
import { FormControl } from "../form-control"
import {
  AlignLeftIcon16,
  ChevronDownIcon16,
  ChevronRightIcon12,
  GlobeIcon16,
  LinkIcon16,
  PlusIcon16,
  TrashIcon16,
} from "../icons"

/** The types a feature can be, as the menu names them, and the glyph each
 * row wears: lines of text for a name, a globe for a place, a link. */
const TYPE_LABELS: Record<FeatureType, string> = { text: "Text", link: "Link", place: "Place" }
const TYPES: readonly FeatureType[] = ["text", "place", "link"]
const TYPE_ICONS: Record<FeatureType, React.ReactNode> = {
  text: <AlignLeftIcon16 />,
  place: <GlobeIcon16 />,
  link: <LinkIcon16 />,
}

/**
 * **Features** in a board's ⋯ menu (docs/boards.md, "Features"): the
 * board's features as a list, one row each in the page's order — the
 * type's glyph, the label, a chevron — and each row opening the feature
 * in a window of its own (`FeatureDialog`), as a picture on the wall opens
 * in the inspector. **Add feature** at the foot makes a text feature named
 * "New feature" and opens it straight away with the name selected. The
 * order is the page's: a feature is reordered by moving its block in the
 * outline.
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
  // The feature open in its own window, and whether it was just added —
  // its name is then selected, ready to be typed over.
  const [opened, setOpened] = React.useState<{ id: string; added: boolean } | null>(null)
  const openedState = opened ? features.find((s) => s.feature.id === opened.id) : undefined
  const add = () => {
    const id = writes.addFeature()
    if (id) setOpened({ id, added: true })
  }
  return (
    // Focus is kept in the window but the page is not made inert, as the
    // inspector's is, so the toast that answers a removal stays in reach.
    <Dialog open={open} modal="trap-focus" onOpenChange={(next) => (next ? undefined : onClose())}>
      {open ? (
        <Dialog.Content title="Features">
          <div data-testid="board-features" className="flex flex-col gap-4">
            {features.length > 0 ? (
              <div className="-mx-3 flex flex-col">
                {features.map(({ feature }) => (
                  <button
                    key={feature.id}
                    type="button"
                    data-testid="board-feature"
                    className={listRow({ className: "w-full text-left" })}
                    onClick={() => setOpened({ id: feature.id, added: false })}
                  >
                    <span className="flex shrink-0 text-text-secondary">
                      {TYPE_ICONS[feature.type]}
                    </span>
                    <span className="grow truncate">{feature.label.trim() || "Untitled"}</span>
                    <ChevronRightIcon12 className="shrink-0 text-text-secondary" />
                  </button>
                ))}
              </div>
            ) : null}
            <Button className="self-start" onClick={add}>
              <PlusIcon16 />
              Add feature
            </Button>
          </div>
          <FeatureDialog
            state={openedState ?? null}
            selectName={opened?.added ?? false}
            writes={writes}
            onClose={() => setOpened(null)}
          />
        </Dialog.Content>
      ) : null}
    </Dialog>
  )
}

/**
 * One feature in a window of its own, over the list, as a new value's
 * window sits over the inspector: its name, its type, whether a picture
 * may carry several of its values, and what the model is told it means —
 * each written as it changes, the name and the meaning when the box is
 * left or Enter is pressed, as the inspector's caption is. The title is
 * the feature's label, live. A type cannot change between a name and a
 * link while the feature has values, since its value blocks are of the
 * one kind: those entries are greyed. **Delete feature** at the foot, as
 * the inspector has **Delete image**, asks first: the feature's values go
 * with it, and nothing restores them.
 */
function FeatureDialog({
  state,
  selectName,
  writes,
  onClose,
}: {
  /** The feature shown, or null while none is. */
  state: BoardFeatureState | null
  /** Whether to open on the name selected: a feature just added. */
  selectName: boolean
  writes: BoardWrites
  onClose: () => void
}) {
  const [deleting, setDeleting] = React.useState(false)
  return (
    <Dialog open={state !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      {state ? (
        <FeatureForm
          key={state.feature.id}
          state={state}
          selectName={selectName}
          writes={writes}
          onDelete={() => setDeleting(true)}
        />
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={(next) => (next ? undefined : setDeleting(false))}
        title={`Delete “${state?.feature.label.trim() || "Untitled"}”?`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (!state) return
          writes.removeFeature(state.feature.id)
          onClose()
        }}
      >
        Its values are deleted and come off every picture; the pictures stay on the board.
      </ConfirmDialog>
    </Dialog>
  )
}

function FeatureForm({
  state,
  selectName,
  writes,
  onDelete,
}: {
  state: BoardFeatureState
  selectName: boolean
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
  // A feature just added opens on its name (`initialFocus`), selected to be
  // typed over: the selection is made as the focus lands, since the window
  // gives it only once it has opened, after any effect here has run.
  const selectOnce = React.useRef(selectName)
  const onNameFocus = (event: React.FocusEvent<HTMLInputElement>) => {
    if (!selectOnce.current) return
    selectOnce.current = false
    event.currentTarget.select()
  }
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
  return (
    <Dialog.Content
      title={feature.label.trim() || "Untitled"}
      initialFocus={selectName ? nameRef : undefined}
    >
      <div data-testid="board-feature-window" className="flex flex-col gap-4">
        <FormControl htmlFor="feature-name" label="Name">
          <TextInput
            ref={nameRef}
            id="feature-name"
            value={name}
            autoComplete="off"
            onFocus={onNameFocus}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={onEnter(commitName)}
          />
        </FormControl>
        <FormControl htmlFor="feature-type" label="Type">
          <DropdownMenu modal={false}>
            <DropdownMenu.Trigger
              render={
                <Button id="feature-type" className="self-start gap-1.5">
                  {TYPE_LABELS[feature.type]}
                  <ChevronDownIcon16 className="text-text-secondary" />
                </Button>
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
        </FormControl>
        <div className="flex items-center gap-2 leading-4">
          <Checkbox
            id="feature-multi"
            checked={feature.multi}
            onCheckedChange={(checked) => writes.updateFeature(feature.id, { multi: checked })}
          />
          <label htmlFor="feature-multi">Several values</label>
        </div>
        {/* The model is never asked about a link, so a link feature has
            nothing to tell it. */}
        {isLinkType(feature.type) ? null : (
          <FormControl htmlFor="feature-meaning" label="Meaning">
            <TextInput
              id="feature-meaning"
              value={meaning}
              placeholder="What the model is told"
              autoComplete="off"
              onChange={(event) => setMeaning(event.target.value)}
              onBlur={commitMeaning}
              onKeyDown={onEnter(commitMeaning)}
            />
          </FormControl>
        )}
        <div className="flex">
          <Button size="small" className="text-text-danger" onClick={onDelete}>
            <TrashIcon16 />
            Delete feature
          </Button>
        </div>
      </div>
    </Dialog.Content>
  )
}
