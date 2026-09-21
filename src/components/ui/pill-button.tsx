import { cva, type VariantProps } from "class-variance-authority"
import React from "react"
import { cx } from "../../utils/cx"

const pillButton = cva(
  // `focus-ring` is the app-wide focus treatment (a 2px inset accent ring);
  // the border also goes solid so a dashed pill reads as focused at its edge
  // too.
  "focus-ring inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full border bg-clip-border px-2 font-sans focus-visible:border-solid focus-visible:border-border-focus coarse:h-8 coarse:gap-2 coarse:px-3",
  {
    variants: {
      variant: {
        dashed:
          "border-dashed border-border bg-transparent text-text-secondary hover:bg-bg-hover active:bg-bg-active",
        secondary:
          "border-transparent bg-bg-secondary hover:bg-bg-secondary-hover active:bg-bg-secondary-active",
        // The inverted pill answers the pointer like every other control: it
        // had no hover or press at all, so an applied scope pill was inert.
        primary:
          "border-transparent bg-text text-bg hover:bg-text-secondary active:bg-text-tertiary",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
)

type PillButtonProps = React.ComponentPropsWithoutRef<"button"> &
  VariantProps<typeof pillButton> & {
    children: React.ReactNode
    className?: string
  }

export const PillButton = React.forwardRef<HTMLButtonElement, PillButtonProps>(
  ({ children, className, variant, ...props }, ref) => {
    return (
      <button ref={ref} className={cx(pillButton({ variant }), className)} {...props}>
        {children}
      </button>
    )
  },
)
