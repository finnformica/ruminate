import type { Block, BlockType } from "../../blocks/types"
import { cx } from "../../utils/cx"
import { kindOf, slotOf } from "./block-kinds"
import { Hash } from "./hash"

/**
 * **A block type's key**, as one glyph: the bullet's dot, a numbered item's
 * number, a to-do's box, a heading's `#`, a quote's `>`, a paragraph's `¶`,
 * a note's favicon — or nothing, for a figure (an image, a link card, a
 * code block), whose frame is its own mark. This is the ONE place a key is
 * drawn: the block editor sets it in a row's key slot (`block-item.tsx`),
 * and the sidebar sets the same one in a block view's icon slot
 * (`nav-items.tsx`), so a block reads the same wherever it is listed.
 *
 * The to-do's box here is a static picture of the control (a `span` in the
 * checkbox's clothes, `.block-checkbox`); the editor's own row keeps the
 * real `<input>`, which this does not try to be. Every glyph carries the
 * marker classes (`.block-glyph`, `.block-glyph-fill`) so a selected row
 * can tint it (block-editor.css) and a sidebar row can hand it its own ink.
 */
export function BlockKey({
  type,
  block,
  olNumber,
  listed = true,
  className,
}: {
  type: BlockType
  /** The block, for a key that depends on it (a note's favicon reads its
   * id and props). Absent, a bare block of the type stands in. */
  block?: Block
  /** A numbered item's number; 1 when the row is listed on its own. */
  olNumber?: number
  /** Whether the row is listed — a result, a sidebar row — rather than a
   * row of an outline, for a type whose key depends on that (a board's
   * favicon is a listed row's; in an outline its card is its mark). */
  listed?: boolean
  className?: string
}) {
  const kind = kindOf(type)
  switch (slotOf(kind, listed)) {
    case "dot":
      return (
        <span
          aria-hidden
          className={cx("block-glyph-fill size-1.5 rounded-full bg-text-tertiary", className)}
        />
      )
    case "hash":
      return <Hash className={className} />
    case "number":
      return (
        <span aria-hidden className={cx("block-glyph tabular-nums text-text-secondary", className)}>
          {olNumber ?? 1}.
        </span>
      )
    case "checkbox":
      return (
        <span
          aria-hidden
          data-checked={type === "done" || undefined}
          className={cx("block-checkbox", className)}
        />
      )
    case "glyph":
      if (kind.glyphNode) {
        // A rendered key (a note's favicon). Not `aria-hidden`: unlike the
        // typographic keys it can carry meaning of its own.
        return (
          <span className={cx("block-glyph flex items-center", className)}>
            {kind.glyphNode(block ?? bareBlock(type))}
          </span>
        )
      }
      if (kind.glyph) {
        return (
          <span aria-hidden className={cx("block-glyph select-none text-text-tertiary", className)}>
            {kind.glyph}
          </span>
        )
      }
      return null
    case "none":
      return null
  }
}

/** Whether a type has a key at all: false for a figure, whose slot stays
 * empty. A list that wants something in the slot regardless asks first. */
export function hasBlockKey(type: BlockType): boolean {
  const kind = kindOf(type)
  const slot = slotOf(kind, true)
  return slot !== "none" && (slot !== "glyph" || !!kind.glyph || !!kind.glyphNode)
}

const bareBlock = (type: BlockType): Block => ({
  id: "",
  type,
  text: "",
  props: null,
  children: [],
})
