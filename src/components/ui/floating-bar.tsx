import { cva } from "class-variance-authority"
import React from "react"
import { createPortal } from "react-dom"
import { cx } from "../../utils/cx"
import { FloatingHostContext } from "./layer"

/**
 * **The floating pill a touch screen gets** — Notion's shape: a full-width
 * capsule of 38px glyph buttons on an opaque surface, the card's ring and
 * shadow, 6px of padding at either end that is the pill's rather than a
 * button's. The edit bar above the keyboard (`mobile-edit-bar.tsx`) is one;
 * a board's add buttons, once the ones on the page have scrolled away, are
 * another. The recipe is the chrome; `FloatingBar` below is the one that
 * floats at the foot of the page and comes and goes, and `FloatingBarButton`
 * is the button either holds.
 */
export const floatingBar = cva(
  // Opaque rather than blurred: the bar sits over content as much as over
  // the keyboard, and content showing through would muddle the glyphs.
  "flex h-12 items-stretch overflow-hidden rounded-full bg-bg-overlay px-1.5 shadow-2xl ring-1 ring-[var(--neutral-a3)] dark:ring-inset",
)

/** A tap on a bar must not take focus from what the bar is about (an
 * editing textarea, say), so the press is cancelled; the click still fires. */
const keepFocus = (event: React.SyntheticEvent) => event.preventDefault()

/**
 * A glyph button in a floating bar: 38px wide, the bar's full height, greyed
 * and inert when its action would do nothing right now. `enter` and `index`
 * are the edit bar's entrances (block-editor.css): how the button arrives
 * when its row does, and its beat in the cascade.
 */
export function FloatingBarButton({
  label,
  onClick,
  pressed,
  disabled,
  enter,
  index = 0,
  className,
  children,
}: {
  label: string
  onClick: () => void
  /** The row's current choice (the Turn into row's current type). */
  pressed?: boolean
  /** Would do nothing right now: greyed, and inert, as its key would be. */
  disabled?: boolean
  /** How the button arrives when its row does: `morph` in place, growing
   * from the glyph that was there; `cascade` sliding in from the side the
   * row came from, each a beat after the last; `rise` up from beneath. */
  enter?: "morph" | "cascade" | "rise"
  /** The button's place in its cascade: its delay. */
  index?: number
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={disabled ? undefined : onClick}
      data-enter={enter}
      style={enter ? ({ "--edit-bar-i": index } as React.CSSProperties) : undefined}
      className={cx(
        "edit-bar-button flex h-12 w-[38px] shrink-0 cursor-pointer select-none items-center justify-center text-text-secondary",
        // Greying in and out eases rather than snaps; the press itself is
        // on the glyph (block-editor.css).
        "transition-[color,opacity] duration-200 ease-out motion-reduce:transition-none",
        disabled ? "cursor-default text-text-tertiary opacity-50" : "active:text-text",
        pressed && "text-text",
        className,
      )}
    >
      {children}
    </button>
  )
}

/**
 * **A pill floating at the foot of the page**, that comes and goes: it
 * slides up from beneath the page's edge under a fade, at the pace of a
 * hand (300ms, `--ease-out-strong`), and slides back down the same way
 * (docs/design-principles.md, "Motion"). Kept mounted while closed, hidden
 * rather than unmounted, so the departure has something to play on; the
 * `visibility` flip waits for it, and takes the buttons out of reach.
 *
 * Placed in the page's own box (`FloatingHostContext`, which `PageLayout`
 * provides), so it clears whatever the app draws beneath the page — the
 * phone's nav bar, the sign-in banner — without knowing the height of
 * either; outside a page it floats over the window instead. Full width on a
 * phone, as the edit bar is; its own width, centred, on a wide screen.
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
  /** Classes for the pill itself, around the children. */
  className?: string
}) {
  const host = React.useContext(FloatingHostContext)
  if (typeof document === "undefined") return null
  return createPortal(
    <div
      role="toolbar"
      aria-label={label}
      aria-hidden={!open || undefined}
      data-open={open ? "" : undefined}
      {...props}
      className={cx(
        "pointer-events-none inset-x-3 bottom-3 z-popup flex justify-center print:hidden",
        host ? "absolute" : "fixed",
      )}
    >
      <div
        className={cx(
          floatingBar(),
          "pointer-events-auto w-full will-change-transform sm:w-auto",
          // The arrival and the departure: a slide from below the page's
          // edge under a fade, and the same back. Visibility flips at once
          // on the way in and after the slide on the way out.
          "transition-[transform,opacity,visibility] duration-slow ease-(--ease-out-strong) motion-reduce:transition-none",
          open
            ? "visible translate-y-0 opacity-100"
            : "invisible translate-y-[calc(100%+12px)] opacity-0 [transition-delay:0s,0s,var(--duration-slow)]",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    host ?? document.body,
  )
}
