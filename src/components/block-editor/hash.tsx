import { cx } from "../../utils/cx"

/**
 * The grey `#` glyph shared by the note title, the zoom title, and section
 * heading markers — one vernacular, one component.
 *
 * Deliberately dumb: it carries **no typography of its own** (no size, weight,
 * line-height, or tracking) so it inherits the parent's entirely — the whole
 * point is that the hash is always exactly the size of the text it labels.
 * Only the ink changes (tertiary: chrome, not content). Positioning is the
 * consumer's job, via `className`.
 */
export function Hash({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cx("select-none text-text-tertiary", className)}>
      #
    </span>
  )
}
