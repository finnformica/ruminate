/**
 * How a raised surface arrives and leaves.
 *
 * Base UI marks a popup `data-starting-style` on the frame it appears and
 * `data-ending-style` while it is going, and holds it in the DOM until the
 * transition has finished. Its animation guide asks for a transition rather
 * than an animation for exactly this: a popup closed while it is still
 * opening reverses smoothly instead of jumping.
 *
 * Kept as a string the components share rather than a CSS class of its own.
 * Tailwind's advice is to reuse through the code rather than through `@apply`,
 * and a class of its own would also be invisible to `cx`, which is what
 * settles a conflict between a utility here and one a caller passes.
 *
 * The fade is unconditional and the scale is `motion-safe`, which is the rule
 * the whole app follows (docs/design-principles.md): a reader who has asked
 * their system for less motion keeps the fade that tells them something
 * arrived, and is spared the movement.
 *
 * The origin belongs to each surface, not here — it points at whatever the
 * surface is anchored to.
 */
export const POPUP_MOTION =
  "transition-[transform,scale,opacity] data-ending-style:opacity-0 data-starting-style:opacity-0 motion-safe:data-ending-style:scale-95 motion-safe:data-starting-style:scale-95"
