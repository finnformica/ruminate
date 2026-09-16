import type React from "react"
import { useRef, useState } from "react"
import type { ReactNode } from "react"
import {
  FIGURE_ALIGNS,
  FULL_FIGURE_SIZE,
  clampFigureSize,
  figureAlignOf,
  figureLayoutOf,
  withFigureLayout,
  type FigureAlign,
} from "../../blocks/figure"
import type { Block } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { cx } from "../../utils/cx"
import { IconButton } from "../icon-button"
import { AlignCenterIcon16, AlignLeftIcon16, AlignRightIcon16 } from "../icons"
import type { BlockEditorApi } from "./block-item"

/** The side of the row a figure keeps to, as its alignment in the row's
 * column. */
const ALIGN_SELF: Record<FigureAlign, string> = {
  left: "self-start",
  center: "self-center",
  right: "self-end",
}

const ALIGN_LABELS: Record<FigureAlign, string> = {
  left: "Align left",
  center: "Align centre",
  right: "Align right",
}

const ALIGN_ICONS: Record<FigureAlign, React.ComponentType<{ className?: string }>> = {
  left: AlignLeftIcon16,
  center: AlignCenterIcon16,
  right: AlignRightIcon16,
}

/** The resize handles a figure shows, by the side it keeps to: a centred
 * figure grows from both sides; one kept to a side grows away from it, so
 * only the free side has a handle. */
const HANDLES: Record<FigureAlign, readonly ("left" | "right")[]> = {
  left: ["right"],
  center: ["left", "right"],
  right: ["left"],
}

/** A drag that lands within this much of the row's full width snaps to it,
 * so "as wide as the row" is easy to hit by hand. */
const SNAP_TO_FULL = 3

/** What the frame tells the figure inside it about its own box. */
export interface FrameState {
  /** The frame has a width of its own (a size, or a natural width the
   * figure gave it), so the figure fills it; otherwise the frame shrinks
   * to the figure. */
  boxed: boolean
}

/**
 * The frame every figure block sits in — a picture (`image-figure.tsx`),
 * a link block's card (`link-card.tsx`): the layout the figure types share
 * (`src/blocks/figure.ts`), drawn once.
 *
 * No chrome of its own: the row's padding is the figure's spacing. The
 * block's `align` keeps the figure to one side of the row, and its `size`
 * makes it a fraction of the row's width; absent, the figure is the width
 * it gave the frame (`naturalWidth` — a picture's own pixels no wider than
 * the row, a card the row's full width) or, giving none, shrinks to fit.
 * The caption, when there is one, is the frame's width exactly and goes
 * wherever the figure goes.
 *
 * In an editable editor the frame carries the figure's controls, revealed
 * on hover or while the row is selected, and never in the way of reading:
 * a handle at the figure's side drags it wider or narrower — one at each
 * side of a centred figure, which grows from both sides at once; only at
 * the free side of a figure kept to the left or right, which grows away
 * from the side it keeps to (a handle against that side would only fight
 * it) — and a small toolbar in the figure's corner sets which side it
 * keeps to, after any tools the figure adds of its own. The same choices
 * are in the row's context menu, for a keyboard or a touch screen. A drag
 * is one undo step, committed when the pointer lets go.
 */
