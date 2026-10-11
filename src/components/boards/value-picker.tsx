import type { BoardFeatureState, BoardValue } from "../../data/boards"
import { cx } from "../../utils/cx"
import { Button } from "../ui/button"
import { DropdownMenu } from "../ui/dropdown-menu"
import { ChevronDownIcon16, EditIcon16, PlusIcon16 } from "../icons"

/**
 * One feature's picker: a button naming what is set, and a menu of the
 * feature's values to pick from — plus **New**, which asks for a name and
 * makes the value on the way, and **Edit values**, there once the feature
 * has any, which opens the Values editor to rename or delete them
 * (docs/boards.md, "Values"). A single-select feature closes on a pick; a
 * multi-select one stays open, each row a toggle.
 */
export function ValuePicker({
  state,
  selected,
  onPick,
  onClear,
  onNew,
  onEdit,
  className,
}: {
  state: BoardFeatureState
  /** The values the picture carries, of this feature. */
  selected: readonly BoardValue[]
  onPick: (value: BoardValue) => void
  onClear: (value: BoardValue) => void
  /** Asks for a new value's name. */
  onNew: () => void
  /** Opens the Values editor on this feature. */
  onEdit: () => void
  className?: string
}) {
  const { feature, values } = state
  const chosen = new Set(selected.map((value) => value.id))
  const summary = selected.map((value) => value.text).join(", ")
  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger
        render={
          <Button size="small" className={cx("max-w-full justify-between gap-1.5", className)}>
            <span className={cx("truncate", summary === "" && "text-text-secondary")}>
              {summary === "" ? "None" : summary}
            </span>
            <ChevronDownIcon16 className="shrink-0 text-text-secondary" />
          </Button>
        }
      />
      <DropdownMenu.Content align="start" width={224}>
        {values.map((value) => (
          <DropdownMenu.Item
            key={value.id}
            selected={chosen.has(value.id)}
            closeOnClick={feature.multi ? false : undefined}
            onClick={() => (chosen.has(value.id) ? onClear(value) : onPick(value))}
          >
            {value.text.trim() || "Untitled"}
          </DropdownMenu.Item>
        ))}
        {values.length > 0 ? <DropdownMenu.Separator /> : null}
        <DropdownMenu.Item icon={<PlusIcon16 />} onClick={onNew}>
          New {feature.label.trim().toLowerCase() || "value"}
        </DropdownMenu.Item>
        {values.length > 0 ? (
          <DropdownMenu.Item icon={<EditIcon16 />} onClick={onEdit}>
            Edit values
          </DropdownMenu.Item>
        ) : null}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
