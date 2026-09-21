import { cva, type VariantProps } from "class-variance-authority"
import React from "react"
import { cx } from "../../utils/cx"

/**
 * A raised surface: the one thing every card, menu, tooltip, hover card,
 * listbox, dialog and palette in the app is drawn on.
 *
 * It owns what those have in common and used to spell out for themselves:
 * the edge, the fill, the shadow and the radius of a tier of elevation, and
 * the motion it arrives and leaves with. A component that needs a surface
 * says which tier it is and nothing more. The tokens behind the tiers live in
 * src/styles/variables.css.
 *
 * What it does not own is the layer it floats in. Stacking belongs to the
 * element that is positioned — a Base UI `Positioner`, a fixed dialog, the
 * card's own absolutely placed box — because a z-index inside a positioned,
 * transformed wrapper orders nothing outside that wrapper. So the layer is
 * named there, from the same tokens (`z-popup`, `z-modal`, `z-tooltip`),
 * which is also where Material UI puts its `zIndex` and shadcn its `z-50`:
 * on the positioner, never on the paper.
 *
 * Under a Base UI popup it goes in through the `render` prop, which is how
 * Base UI composes a part with a component of your own — the part's props,
 * its ref and its `data-starting-style` / `data-ending-style` all land here:
 *
 *     <Menu.Popup render={<Surface />}>…</Menu.Popup>
 *
 * A surface nothing holds — the what's-new card, a hand-rolled listbox — is
 * used directly, and `open` puts it away.
 */

const surface = cva(
  // The edge every tier shares: a hairline ring rather than a border, so it
  // never takes up room, drawn inside in the dark where an outer ring would
  // read as a halo.
  "ring-1 ring-[var(--neutral-a3)] dark:ring-inset",
  {
    variants: {
      /**
       * How far off the page it sits. A card is part of the page and gets a
       * card's shadow; a popup floats over the page and blurs what is behind
       * it; a modal floats over everything and blurs it further. Popups keep
       * the panel radius (docs/design-principles.md, "Radius family"); a
       * modal, being a window rather than a panel, takes the step above.
       */
      tier: {
        card: "rounded-lg bg-bg-card shadow-card",
        popup: "rounded-lg bg-bg-overlay-backdrop shadow-popup backdrop-blur-lg",
        modal: "rounded-xl bg-bg-overlay-backdrop shadow-modal backdrop-blur-xl",
      },
      /**
       * Whether it arrives and leaves, or is simply there.
       *
       * The motion is a fade from a slight scale about the point the surface
       * is anchored to — a transition rather than an animation, as Base UI's
       * animation guide recommends, so a surface dismissed mid-arrival turns
       * back smoothly instead of jumping. It is written in both vocabularies
       * at once: Base UI marks a popup it holds `data-starting-style` and
       * `data-ending-style`, and for a surface nothing holds the browser has
       * `@starting-style` for the arrival and a discrete `display` transition
       * for the departure, which keeps the surface on screen until the fade
       * has played. The scale is `motion-safe` and the fade is not, so a
       * reader who has asked for less motion keeps the fade that tells them
       * something arrived and is spared the movement.
       *
       * Not everything raised should move. The palette and the slash menu
       * are opened by keys and used constantly, and would be a beat slower
       * every time (docs/design-principles.md, "What never animates").
       */
      motion: {
        true: cx(
          "origin-(--transform-origin) transition-[opacity,scale,display] duration-base transition-discrete",
          "starting:opacity-0 motion-safe:starting:scale-95",
          "data-starting-style:opacity-0 motion-safe:data-starting-style:scale-95",
          "data-ending-style:opacity-0 motion-safe:data-ending-style:scale-95",
        ),
        false: "",
      },
    },
    defaultVariants: {
      tier: "popup",
      motion: true,
    },
  },
)

type SurfaceProps = React.ComponentPropsWithoutRef<"div"> &
  VariantProps<typeof surface> & {
    /**
     * For a surface nothing holds. `false` plays the exit and then hides it —
     * it is the browser that takes it away, at the end of the fade, so there
     * is nothing to time. Left out, the surface is there for as long as it is
     * rendered, which is what a Base UI popup wants: Base UI unmounts it
     * itself once its own exit has played.
     */
    open?: boolean
  }

export const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { tier, motion, open, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx(
        // A card is part of the page, so it does not arrive.
        surface({ tier, motion: motion ?? (tier ?? "popup") !== "card" }),
        className,
        // Last, so that it wins over a caller's own `display` — a card that
        // is `flex` while it is there is still hidden when it is not. Hidden
        // takes no clicks, so a link under a surface on its way out cannot
        // still be followed.
        open === false && "hidden opacity-0 motion-safe:scale-95",
      )}
      {...props}
    />
  )
})
