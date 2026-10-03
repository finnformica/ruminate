import React from "react"
import { createPortal } from "react-dom"
import { cx } from "../../utils/cx"
import { FloatingHostContext } from "./layer"
import { Surface } from "./surface"

/**
 * **A bar that floats at the foot of the page** — the selection bar over
 * a run of selected rows, a board's add buttons once the ones on the page
 * have scrolled away — centred, and with one arrival and one departure for
 * every such bar: it rises a few pixels into its place under a fade, and
 * sinks back out the same way (docs/design-principles.md, "Motion").
 *
 * It is placed in the page's own box (`FloatingHostContext`, which
 * `PageLayout` provides), so it clears whatever the app draws beneath the
 * page — the phone's nav bar, the sign-in banner — without knowing the
 * height of either; outside a page it floats over the window instead.
 *
 * Kept mounted and hidden rather than unmounted, so the departure has
 * something to play on: the browser's discrete `display` transition holds
 * it on screen for the fade, and `@starting-style` gives it the arrival —
 * the same two moments `Surface` uses for a popup nothing holds. The bar
 * is a `toolbar` named by `label`; whatever else the outer element should
 * carry (a data attribute a test finds it by) comes through the rest of
 * the props.
 */
export function FloatingBar({
  open,
  label,
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  open: boolean
  /** The toolbar's accessible name. */
  label: string
  /** Classes for the surface itself, around the children. */
  className?: string
}) {
  const host = React.useContext(FloatingHostContext)
  if (typeof document === "undefined") return null
  return createPortal(
    <div
      role="toolbar"
      aria-label={label}
      aria-hidden={!open || undefined}
      {...props}
      className={cx(
        "pointer-events-none inset-x-0 bottom-4 z-raised flex justify-center px-4 print:hidden",
        host ? "absolute" : "fixed",
        // The arrival and the departure: a fade, and (where motion is
        // welcome) a short rise from below. The `display` flip is discrete,
        // so the bar stays on screen until the exit has played.
        "transition-[opacity,translate,display] transition-discrete duration-base ease-(--ease-out-strong)",
        "starting:opacity-0 motion-safe:starting:translate-y-3",
        !open && "hidden opacity-0 motion-safe:translate-y-3",
      )}
    >
      <Surface
        tier="popup"
        motion={false}
        className={cx("pointer-events-auto flex items-center gap-0.5 p-1 text-sm", className)}
      >
        {children}
      </Surface>
    </div>,
    host ?? document.body,
  )
}
