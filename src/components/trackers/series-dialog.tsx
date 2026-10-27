import React from "react"
import {
  SERIES_KINDS,
  SERIES_PERIODS,
  SERIES_ROLLUPS,
  TRACKER_PALETTE,
  type SeriesKind,
  type SeriesPatch,
  type SeriesPeriod,
  type SeriesRollup,
  type SeriesState,
  type TrackerColour,
} from "../../data/tracker"
import { useCoarsePointer } from "../../hooks/coarse-pointer"
import type { TrackerWrites } from "../../hooks/tracker"
import { FormControl } from "../form-control"
import { PlusIcon16, TrashIcon16 } from "../icons"
import { Button } from "../ui/button"
import { ConfirmDialog } from "../ui/confirm-dialog"
import { Dialog } from "../ui/dialog"
import { DropdownMenu } from "../ui/dropdown-menu"
import { IconButton } from "../ui/icon-button"
import { Sheet } from "../ui/sheet"
import { Surface } from "../ui/surface"
import { TextInput } from "../ui/text-input"
import { ColourDot } from "./month-grid"

const KIND_LABELS: Record<SeriesKind, string> = { check: "Check", number: "Number" }
const PERIOD_LABELS: Record<SeriesPeriod, string> = { day: "Day", week: "Week", month: "Month" }
const ROLLUP_LABELS: Record<SeriesRollup, string> = { sum: "Sum", avg: "Average" }
const COLOUR_LABELS: Record<TrackerColour, string> = {
  amber: "Amber",
  blue: "Blue",
  cyan: "Cyan",
  green: "Green",
  orange: "Orange",
  purple: "Purple",
  red: "Red",
  sand: "Sand",
  violet: "Violet",
  yellow: "Yellow",
}

/**
 * **Series** in a tracker's ⋯ menu (docs/trackers.md, "Series"): the
 * tracker's series as a list of cards, one each in the page's order — the
 * name, the kind, the colour, a target and the period it is for, and for a
 * number series its unit, how it adds up, step, min and max. Every change
 * is written as it is made, through the tracker's own writes, and the page
 * shows it. **Add series** makes a check series named "New series" with its
 * name selected. Remove asks first: it deletes the series's entries with it.
 * On a phone the list is a sheet from the foot of the screen.
 */
export function SeriesDialog({
  open,
  series,
  writes,
  onClose,
}: {
  open: boolean
  series: readonly SeriesState[]
  writes: TrackerWrites
  onClose: () => void
}) {
  const coarse = useCoarsePointer()
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const add = () => {
    const id = writes.addSeries()
    if (id) setFocusId(id)
  }
  const onOpenChange = (next: boolean) => (next ? undefined : onClose())
  const body = (
    <div data-testid="series-list" className="flex flex-col gap-4">
      {series.length === 0 ? (
        <p className="text-text-secondary">No series yet. Add one to start logging.</p>
      ) : (
        series.map((state) => (
          <SeriesForm
            key={state.series.id}
            state={state}
            writes={writes}
            focus={state.series.id === focusId}
          />
        ))
      )}
    </div>
  )
  const addControl = (
    <Button icon={<PlusIcon16 />} onClick={add}>
      Add series
    </Button>
  )
  if (coarse) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <Sheet.Content title="Series" titleBar>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{body}</div>
          <div className="border-t border-border-secondary p-4">{addControl}</div>
        </Sheet.Content>
      </Sheet>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <Dialog.Content title="Series">
          <div className="flex flex-col gap-4">
            <div className="max-h-[60vh] overflow-y-auto">{body}</div>
            <div>{addControl}</div>
          </div>
        </Dialog.Content>
      ) : null}
    </Dialog>
  )
}

/** A number field's text as the form holds it: empty for no value. */
const numberText = (value: number | null) => (value === null ? "" : String(value))

