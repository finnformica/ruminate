import { cx } from "../utils/cx"

/**
 * Keyboard keys, drawn as keycaps: **the one way the app shows a shortcut**,
 * wherever it appears — a tooltip, a menu item, the sidebar, the command
 * palette, an input's hint, the `?` reference. Every key is a small chip on
 * the secondary surface with a keycap's lower edge, so a shortcut reads the
 * same in every corner of the app and never as plain text.
 *
 * `keys` are the labels `formatCombo` produces (`src/shortcuts/registry.ts`):
 * platform modifiers as symbols, one entry per key. Keys pressed together
 * sit close; a chord (`g` then `s`) sets them apart, so the pair never reads
 * as one key. Hidden where there is nothing to press (touch screens) by the
 * caller, which knows its context.
 */
export function Keys({
  keys,
  chord = false,
  className,
}: {
  keys: string[]
  /** The keys are pressed one after another, not together. */
  chord?: boolean
  className?: string
}) {
  return (
    <span className={cx("inline-flex items-center", chord ? "gap-1" : "gap-0.5", className)}>
      {keys.map((key, index) => (
        <kbd
          key={index}
          className={cx(
            // Its own weight: inside a bold row (the sidebar's current item,
            // a pressed Help) a key stays a key.
            "inline-grid h-5 min-w-5 place-items-center rounded-sm bg-bg-secondary px-1 font-body text-xs font-normal leading-none text-text-secondary",
            // A keycap's lower edge: a hairline beneath in light, and in dark
            // a lit top edge with a soft drop.
            "shadow-[inset_0_-1px_0_var(--color-border-secondary)] dark:shadow-[inset_0_1px_0_var(--color-border-secondary),0_1px_2px_-1px_var(--color-bg)]",
          )}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}
