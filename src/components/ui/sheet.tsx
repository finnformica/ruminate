import React from "react"
import { Drawer } from "vaul"
import { cx } from "../../utils/cx"

/**
 * A sheet: the panel that slides up from the bottom of a phone's screen.
 *
 * Three of them — the phone's navigation, the help panel, a block's menu —
 * each carried a copy of the scrim and the panel. The scrim, the panel's
 * surface, its layer and its safe-area padding are here once; a sheet says
 * how tall it is, whether it shows a drag handle and whether its title is
 * read or seen. vaul (a Radix-based drawer) still does the sliding and the
 * swipe: it is the one place the app keeps something other than Base UI,
 * because its touch physics are the reason to have a sheet at all.
 */

type ContentProps = Omit<React.ComponentPropsWithoutRef<typeof Drawer.Content>, "title"> & {
  /** Read by assistive technology; shown too when `titleVisible`. */
  title: React.ReactNode
  titleVisible?: boolean
  /** A drag handle at the top. */
  handle?: boolean
  /** `tall` takes most of the screen; `fit` takes what its content needs. */
  size?: "tall" | "fit"
}

function Root(props: React.ComponentProps<typeof Drawer.Root>) {
  return <Drawer.Root shouldScaleBackground={false} {...props} />
}

function Content({
  title,
  titleVisible = false,
  handle = false,
  size = "tall",
  className,
  children,
  ...props
}: ContentProps) {
  return (
    <Drawer.Portal>
      <Drawer.Overlay className="fixed inset-0 z-modal bg-linear-to-t from-[#000000] to-[#00000000]" />
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
        <Drawer.Title
          className={
            titleVisible ? "truncate px-5 pt-3 pb-1 text-sm text-text-secondary" : "sr-only"
          }
        >
          {title}
        </Drawer.Title>
        {children}
      </Drawer.Content>
    </Drawer.Portal>
  )
}

export const Sheet = Object.assign(Root, {
  Trigger: Drawer.Trigger,
  Content,
})
