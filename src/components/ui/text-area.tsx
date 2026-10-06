import type { VariantProps } from "class-variance-authority"
import React from "react"
import { cx } from "../../utils/cx"
import { textField } from "./text-input"

type TextAreaProps = React.ComponentPropsWithoutRef<"textarea"> &
  Omit<VariantProps<typeof textField>, "invalid"> & {
    invalid?: boolean
  }

/** Whether the browser sizes a field to its content on its own
 * (`field-sizing: content`); where it does not, the height is set by hand. */
const sizesToContent = (): boolean =>
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("field-sizing", "content")

/** The field as tall as its text, for a browser without `field-sizing`. */
function fitToContent(element: HTMLTextAreaElement): void {
  if (sizesToContent()) return
  element.style.height = "auto"
  element.style.height = `${element.scrollHeight}px`
}

/**
 * A multi-line text field that wraps and grows with its text: one row to
 * start, no resize handle, and the same recipe as `TextInput` — the
 * bordered box, or `flush`. The browser sizes it to its content
 * (`field-sizing: content`); where that is not supported the height is set
 * from the text's own height, on every input and whenever the value is
 * set from outside.
 */
export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ className, variant, invalid, rows = 1, value, onInput, ...props }, ref) => {
    const inner = React.useRef<HTMLTextAreaElement | null>(null)
    React.useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement)
    React.useLayoutEffect(() => {
      if (inner.current) fitToContent(inner.current)
    }, [value])
    return (
      <textarea
        ref={inner}
        rows={rows}
        value={value}
        className={cx(
          textField({ variant, invalid: Boolean(invalid) }),
          "block min-h-8 resize-none py-1.5 leading-5 [field-sizing:content] coarse:min-h-10 coarse:py-2.5",
          className,
        )}
        onInput={(event) => {
          fitToContent(event.currentTarget)
          onInput?.(event)
        }}
        {...props}
      />
    )
  },
)