function SeriesForm({
  state,
  writes,
  focus,
}: {
  state: SeriesState
  writes: TrackerWrites
  focus: boolean
}) {
  const { series } = state
  const [confirm, setConfirm] = React.useState(false)
  const nameRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (focus) nameRef.current?.select()
  }, [focus])
  const update = (patch: SeriesPatch) => writes.updateSeries(series.id, patch)
  const isNumber = series.kind === "number"
  const count = state.entries.size
  const field = (name: string) => `series-${series.id}-${name}`
  return (
    <Surface
      tier="card"
      motion={false}
      data-testid="series-form"
      className="flex flex-col gap-4 p-4"
    >
      <div className="flex items-end gap-2">
        <ColourMenu colour={series.colour} onPick={(colour) => update({ colour })} />
        <TextField
          ref={nameRef}
          id={field("name")}
          label="Name"
          value={series.name}
          placeholder="Name"
          onCommit={(name) => update({ name })}
          className="min-w-0 flex-1"
        />
        <Picker
          id={field("kind")}
          label="Kind"
          value={series.kind}
          options={SERIES_KINDS}
          labels={KIND_LABELS}
          onPick={(kind) => update({ kind })}
        />
        <IconButton
          aria-label={`Remove ${series.name.trim() || "series"}`}
          onClick={() => setConfirm(true)}
        >
          <TrashIcon16 />
        </IconButton>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <NumberField
          id={field("target")}
          label="Target"
          value={series.target}
          onCommit={(target) => update({ target })}
        />
        <Picker
          id={field("period")}
          label="Per"
          value={series.period}
          options={SERIES_PERIODS}
          labels={PERIOD_LABELS}
          onPick={(period) => update({ period })}
        />
        {isNumber ? (
          <>
            <TextField
              id={field("unit")}
              label="Unit"
              value={series.unit}
              placeholder="km"
              onCommit={(unit) => update({ unit: unit.trim() || null })}
            />
            <Picker
              id={field("rollup")}
              label="Adds up as"
              value={series.rollup}
              options={SERIES_ROLLUPS}
              labels={ROLLUP_LABELS}
              onPick={(rollup) => update({ rollup })}
            />
            <NumberField
              id={field("step")}
              label="Step"
              value={series.step}
              placeholder="1"
              onCommit={(step) => update({ step: step !== null && step > 0 ? step : null })}
            />
            <NumberField
              id={field("min")}
              label="Min"
              value={series.min}
              onCommit={(min) => update({ min })}
            />
            <NumberField
              id={field("max")}
              label="Max"
              value={series.max}
              onCommit={(max) => update({ max })}
            />
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${series.name.trim() || "this series"}?`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => writes.removeSeries(series.id)}
      >
        {count === 0
          ? "The series goes from the tracker."
          : `The series and its ${count} ${count === 1 ? "entry" : "entries"} go from the tracker.`}
      </ConfirmDialog>
    </Surface>
  )
}

/** A text field written on blur or Enter, so a word is one change. */
const TextField = React.forwardRef<
  HTMLInputElement,
  {
    id: string
    label: string
    value: string
    placeholder?: string
    type?: "text" | "number"
    onCommit: (value: string) => void
    className?: string
  }
>(({ id, label, value, placeholder, type = "text", onCommit, className }, ref) => {
  const [draft, setDraft] = React.useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    setDraft(null)
    if (draft !== value) onCommit(draft)
  }
  return (
    <FormControl htmlFor={id} label={label} className={className}>
      <TextInput
        ref={ref}
        id={id}
        type={type}
        inputMode={type === "number" ? "decimal" : undefined}
        value={draft ?? value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
            event.currentTarget.blur()
          }
        }}
      />
    </FormControl>
  )
})
TextField.displayName = "TextField"

/** A number field: empty clears the key. */
function NumberField({
  id,
  label,
  value,
  placeholder,
  onCommit,
}: {
  id: string
  label: string
  value: number | null
  placeholder?: string
  onCommit: (value: number | null) => void
}) {
  return (
    <TextField
      id={id}
      label={label}
      type="number"
      value={numberText(value)}
      placeholder={placeholder}
      onCommit={(raw) => {
        const trimmed = raw.trim()
        if (trimmed === "") return onCommit(null)
        const parsed = Number(trimmed)
        if (Number.isFinite(parsed)) onCommit(parsed)
      }}
    />
  )
}

/** One of a few words, as a menu off a button that names the current one,
 * under a label as a field is. */
function Picker<T extends string>({
  id,
  label,
  value,
  options,
  labels,
  onPick,
}: {
  id: string
  label: string
  value: T
  options: readonly T[]
  labels: Record<T, string>
  onPick: (value: T) => void
}) {
  return (
    <FormControl htmlFor={id} label={label} className="w-auto">
      <DropdownMenu modal={false}>
        <DropdownMenu.Trigger
          render={
            <Button id={id} className="justify-start">
              {labels[value]}
            </Button>
          }
        />
        <DropdownMenu.Content align="start" width={160}>
          {options.map((option) => (
            <DropdownMenu.Item
              key={option}
              selected={option === value}
              onClick={() => onPick(option)}
            >
              {labels[option]}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu>
    </FormControl>
  )
}

/** The palette, as dots in a menu off the series's own dot. */
function ColourMenu({
  colour,
  onPick,
}: {
  colour: TrackerColour
  onPick: (colour: TrackerColour) => void
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <IconButton aria-label={`Colour: ${COLOUR_LABELS[colour]}`}>
            <ColourDot colour={colour} />
          </IconButton>
        }
      />
      <DropdownMenu.Content align="start" width={160}>
        {TRACKER_PALETTE.map((option) => (
          <DropdownMenu.Item
            key={option}
            icon={<ColourDot colour={option} />}
            selected={option === colour}
            onClick={() => onPick(option)}
          >
            {COLOUR_LABELS[option]}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
