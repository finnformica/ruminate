import React from "react"
import { isLinkType, type BoardFeatureState, type FeatureType } from "../../data/boards"
import { useAiAvailable } from "../../hooks/ai"
import type { BoardWrites } from "../../hooks/board"
import { useCoarsePointer } from "../../hooks/coarse-pointer"
import { cx } from "../../utils/cx"
import { Button } from "../ui/button"
import { Checkbox } from "../ui/checkbox"
import { Dialog } from "../ui/dialog"
import { DropdownMenu } from "../ui/dropdown-menu"
import { IconButton } from "../ui/icon-button"
import { Sheet } from "../ui/sheet"
import { TextArea } from "../ui/text-area"
import { TextInput } from "../ui/text-input"
import {
  AlignLeftIcon16,
  GlobeIcon16,
  LinkIcon16,
  PlusIcon16,
  TrashIcon16,
  XIcon16,
} from "../icons"

/** The types a feature can be, as the menu names them, and the glyph each
 * wears: lines of text for a name, a globe for a place, a link. */
const TYPE_LABELS: Record<FeatureType, string> = { text: "Text", link: "Link", place: "Place" }
const TYPES: readonly FeatureType[] = ["text", "place", "link"]
const TYPE_ICONS: Record<FeatureType, React.ReactNode> = {
  text: <AlignLeftIcon16 />,
  place: <GlobeIcon16 />,
  link: <LinkIcon16 />,
}

/** A column heading: caption rank, as a table's chrome is. */
const heading = "text-sm font-normal text-text-secondary"

/**
 * **Features** in a board's ⋯ menu (docs/boards.md, "Features"): the
 * board's features as a table, one row each in the page's order, every
 * cell edited in place — the type's glyph, which is the type menu; the
 * name; **Multiple**, whether a picture may carry several of its values;
 * **Notes**, what the model is told, which is there only while a model
 * can be asked (`useAiAvailable`); and a remove, shown as the pointer
 * finds the row. Every change is written as it is made, through the
 * board's own writes, and the page shows it. **Add feature** in the last
 * row makes a text feature named "New feature" with its name selected,
 * ready to be typed over. The order is the page's: a feature is reordered
 * by moving its block in the outline. On a phone the table is a sheet
 * from the foot of the screen, the notes beneath each name and **Add
 * feature** pinned at the bottom.
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
  const coarse = useCoarsePointer()
  const notes = useAiAvailable().available
  // The feature just added, whose name takes the focus, selected.
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const add = () => {
    const id = writes.addFeature()
    if (id) setFocusId(id)
  }
  const onOpenChange = (next: boolean) => (next ? undefined : onClose())
  const row = (state: BoardFeatureState) => ({
    state,
    notes,
    focus: state.feature.id === focusId,
    writes,
  })

  if (coarse) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <Sheet.Content title="Features">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-secondary pl-4 pr-2">
            <span aria-hidden className="font-bold">
              Features
            </span>
            <IconButton aria-label="Close" disableTooltip onClick={onClose}>
              <XIcon16 />
            </IconButton>
          </div>
          <div data-testid="board-features" className="min-h-0 flex-1 overflow-y-auto px-4">
            <div
              className={cx(
                "grid grid-cols-[40px_minmax(0,1fr)_56px_40px] items-center border-b border-border-secondary py-1.5",
                heading,
              )}
            >
              {/* The hidden word sits inside a cell of its own: `sr-only`
                  takes a span out of the grid's flow, which would slide
                  every header one column left of the cells beneath. */}
              <span>
                <span className="sr-only">Type</span>
              </span>
              <span>Name</span>
              <span className="text-center">Multiple</span>
              <span />
            </div>
            {features.map((state) => (
              <SheetRow key={state.feature.id} {...row(state)} />
            ))}
          </div>
          <div className="shrink-0 p-4">
            <Button className="w-full" onClick={add}>
              <PlusIcon16 />
              Add feature
            </Button>
          </div>
        </Sheet.Content>
      </Sheet>
    )
  }

  return (
    // Focus is kept in the window but the page is not made inert, as the
    // inspector's is, so the toast that answers a removal — with its Undo —
    // stays in reach.
    <Dialog open={open} modal="trap-focus" onOpenChange={onOpenChange}>
      {open ? (
        <Dialog.Content title="Features" className="max-w-xl">
          <table data-testid="board-features" className="w-full border-collapse">
            <thead>
              <tr className={heading}>
                <th className="w-8 py-1.5">
                  <span className="sr-only">Type</span>
                </th>
                <th className="py-1.5 text-left font-normal">Name</th>
                <th className="w-16 py-1.5 text-center font-normal">Multiple</th>
                {notes ? <th className="w-44 py-1.5 text-left font-normal">Notes</th> : null}
                <th className="w-8 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {features.map((state) => (
                <TableRow key={state.feature.id} {...row(state)} />
              ))}
              <tr className="border-t border-border-secondary">
                <td colSpan={notes ? 5 : 4} className="pt-3">
                  <Button onClick={add}>
                    <PlusIcon16 />
                    Add feature
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </Dialog.Content>
      ) : null}
    </Dialog>
  )
}

