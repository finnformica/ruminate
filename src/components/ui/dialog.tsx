import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import React from "react"
import { cx } from "../../utils/cx"
import { XIcon16 } from "../icons"
import { IconButton } from "./icon-button"
import { InModalContext } from "./layer"
import { Surface } from "./surface"

type ContentProps = Omit<BaseDialog.Popup.Props, "title"> & {
  title: React.ReactNode
  /** Controls that act on what the dialog shows, in the header beside the
   * close control (`IconButton`s, as the close control is). */
  actions?: React.ReactNode
}

/**
 * A dialog's window: the modal surface, a titled header with the close
 * control — and, before it, any `actions` that act on what the dialog
 * shows — and the body scrolling beneath it.
 *
 * Base UI holds the dialog — focus is trapped, the page behind is locked and
 * inert, <kbd>Esc</kbd> and the close control put it away — and the surface
 * arrives and leaves with the app's own motion. A scrim dims the page a
 * little behind it, so the page steps back and the window comes forward; it
 * fades with the window. The close control is inside the popup, which Base
 * UI asks for so that a touch screen reader can escape the dialog. What
 * the body holds is told it is in the modal layer (`InModalContext`), so a
 * menu opened from it floats above the window rather than behind it.
 */
function Content({ title, actions, className, children, ...props }: ContentProps) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-modal bg-bg-scrim transition-opacity duration-base data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <BaseDialog.Popup
        render={<Surface tier="modal" />}
        className={cx(
          // The one column is `minmax(0,1fr)`, not `auto`: an auto column grows to
          // its content, and a title kept to one line would widen the window
          // past the screen rather than be cut.
          "fixed left-1/2 top-1/2 z-modal grid max-h-[75vh] w-[calc(100vw-24px)] max-w-md -translate-x-1/2 -translate-y-1/2 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] overflow-hidden focus:outline-hidden",
          className,
        )}
        {...props}
      >
        <div className="flex h-12 items-center justify-between gap-3 border-b border-border-secondary px-4">
          {/* One line, however long the title: the controls keep their
              room and the title is cut with an ellipsis. */}
          <BaseDialog.Title className="min-w-0 flex-1 truncate font-bold">{title}</BaseDialog.Title>
          {/* The controls pull into the header's padding as the close
              control does, so the actions sit level with it. */}
          <div className="-m-2 flex shrink-0 items-center gap-1 coarse:-m-3 coarse:gap-2">
            {actions}
            <BaseDialog.Close
              render={
                <IconButton aria-label="Close" className="coarse:rounded-lg" disableTooltip />
              }
            >
              <XIcon16 />
            </BaseDialog.Close>
          </div>
        </div>
        <div className="overflow-auto p-4">
          <InModalContext.Provider value={true}>{children}</InModalContext.Provider>
        </div>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  )
}

export const Dialog = Object.assign(BaseDialog.Root, {
  Trigger: BaseDialog.Trigger,
  Close: BaseDialog.Close,
  Content,
})
