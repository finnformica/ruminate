import type { MouseEvent } from "react"
import { useCopied } from "../../hooks/copied"
import { cx } from "../../utils/cx"
import { CheckIcon16, CopyIcon16 } from "../icons"
import { IconButton } from "../ui/icon-button"

/**
 * **Copy a piece of code** — a code block's text (`code-panel.tsx`) or an
 * inline code chip's (`block-content.tsx`) — shown while the pointer is over
 * it, and a tick for a moment once it has copied. A button, so the row's
 * surface treats it as a control (`block-item.tsx`): a click on it never
 * selects or opens the row.
 */
export function CopyCodeButton({
  text,
  icon,
  className,
}: {
  text: string
  /** Classes for the icon (a smaller one in an inline chip). */
  icon?: string
  className?: string
}) {
  const [copyText, copied] = useCopied()
  return (
    <IconButton
      size="small"
      tabIndex={-1}
      tooltipSide="top"
      aria-label={copied ? "Copied" : "Copy code"}
      data-testid="copy-code"
      onMouseDown={(event: MouseEvent) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation()
        copyText(text)
      }}
      className={cx("rounded-sm px-1.5", className)}
    >
      {copied ? <CheckIcon16 className={icon} /> : <CopyIcon16 className={icon} />}
    </IconButton>
  )
}