interface RowProps {
  state: BoardFeatureState
  /** Whether the notes are shown: a model can be asked. */
  notes: boolean
  /** Whether the name takes the focus, selected: a feature just added. */
  focus: boolean
  writes: BoardWrites
}

/**
 * What one feature's cells share, whichever shape the row takes: the name
 * and the notes are committed when the box is left or Enter is pressed,
 * as the inspector's caption is, so a rename is one write rather than one
 * a keystroke; the type and the checkbox write as they change. A type
 * cannot change between a name and a link while the feature has values,
 * since its value blocks are of the one kind, and those entries are
 * greyed. Every feature has notes, a link feature too — kept with it,
 * though the model is only told about text and place features.
 */
function useFeatureCells({ state, focus, writes }: RowProps) {
  const { feature, values } = state
  const [name, setName] = React.useState(feature.label)
  const [notes, setNotes] = React.useState(feature.notes)
  // The outline, or another device, may change it while the window is open.
  React.useEffect(() => setName(feature.label), [feature.label])
  React.useEffect(() => setNotes(feature.notes), [feature.notes])
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
  const commitNotes = () => writes.updateFeature(feature.id, { notes })
  // Enter commits and leaves the box, as it does in the inspector.
  const onEnter =
    (commit: () => void) =>
    (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        commit()
        event.currentTarget.blur()
      }
    }
  const canBecome = (type: FeatureType) =>
    values.length === 0 || isLinkType(type) === isLinkType(feature.type)
  const shown = feature.label.trim() || "Untitled"

  const typeMenu = (size: "small" | "medium", className?: string) => (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton aria-label={TYPE_LABELS[feature.type]} size={size} className={className}>
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
  )
  const nameField = (className?: string) => (
    <TextInput
      ref={nameRef}
      variant="flush"
      aria-label="Name"
      value={name}
      autoComplete="off"
      className={className}
      onChange={(event) => setName(event.target.value)}
      onBlur={commitName}
      onKeyDown={onEnter(commitName)}
    />
  )
  const multiBox = (className?: string) => (
    <Checkbox
      aria-label="Multiple values"
      checked={feature.multi}
      className={className}
      onCheckedChange={(checked) => writes.updateFeature(feature.id, { multi: checked })}
    />
  )
  const notesField = (className?: string) => (
    <TextArea
      variant="flush"
      aria-label={`Notes on ${shown}`}
      value={notes}
      placeholder="Add notes…"
      autoComplete="off"
      className={cx("text-sm text-text-secondary placeholder:text-text-tertiary", className)}
      onChange={(event) => setNotes(event.target.value)}
      onBlur={commitNotes}
      onKeyDown={onEnter(commitNotes)}
    />
  )
  const remove = (size: "small" | "medium", className?: string) => (
    <IconButton
      aria-label={`Remove ${shown}`}
      size={size}
      className={cx("text-text-danger", className)}
      tooltipSide="left"
      onClick={() => writes.removeFeature(feature.id)}
    >
      <TrashIcon16 />
    </IconButton>
  )
  return { typeMenu, nameField, multiBox, notesField, remove }
}

/** A feature as a table row: its cells top-aligned, a hairline above, the
 * remove revealed as the pointer finds the row or the focus is in it. */
function TableRow(props: RowProps) {
  const cells = useFeatureCells(props)
  return (
    <tr data-testid="board-feature" className="group border-t border-border-secondary align-top">
      <td className="py-[3px]">{cells.typeMenu("small", "mx-auto")}</td>
      <td className="py-[3px]">{cells.nameField()}</td>
      <td className="py-[3px] text-center">{cells.multiBox("mx-auto mt-2")}</td>
      {props.notes ? <td className="py-[3px]">{cells.notesField()}</td> : null}
      <td className="py-[3px]">
        {cells.remove(
          "small",
          "mt-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 coarse:opacity-100",
        )}
      </td>
    </tr>
  )
}

/** A feature on the sheet's grid: the four cells on one line, the notes
 * beneath the name alone, a hairline below. */
function SheetRow(props: RowProps) {
  const cells = useFeatureCells(props)
  return (
    <div
      data-testid="board-feature"
      className="grid grid-cols-[40px_minmax(0,1fr)_56px_40px] items-center border-b border-border-secondary"
    >
      {cells.typeMenu("medium", "justify-self-center")}
      {/* 16px text, so the phone does not zoom in on the box. */}
      {cells.nameField("text-[16px]")}
      {cells.multiBox("justify-self-center")}
      {cells.remove("medium")}
      {props.notes ? (
        <div className="col-start-2 mb-2 mt-1">{cells.notesField()}</div>
      ) : (
        <div className="col-start-2 h-1.5" />
      )}
    </div>
  )
}
