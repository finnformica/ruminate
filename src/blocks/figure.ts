import type { Block, BlockProps, BlockType } from "./types"

/**
 * **Figures**: the block types whose row is a thing set in the text rather
 * than a line of it — a picture (`image`, docs/images.md), a link block's card
 * (`link`, docs/links.md). What they share is their LAYOUT, which
 * this module holds: two props on the block say how the figure sits in its
 * row, chosen in the editor (the frame's handles and toolbar,
 * `figure-frame.tsx`, or the row's context menu).
 *
 * `align` is the side of the row the figure keeps to (centred when absent),
 * and `size` its width as a percentage of the row's — a figure dragged
 * narrower or wider. Absent, a figure is its natural width: a picture its
 * own pixels no wider than the row, a card the row's full width. Both are
 * the row's layout only: the figure's content, and its markdown line, are
 * the same whatever they say.
 */
export type FigureAlign = "left" | "center" | "right"

export const FIGURE_ALIGNS: readonly FigureAlign[] = ["left", "center", "right"]

/** The block types laid out as figures. */
const FIGURE_TYPES: readonly BlockType[] = ["image", "link"]

export function isFigureType(type: BlockType): boolean {
  return FIGURE_TYPES.includes(type)
}

/** The narrowest a figure can be dragged, as a percentage of the row. */
const MIN_FIGURE_SIZE = 10
/** A drag that lands this close to the row's full width snaps to it. */
export const FULL_FIGURE_SIZE = 100

/** A size within the range a drag can reach: never narrower than
 * `MIN_FIGURE_SIZE`, never wider than the row. */
export function clampFigureSize(size: number): number {
  return Math.min(FULL_FIGURE_SIZE, Math.max(MIN_FIGURE_SIZE, Math.round(size)))
}

export interface FigureLayout {
  align?: FigureAlign
  size?: number
}

/** The layout props of a block, read leniently (a stray value is the
 * default). */
export function figureLayoutOf(block: Pick<Block, "props">): FigureLayout {
  const props = block.props ?? {}
  const out: FigureLayout = {}
  if (props.align === "left" || props.align === "right") out.align = props.align
  if (typeof props.size === "number" && Number.isFinite(props.size)) {
    out.size = clampFigureSize(props.size)
  }
  return out
}

/** Which side a figure keeps to: `center` unless it says otherwise. */
export function figureAlignOf(block: Pick<Block, "props">): FigureAlign {
  return figureLayoutOf(block).align ?? "center"
}

/**
 * The block's props with its layout changed: `align` (the default, `center`,
 * is stored as nothing) and/or `size` (`null` returns the figure to its
 * natural width). Every other prop — where a picture is, a link block's
 * address and preview — is kept as it was.
 */
export function withFigureLayout(
  block: Pick<Block, "props">,
  layout: { align?: FigureAlign; size?: number | null },
): BlockProps {
  const next: BlockProps = { ...(block.props ?? {}) }
  if (layout.align !== undefined) {
    if (layout.align === "center") delete next.align
    else next.align = layout.align
  }
  if (layout.size !== undefined) {
    if (layout.size === null) delete next.size
    else next.size = clampFigureSize(layout.size)
  }
  return next
}
