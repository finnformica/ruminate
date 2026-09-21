import { cva, type VariantProps } from "class-variance-authority"
import React from "react"
import { cx } from "../../utils/cx"

const textInput = cva(
  // `focus-ring` is the one focus treatment every control wears; this had a
  // 2px inset outline of its own that looked the same and was not.
  "focus-ring h-8 w-full rounded border border-border bg-transparent px-2.5 [-webkit-appearance:none] [font-variant-numeric:inherit] placeholder:text-text-secondary focus-visible:bg-transparent coarse:h-10 coarse:px-3",
  {
    variants: {
      invalid: {
        true: "border-text-danger focus-visible:ring-text-danger",
        false: "",
      },
    },
    defaultVariants: { invalid: false },
  },
)

type TextInputProps = React.ComponentPropsWithoutRef<"input"> &
  Omit<VariantProps<typeof textInput>, "invalid"> & {
    invalid?: boolean
  }

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(
  ({ type = "text", className, invalid, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cx(textInput({ invalid: Boolean(invalid) }), className)}
        type={type}
        {...props}
      />
    )
  },
)
