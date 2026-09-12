import React from "react"
import { Keys } from "./keys"
import { cx } from "../utils/cx"

export type ButtonProps = React.ComponentPropsWithoutRef<"button"> & {
  variant?: "secondary" | "primary"
  size?: "small" | "medium"
  shortcut?: string[]
  /**
   * The chosen one of several (a segmented control, a settings picker). Painted
   * with the app-wide selected tokens — the very surface and ink the sidebar's
   * current row uses — so "chosen" means one thing everywhere. Not a ring:
   * `focus-ring` already owns the ring on anything focusable, and a selected
   * ring in the accent was indistinguishable from a focus ring in the accent.
   * See "Selection has its own color" in docs/design-principles.md.
   */
  selected?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = "secondary", size = "medium", shortcut, selected, className, children, ...props },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type="button"
        className={cx(
          "focus-ring inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded leading-4",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "coarse:h-10 coarse:px-4",
          variant === "secondary" &&
            !selected &&
            "bg-bg-secondary enabled:hover:bg-bg-secondary-hover enabled:active:bg-bg-secondary-active",
          variant === "secondary" &&
            selected &&
            "bg-bg-selected font-bold text-text-selected enabled:hover:bg-bg-selected-hover enabled:active:bg-bg-selected-active",
          // The inverted button had no hover or press at all: it stepped down
          // the ink ramp for both, so it answers the pointer like every other
          // control.
          variant === "primary" &&
            "bg-text font-bold text-bg [&_*]:text-bg enabled:hover:bg-text-secondary enabled:active:bg-text-tertiary",
          size === "small" && "h-6 px-2",
          size === "medium" && "h-8 px-3",
          className,
        )}
        {...props}
      >
        {children}
        {shortcut ? (
          <span className="coarse:hidden">
            <Keys keys={shortcut} />
          </span>
        ) : null}
      </button>
    )
  },
)
