import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox"
import React from "react"
import { cx } from "../../utils/cx"
import { CheckIcon8 } from "../icons"

type CheckboxProps = Omit<BaseCheckbox.Root.Props, "render" | "nativeButton">

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ className, ...props }, ref) => (
    <BaseCheckbox.Root
      ref={ref}
      // A native button rather than Base UI's span, as in its own labelling
      // example: a button is labelable, so a <label htmlFor> beside the box
      // toggles it (src/components/mcp-tokens-section.tsx).
      nativeButton
      render={<button type="button" />}
      className={cx(
        "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-text-secondary bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-border-focus data-checked:border-border-focus data-checked:bg-border-focus data-unchecked:hover:bg-bg-hover coarse:size-5",
        className,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator>
        <CheckIcon8 className="text-bg coarse:size-2.5" />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  ),
)

Checkbox.displayName = "Checkbox"
