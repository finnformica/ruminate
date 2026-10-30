import React from "react"
import { Drawer } from "vaul"
import { cx } from "../../utils/cx"
import { XIcon16 } from "../icons"
import { IconButton } from "./icon-button"
import { InModalContext } from "./layer"

/**
 * A sheet: the panel that slides up from the bottom of a phone's screen.
 *
 * Three of them — the phone's navigation, the help panel, a block's menu —
 * each carried a copy of the scrim and the panel. The scrim, the panel's
 * surface, its layer and its safe-area padding are here once; a sheet says
 * how tall it is, whether it shows a drag handle and whether its title is
 * read, seen as a caption, or seen in a title bar — the dialog's own header,
 * with the close control and any `actions` beside it, for a sheet that is
 * the phone's form of a dialog. vaul (a Radix-based drawer) still does the sliding and the
 * swipe: it is the one place the app keeps something other than Base UI,
 * because its touch physics are the reason to have a sheet at all.
 *
 * vaul's own modal mode is off. A Radix modal sets `pointer-events: none`
 * on the body and pulls focus back into its own element, and a Base UI menu
 * or dialog opened from the sheet sits outside that element, in the page:
 * it opened but took no tap. So the sheet draws its scrim itself, and a tap
 * on the scrim puts the sheet away, as a modal's did. What the sheet holds
 * is told it is in the modal layer (`InModalContext`), so a menu opened from
 * it floats above the sheet rather than behind it.
 */

type ContentProps = Omit<React.ComponentPropsWithoutRef<typeof Drawer.Content>, "title"> & {
  /** Read by assistive technology; shown too when `titleVisible`, or in
   * the title bar when `titleBar`. */
  title: React.ReactNode
  titleVisible?: boolean
  /** A header as the dialog's: the title in bold, the close control, and
   * before it any `actions` that act on what the sheet shows. */
  titleBar?: boolean
  actions?: React.ReactNode
  /** A drag handle at the top. */
  handle?: boolean
  /** `tall` takes most of the screen; `fit` takes what its content needs. */
  size?: "tall" | "fit"
}

/** A sheet is always controlled: the caller holds whether it is open. */
type RootProps = {
  open: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}

/** Whether the sheet is open and how to put it away, for the scrim. */
const SheetContext = React.createContext<{ open: boolean; close: () => void }>({
  open: false,
  close: () => {},
})

function Root({ open, onOpenChange, children }: RootProps) {
  const context = React.useMemo(
    () => ({ open, close: () => onOpenChange?.(false) }),
    [open, onOpenChange],
  )
  return (
    <SheetContext.Provider value={context}>
      <Drawer.Root
        shouldScaleBackground={false}
        modal={false}
        open={open}
        onOpenChange={onOpenChange}
      >
        {children}
      </Drawer.Root>
    </SheetContext.Provider>
  )
}

function Content({
  title,
  titleVisible = false,
  titleBar = false,
  actions,
  handle = false,
  size = "tall",
  className,
  children,
  ...props
}: ContentProps) {
  const sheet = React.useContext(SheetContext)
  return (
    <Drawer.Portal>
      {/* vaul draws no overlay for a sheet that is not modal: this one is
          its scrim, with vaul's fade (`data-vaul-overlay`), and `touch-none`
          so a drag on it does not scroll the page beneath. Esc and the
          close control put the sheet away from the keyboard. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        aria-hidden
        data-vaul-overlay=""
        data-vaul-snap-points="false"
        data-state={sheet.open ? "open" : "closed"}
        className="fixed inset-0 z-modal touch-none bg-linear-to-t from-[#000000] to-[#00000000]"
        onClick={sheet.close}
      />
      <Drawer.Content
        className={cx(
          "fixed bottom-0 left-0 right-0 z-modal flex flex-col rounded-t-xl bg-bg-overlay outline-none",
          size === "tall" ? "h-[80%]" : "max-h-[85svh] pb-[env(safe-area-inset-bottom)]",
          className,
        )}
        {...props}
      >
        {handle ? (
          <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border" />
        ) : null}
        {titleBar ? (
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border-secondary px-4">
            <Drawer.Title className="min-w-0 flex-1 truncate font-bold">{title}</Drawer.Title>
            <div className="-m-2 flex shrink-0 items-center gap-1 coarse:-m-3 coarse:gap-2">
              {actions}
              <Drawer.Close
                asChild
                // eslint-disable-next-line jsx-a11y/no-autofocus
              >
                <IconButton aria-label="Close" className="coarse:rounded-lg" disableTooltip>
                  <XIcon16 />
                </IconButton>
              </Drawer.Close>
            </div>
          </div>
        ) : (
          <Drawer.Title
            className={
              titleVisible ? "truncate px-5 pt-3 pb-1 text-sm text-text-secondary" : "sr-only"
            }
          >
            {title}
          </Drawer.Title>
        )}
        <InModalContext.Provider value={true}>{children}</InModalContext.Provider>
      </Drawer.Content>
    </Drawer.Portal>
  )
}

export const Sheet = Object.assign(Root, {
  Trigger: Drawer.Trigger,
  Close: Drawer.Close,
  Content,
})
