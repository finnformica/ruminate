import { cva, type VariantProps } from "class-variance-authority"
import React from "react"
import { cx } from "../../utils/cx"

/**
 * The dress of a search field: the tall, filled, rounded box with room on the
 * left for its glass and, when something has been typed, room on the right
 * for the control that clears it. Worn by the plain filter box (SearchInput)
 * and by the Views page's query box, which are one control to the eye and
 * were two copies of this in the code.
 *
 * The recipe is exported for the query box, whose one input is dressed
 * differently in the palette and so cannot be this element outright.
 */
export const searchField = cva(
  "focus-ring h-10 w-full rounded-lg bg-bg-secondary pl-10 [-webkit-appearance:none] [font-variant-numeric:inherit] placeholder:text-text-secondary coarse:h-12 coarse:pl-11 [&:not(:focus-visible)]:hover:ring-1 [&:not(:focus-visible)]:hover:ring-inset [&:not(:focus-visible)]:hover:ring-border-secondary",
  {
    variants: {
      /** Whether a control sits at the right end, which the text keeps clear of. */
      trailing: {
        true: "pr-10 coarse:pr-12",
        false: "pr-3 coarse:pr-4",
      },
    },
    defaultVariants: { trailing: false },
  },
)

type SearchFieldProps = React.ComponentPropsWithoutRef<"input"> & VariantProps<typeof searchField>

export const SearchField = React.forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField({ trailing, className, type = "search", ...props }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cx(searchField({ trailing }), className)}
        {...props}
      />
    )
  },
)
