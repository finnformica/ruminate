import { Switch as BaseSwitch } from "@base-ui/react/switch"
import React from "react"
import { cx } from "../../utils/cx"

type SwitchProps = Omit<BaseSwitch.Root.Props, "render" | "nativeButton">

/**
 * An on/off control for a setting that starts or stops something (the
 * habit reminders, src/components/settings/reminders-section.tsx), where a
 * checkbox reads as a choice in a form. The shadcn Switch on Base UI: a
 * track with a thumb, filled in the focus colour when on.
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className, ...props }, ref) => (
    <BaseSwitch.Root
      ref={ref}
      // A native button, as the checkbox is: a button is labelable, so a
      // <label htmlFor> beside the switch toggles it.
      nativeButton
      render={<button type="button" />}
      className={cx(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-text-tertiary p-0.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-border-focus data-checked:bg-border-focus data-disabled:cursor-not-allowed data-disabled:opacity-50 coarse:h-6 coarse:w-11",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="size-4 rounded-full bg-bg shadow-sm transition-transform data-checked:translate-x-4 coarse:size-5 coarse:data-checked:translate-x-5" />
    </BaseSwitch.Root>
  ),
)

Switch.displayName = "Switch"
