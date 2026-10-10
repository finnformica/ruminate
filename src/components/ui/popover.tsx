import { Popover as BasePopover } from "@base-ui/react/popover"
import React from "react"
import { cx } from "../../utils/cx"
import { InModalContext } from "./layer"
import { Surface } from "./surface"

type ContentProps = {
  /** What the popup hangs off: an element, where there is no trigger (a
   * row of the editor a slash command was typed in). Left out, the
   * trigger. */
  anchor?: Element | null
  side?: "top" | "bottom" | "left" | "right"
  sideOffset?: number
  align?: "start" | "center" | "end"
  /** A fixed width, inline; left out, the popup is `w-64`. */
  width?: number | string
  className?: string
  /** Where the keyboard goes when the popup opens: a control inside it. */
  initialFocus?: BasePopover.Popup.Props["initialFocus"]
  /** Where the keyboard goes when the popup closes. */
  finalFocus?: BasePopover.Popup.Props["finalFocus"]
  children?: React.ReactNode
}

/**
 * A popover: a small surface hung off an anchor, holding controls rather
 * than a menu's rows — a search box and a list that answers it (the board
 * picker, `board-picker.tsx`). Base UI holds it (an outside press or
 * <kbd>Esc</kbd> puts it away; the keyboard goes where `initialFocus`
 * says), and it is drawn on the same surface as every other popup. Opened
 * from inside a dialog it floats in the dialog's layer. Where a menu's
 * rows are what is wanted, `DropdownMenu` is the primitive; where the
 * popup only shows, `HoverCard`.
 */
function Content({
  anchor,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  width,
  className,
  initialFocus,
  finalFocus,
  children,
}: ContentProps) {
  const inModal = React.useContext(InModalContext)
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        className={inModal ? "z-modal" : "z-popup"}
        anchor={anchor}
        side={side}
        sideOffset={sideOffset}
        align={align}
      >
        <BasePopover.Popup
          render={<Surface className="w-64 overflow-hidden print:hidden outline-hidden" />}
          className={cx(className)}
          style={{ width }}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  )
}

export const Popover = Object.assign(BasePopover.Root, {
  Trigger: BasePopover.Trigger,
  Content,
})
