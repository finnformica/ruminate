import type { ReactNode } from "react"

/**
 * **The frame a framed block sits in** — a picture (`image-figure.tsx`), a
 * link block's card (`link-card.tsx`), a code block's panel
 * (`block-kinds.tsx`): the one inset the three share, in place of the
 * content line. A framed block is a thing set in the text rather than a
 * line of it, so it stands off the row's surface on every side, the way a
 * figure stands off the page: 10px above and below it (the row's own 2px
 * and 8px here), and as far from the surface's right edge as from its
 * left. The left is given — the frame starts at the text column, where
 * every block's content begins, so the key slot and the chevron column
 * before it (block-item.tsx; a framed block's slot is empty, its chevron
 * there when it has rows under it) put the surface's left edge 54px off —
 * and the right pays the same: 6px of the surface's own padding and 48px
 * here (56px on a coarse pointer, whose wider marker gaps put the text
 * column 8px further in), so the frame sits centred in the row's surface.
 * The top and bottom match each other and not the sides: a figure's room
 * above and below is a line's worth, its room at the sides the column's.
 *
 * The frame's empty space (beside a narrow figure, around a caption) is
 * the block, so a click there selects the row and a double click edits
 * the text, as clicking anywhere on the row does (the row's surface takes
 * the pointer, block-item.tsx) — the thing inside keeps its own clicks (a
 * picture's lightbox, a card's links) and stops them there. A column, so
 * a figure's `align` can keep it to one side of the frame (`figure-frame.tsx`).
 */
export function BlockFrame({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-1 flex-col py-2 pr-12 coarse:pr-14">
      {children}
    </div>
  )
}
