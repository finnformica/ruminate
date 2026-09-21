import React from "react"
import { usePending } from "../../hooks/pending"
import { Button, type ButtonProps } from "./button"

export type AsyncButtonProps = Omit<ButtonProps, "onClick" | "loading"> & {
  /** The click's work. While the promise it returns is in flight the button is `loading`. */
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => Promise<unknown> | void
}

/**
 * A Button that starts a request: busy — disabled, spinning in its icon slot
 * — from the click until the promise the click returns has settled, and deaf
 * to a second press meanwhile (docs/design-principles.md, "Busy controls").
 * For a control whose flight is held elsewhere (a form's submit, a state the
 * data layer reports), pass `loading` to Button instead.
 */
export const AsyncButton = React.forwardRef<HTMLButtonElement, AsyncButtonProps>(
  ({ onClick, ...props }, ref) => {
    const [run, pending] = usePending(onClick)
    return <Button ref={ref} loading={pending} onClick={run} {...props} />
  },
)
