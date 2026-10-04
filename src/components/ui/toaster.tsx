import React from "react"
import { Toaster as SonnerToaster, type ToasterProps } from "sonner"
import { CheckFillIcon16, ErrorFillIcon16, ErrorIcon16, LoadingIcon16 } from "../icons"

/**
 * The app's toasts: sonner's `Toaster`, drawn in the app's own colours. It is
 * mounted once, in `src/routes/_appRoot.tsx`; raise a toast with `toast`
 * from sonner ("Toasts" in docs/design-principles.md says which kind).
 *
 * A toast is a popup-tier surface that says one of three things, and its
 * colour says which before its words do:
 *
 * - `toast(message)` — a notice: nothing happened, and why. The popup
 *   surface, in the page's ink.
 * - `toast.success(message)` — it happened, where the page itself does not
 *   show it. The success green: a wash of the ramp's solid step over the
 *   surface, the ramp's text step for the ink, as the selection wash is
 *   built (docs/design-principles.md, Colour roles).
 * - `toast.error(message)` — it failed. The same, in the danger red.
 *
 * sonner's own `warning` and `info` kinds are drawn too — the pending yellow
 * and the plain notice — so a stray one is never its default blue.
 *
 * sonner paints each kind from a set of custom properties it reads off the
 * toaster (`--success-bg`, `--error-text` and so on, under `richColors`), so
 * the app's tokens are handed to it there, inline, where they win over the
 * stylesheet's own values. The ramps flip with `data-theme` like every other
 * token, so sonner's light and dark sets are both overridden by the one set
 * below. The icons are the app's, the ones the sync status pairs with the
 * same inks.
 */
export function Toaster(props: ToasterProps) {
  return (
    <SonnerToaster
      richColors
      closeButton
      duration={6000}
      icons={{
        success: <CheckFillIcon16 />,
        error: <ErrorFillIcon16 />,
        warning: <ErrorFillIcon16 />,
        info: <ErrorIcon16 />,
        loading: <LoadingIcon16 />,
      }}
      toastOptions={{
        classNames: {
          // The popup tier's blur behind the translucent surface, and its
          // shadow. The shadow is marked important: sonner sets its own on
          // the same element from a stylesheet rule a class cannot outrank.
          toast: "backdrop-blur-lg shadow-popup!",
        },
      }}
      {...props}
      style={{ ...COLORS, fontFamily: "inherit", ...props.style }}
    />
  )
}

/** A wash of a ramp's solid step over the popup surface: the recipe the
 * selection wash uses, so a coloured toast reads lit rather than painted. */
const wash = (ramp: string) =>
  `color-mix(in srgb, var(--${ramp}-9) 13%, var(--color-bg-overlay-backdrop))`

/** sonner's colour properties (its stylesheet's `--normal-*` and, under
 * `richColors`, `--<kind>-*`), from the app's tokens. */
const COLORS = {
  "--border-radius": "var(--border-radius-lg)",
  "--normal-bg": "var(--color-bg-overlay-backdrop)",
  "--normal-border": "var(--neutral-a3)",
  "--normal-text": "var(--color-text)",
  "--normal-bg-hover": "var(--color-bg-hover)",
  "--normal-border-hover": "var(--color-border)",
  // The close button's hover, which sonner draws from its own greys.
  "--gray2": "var(--color-bg-hover)",
  "--gray5": "var(--color-border)",
  "--success-bg": wash("green"),
  "--success-border": "var(--green-a6)",
  "--success-text": "var(--color-text-success)",
  "--error-bg": wash("red"),
  "--error-border": "var(--red-a6)",
  "--error-text": "var(--color-text-danger)",
  "--warning-bg": wash("yellow"),
  "--warning-border": "var(--yellow-a6)",
  "--warning-text": "var(--color-text-pending)",
  "--info-bg": "var(--color-bg-overlay-backdrop)",
  "--info-border": "var(--neutral-a3)",
  "--info-text": "var(--color-text)",
} as React.CSSProperties