export function FigureFrame({
  block,
  occurrence,
  api,
  noun,
  naturalWidth,
  controls,
  tools,
  caption,
  children,
}: {
  block: Block
  occurrence: Occurrence
  api: BlockEditorApi
  /** What the figure is, for the controls' labels and test ids
   * (`image-resize-left`, `link-toolbar`). */
  noun: "image" | "link"
  /** The frame's width when the block sets no size: a CSS width, or
   * undefined to shrink to the figure. */
  naturalWidth?: string
  /** Whether the layout controls are offered: an editable editor, and a
   * figure that is there to lay out (not a picture still uploading). */
  controls: boolean
  /** The figure's own toolbar buttons, before the alignment ones. */
  tools?: ReactNode
  /** The caption line (the row's body, view or textarea), or null for an
   * uncaptioned figure that is not being edited. */
  caption?: ReactNode
  /** The figure itself, given the frame's state. */
  children: (frame: FrameState) => ReactNode
}) {
  const { size } = figureLayoutOf(block)
  const align = figureAlignOf(block)
  // The size while a handle is being dragged: the frame follows the pointer
  // live and the block is written once, when it lets go.
  const [dragSize, setDragSize] = useState<number | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const selected = !api.readOnly && api.selectedSet.has(occurrence.key)
  const shownSize = dragSize ?? size
  const width = shownSize !== undefined ? `${shownSize}%` : naturalWidth
  const boxed = width !== undefined

  const setLayout = (layout: { align?: FigureAlign; size?: number | null }) =>
    api.onBlockChange(block.id, { props: withFigureLayout(block, layout) }, "structural")

  /**
   * Start dragging the `side` handle. The pointer's travel is the change in
   * the figure's width — doubled on a centred figure, which grows from both
   * sides to stay centred — and the width is stored as a fraction of the row
   * so it holds on a narrower screen.
   */
  const startResize = (side: "left" | "right") => (event: React.PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const frame = frameRef.current
    const row = frame?.parentElement
    if (!frame || !row) return
    const rowWidth = row.getBoundingClientRect().width
    const startWidth = frame.getBoundingClientRect().width
    if (rowWidth <= 0) return
    const startX = event.clientX
    const direction = side === "right" ? 1 : -1
    const growth = align === "center" ? 2 : 1
    let last = size ?? clampFigureSize((startWidth / rowWidth) * 100)
    const move = (e: PointerEvent) => {
      const next = startWidth + (e.clientX - startX) * direction * growth
      last = snapFigureSize((next / rowWidth) * 100)
      setDragSize(last)
    }
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
      setDragSize(null)
      if (last !== size) setLayout({ size: last })
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
  }

  // The controls: hidden — not just faded, so a stray tap never lands on
  // them — until the frame is hovered or its row is selected.
  const reveal = cx(
    "transition-opacity duration-150",
    selected || dragSize !== null
      ? "visible opacity-100"
      : "invisible opacity-0 group-hover/figure:visible group-hover/figure:opacity-100",
  )

  return (
    <div
      ref={frameRef}
      data-testid={`${noun}-figure`}
      data-align={align}
      data-size={shownSize}
      className={cx(
        "group/figure relative flex max-w-full flex-col gap-1.5",
        ALIGN_SELF[align],
        dragSize !== null && "select-none",
      )}
      style={boxed ? { width } : undefined}
    >
      {/* The figure and, over it, its controls: the handles span the
          figure's height, never the caption's. */}
      <div className="relative">
        {children({ boxed })}
        {controls ? (
          <>
            {HANDLES[align].map((side) => (
              // A slim pill at the figure's edge, on its vertical centre. It
              // has to read against a picture of ANY colour, so it carries its
              // own contrast rather than relying on what is under it: an
              // opaque white core (translucent, a pale picture bled through
              // and washed it out), a dark hairline that draws the edge where
              // white meets white, and a soft shadow under that to lift it
              // off. On a dark picture the white core does the work and the
              // shadow is invisible; on a pale one the hairline and shadow do.
              <button
                key={side}
                type="button"
                tabIndex={-1}
                aria-label={`Resize ${noun} from the ${side}`}
                data-testid={`${noun}-resize-${side}`}
                onPointerDown={startResize(side)}
                onClick={(event) => event.stopPropagation()}
                className={cx(
                  "absolute inset-y-0 w-4 cursor-ew-resize touch-none",
                  side === "left" ? "left-0" : "right-0",
                  reveal,
                )}
              >
                <span
                  aria-hidden
                  className={cx(
                    // `bg-[#fff]`, not `bg-white`: the theme replaces
                    // Tailwind's palette wholesale (tailwind.config.cjs sets
                    // `colors` outside `extend`), so there is no `white` and
                    // `bg-white` emits nothing at all — the core came out
                    // transparent and only the ring showed.
                    "absolute top-1/2 h-8 max-h-[60%] w-1 -translate-y-1/2 rounded-full bg-[#fff] shadow-[0_0_0_1px_#00000073,0_1px_4px_#0000004d]",
                    side === "left" ? "left-2" : "right-2",
                  )}
                />
              </button>
            ))}
            <div
              role="toolbar"
              aria-label={`${noun === "image" ? "Image" : "Link"} layout`}
              data-testid={`${noun}-toolbar`}
              className={cx(
                "absolute right-2 top-2 flex gap-0.5 p-0.5",
                // The card surface without `card`'s radius: the corners are
                // concentric with the buttons' — their 4px plus the 2px of
                // padding around them — so nothing is squeezed at the ends.
                "rounded-[6px] bg-bg-overlay-backdrop shadow-lg ring-1 ring-[var(--neutral-a3)] backdrop-blur-lg dark:ring-inset",
                reveal,
              )}
            >
              {tools}
              {FIGURE_ALIGNS.map((option) => {
                const Icon = ALIGN_ICONS[option]
                return (
                  <IconButton
                    key={option}
                    size="small"
                    tabIndex={-1}
                    tooltipSide="top"
                    aria-label={ALIGN_LABELS[option]}
                    aria-pressed={option === align}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (option !== align) setLayout({ align: option })
                    }}
                    // The small radius: on a 24px button the 8px base reads
                    // as a pill, and the toolbar's corners follow this one.
                    // The chosen alignment stays NEUTRAL, on the same ladder
                    // as the sidebar's toggled panel: this toolbar floats over
                    // a picture, so an accent tint would land on whatever
                    // colour happens to be under it, and an alignment is a
                    // tool's state rather than a place you are or a value the
                    // app remembers about you. It only has to clear the
                    // button's own hover, which `bg-bg-secondary` did not —
                    // that is the very surface this button hovers to, so the
                    // chosen one and the hovered one were the same colour.
                    className={cx(
                      "rounded-sm px-1.5",
                      option === align &&
                        "bg-bg-secondary-hover text-text hover:bg-bg-secondary-active! active:bg-[var(--neutral-a6)]!",
                    )}
                  >
                    <Icon />
                  </IconButton>
                )
              })}
            </div>
          </>
        ) : null}
      </div>
      {caption ? (
        // Exactly as wide as the figure: a zero width keeps a long caption
        // from widening the frame, and the minimum stretches it back out
        // to the figure's edges.
        <div className="w-0 min-w-full">{caption}</div>
      ) : null}
    </div>
  )
}

/** The small, square toolbar button a figure adds beside the alignment
 * ones (a link block's "Open link"). */
export function FigureTool({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <IconButton
      size="small"
      tabIndex={-1}
      tooltipSide="top"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="rounded-sm px-1.5"
    >
      {children}
    </IconButton>
  )
}

/** A dragged width, kept within range and snapped to the row's full width
 * when it is nearly there. */
function snapFigureSize(size: number): number {
  if (size >= FULL_FIGURE_SIZE - SNAP_TO_FULL) return FULL_FIGURE_SIZE
  return clampFigureSize(size)
}
