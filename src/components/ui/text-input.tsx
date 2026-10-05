import { cva, type VariantProps } from "class-variance-authority"
import React from "react"
import { cx } from "../../utils/cx"

/**
 * The one recipe for a text field, shared by `TextInput` and `TextArea`:
 * the default is a bordered box; `flush` is the same field with no box of
 * its own — transparent until the pointer or the focus finds it — for a
 * field that sits in a table's cell as its text rather than as a control.
 */
export const textField = cva(
  // `focus-ring` is the one focus treatment every control wears; this had a
  // 2px inset outline of its own that looked the same and was not.
  "focus-ring w-full rounded bg-transparent px-2.5 [-webkit-appearance:none] [font-variant-numeric:inherit] placeholder:text-text-secondary focus-visible:bg-transparent coarse:px-3",
  {
    variants: {
      variant: {
        default: "border border-border",
        flush: "border-0 hover:bg-bg-hover",
      },
      invalid: {
        true: "border-text-danger focus-visible:ring-text-danger",
        false: "",
      },
    },
    defaultVariants: { variant: "default", invalid: false },
  },
)

type TextInputProps = React.ComponentPropsWithoutRef<"input"> &
  Omit<VariantProps<typeof textField>, "invalid"> & {
    invalid?: boolean
  }

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(
  ({ type = "text", className, variant, invalid, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cx(
          textField({ variant, invalid: Boolean(invalid) }),
          "h-8 coarse:h-10",
          className,
        )}
        type={type}
        {...props}
      />
    )
  },
)
