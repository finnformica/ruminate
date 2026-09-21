import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import React from "react"
import { cx } from "../../utils/cx"
import { XIcon16 } from "../icons"
import { IconButton } from "./icon-button"
import { Surface } from "./surface"

type ContentProps = Omit<BaseDialog.Popup.Props, "title"> & {
  title: React.ReactNode
}

/**
 * A dialog's window: the modal surface, a titled header with the close
 * control, and the body scrolling beneath it.
 *
 * Base UI holds the dialog — focus is trapped, the page behind is locked and
 * inert, <kbd>Esc</kbd> and the close control put it away — and the surface
 * arrives and leaves with the app's own motion. A scrim dims the page a
 * little behind it, so the page steps back and the window comes forward; it
 * fades with the window. The close control is inside the popup, which Base
 * UI asks for so that a touch screen reader can escape the dialog.
 */
function Content({ title, className, children, ...props }: ContentProps) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-modal bg-bg-scrim transition-opacity duration-base data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <BaseDialog.Popup
        render={<Surface tier="modal" />}
        className={cx(
          "fixed left-1/2 top-1/2 z-modal grid max-h-[75vh] w-[calc(100vw-24px)] max-w-md -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_1fr] overflow-hidden focus:outline-hidden",
          className,
        )}
        {...props}
      >
        <div className="flex h-12 items-center justify-between border-b border-border-secondary px-4">
          <BaseDialog.Title className="font-bold">{title}</BaseDialog.Title>
          <BaseDialog.Close
            render={
              <IconButton
                aria-label="Close"
                className="-m-2 coarse:-m-3 coarse:rounded-lg"
                disableTooltip
              />
            }
          >
            <XIcon16 />
          </BaseDialog.Close>
        </div>
        <div className="overflow-auto p-4">{children}</div>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  )
}

export const Dialog = Object.assign(BaseDialog.Root, {
  Trigger: BaseDialog.Trigger,
  Close: BaseDialog.Close,
  Content,
})
