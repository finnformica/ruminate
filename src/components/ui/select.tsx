import { Select as BaseSelect } from "@base-ui/react/select"
import React from "react"
import { cx } from "../../utils/cx"
import { CheckIcon16, ChevronDownIcon16 } from "../icons"
import { InModalContext } from "./layer"
import { listRow } from "./list"
import { Surface } from "./surface"
import { textField } from "./text-input"

export interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  options: readonly SelectOption[]
  id?: string
  disabled?: boolean
  className?: string
  "aria-label"?: string
}

/**
 * One choice from a fixed list: the shadcn Select on Base UI. The trigger
 * is a text field's box (`textField`) with the chosen label and a chevron;
 * the list is a popup `Surface` of `listRow`s, the chosen row ticked. It
 * floats in a dialog's layer when it opens inside one, as a menu does
 * (src/components/ui/dropdown-menu.tsx).
 */
export function Select({
  value,
  onValueChange,
  options,
  id,
  disabled,
  className,
  "aria-label": ariaLabel,
}: SelectProps) {
  const inModal = React.useContext(InModalContext)
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(next)
      }}
      items={options}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cx(
          textField(),
          "flex h-8 cursor-pointer items-center justify-between gap-2 text-left data-disabled:cursor-not-allowed data-disabled:opacity-50 coarse:h-10",
          className,
        )}
      >
        <BaseSelect.Value />
        <BaseSelect.Icon className="flex text-text-secondary">
          <ChevronDownIcon16 />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner className={inModal ? "z-modal" : "z-popup"} sideOffset={4}>
          <BaseSelect.Popup
            render={<Surface />}
            className="max-h-[min(var(--available-height),20rem)] min-w-[var(--anchor-width)] overflow-y-auto p-1 outline-hidden"
          >
            {options.map((option) => (
              <BaseSelect.Item key={option.value} value={option.value} className={listRow()}>
                <BaseSelect.ItemText className="grow">{option.label}</BaseSelect.ItemText>
                <BaseSelect.ItemIndicator className="flex">
                  <CheckIcon16 />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
