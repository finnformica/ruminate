import { cva, type VariantProps } from "class-variance-authority"
import React from "react"
import { cx } from "../../utils/cx"
import { Keys } from "./keys"
import { Tooltip } from "./tooltip"

const iconButton = cva(
  "focus-ring inline-flex cursor-pointer select-none items-center justify-center rounded text-text-secondary enabled:hover:bg-bg-hover enabled:active:bg-bg-active data-[popup-open]:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50 coarse:h-10 coarse:px-3",
  {
    variants: {
      size: {
        small: "h-6 px-2",
        medium: "h-8 px-2",
      },
    },
    defaultVariants: { size: "medium" },
  },
)

export type IconButtonProps = React.ComponentPropsWithoutRef<"button"> &
  VariantProps<typeof iconButton> & {
    "aria-label": string // Required for accessibility
    shortcut?: string[]
    tooltipSide?: "top" | "bottom" | "left" | "right"
    tooltipAlign?: "start" | "center" | "end"
    tooltipSideOffset?: number
    disableTooltip?: boolean
  }

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      className,
      children,
      shortcut,
      size,
      tooltipSide = "bottom",
      tooltipAlign = "center",
      tooltipSideOffset,
      disableTooltip = false,
      ...props
    },
    ref,
  ) => {
    const trigger = (
      <button ref={ref} type="button" className={cx(iconButton({ size }), className)} {...props}>
        {children}
      </button>
    )

    return (
      <Tooltip open={disableTooltip ? false : undefined}>
        <Tooltip.Trigger render={trigger} />
        <Tooltip.Content side={tooltipSide} align={tooltipAlign} sideOffset={tooltipSideOffset}>
          <div className="flex items-center gap-1.5">
            <span>{props["aria-label"]}</span>
            {shortcut ? (
              <div className="flex text-text-secondary coarse:hidden">
                <Keys keys={shortcut} />
              </div>
            ) : null}
          </div>
        </Tooltip.Content>
      </Tooltip>
    )
  },
)
