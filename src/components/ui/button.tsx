import { cva, type VariantProps } from "class-variance-authority"
import React from "react"
import { cx } from "../../utils/cx"
import { LoadingIcon16 } from "../icons"
import { Keys } from "./keys"

const button = cva(
  // A busy button is disabled but not dimmed: it is working, not unavailable,
  // and its spinner says so (docs/design-principles.md, "Busy controls").
  "focus-ring inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded leading-4 disabled:cursor-not-allowed disabled:opacity-50 disabled:data-loading:cursor-progress disabled:data-loading:opacity-100 coarse:h-10 coarse:px-4",
  {
    variants: {
      variant: {
        secondary:
          "bg-bg-secondary enabled:hover:bg-bg-secondary-hover enabled:active:bg-bg-secondary-active",
        // The inverted button had no hover or press at all: it stepped down
        // the ink ramp for both, so it answers the pointer like every other
        // control.
        primary:
          "bg-text font-bold text-bg [&_*]:text-bg enabled:hover:bg-text-secondary enabled:active:bg-text-tertiary",
        // The strongest action when what it does cannot be taken back: the
        // one solid red in the app (docs/design-principles.md, Color roles).
        // A dialog's confirm (`ConfirmDialog`), never a button among others.
        danger:
          "bg-bg-danger font-bold text-text-on-danger [&_*]:text-text-on-danger enabled:hover:bg-bg-danger-hover enabled:active:bg-bg-danger-active",
      },
      size: {
        small: "h-6 px-2",
        medium: "h-8 px-3",
      },
      selected: {
        true: "",
        false: "",
      },
    },
    compoundVariants: [
      {
        variant: "secondary",
        selected: true,
        class:
          "bg-bg-selected font-bold text-text-selected enabled:hover:bg-bg-selected-hover enabled:active:bg-bg-selected-active",
      },
    ],
    defaultVariants: { variant: "secondary", size: "medium", selected: false },
  },
)

export type ButtonProps = React.ComponentPropsWithoutRef<"button"> &
  Omit<VariantProps<typeof button>, "selected"> & {
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
    /** A leading icon, before the label. Its slot is where the spinner goes. */
    icon?: React.ReactNode
    /**
     * The action the button starts is still in flight: the button is disabled
     * against a second press and says so (`aria-busy`), and its icon slot
     * spins — in place of its icon, or before the label if it has none — so
     * the label stays and the button keeps its width. Every control that
     * starts a request shows this until the request has settled; hold the
     * flag with `usePending` (src/hooks/pending.ts).
     */
    loading?: boolean
  }

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant, size, shortcut, selected, icon, loading, disabled, className, children, ...props },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        type="button"
        className={cx(button({ variant, size, selected: Boolean(selected) }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        data-loading={loading || undefined}
        {...props}
      >
        {loading ? <LoadingIcon16 /> : icon}
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
