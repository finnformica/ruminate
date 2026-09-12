import type React from "react"
import { useRef, useState } from "react"
import type { ReactNode } from "react"
import {
  FULL_IMAGE_SIZE,
  IMAGE_ALIGNS,
  clampImageSize,
  imageAlignOf,
  imagePropsOf,
  withImageLayout,
  type ImageAlign,
} from "../../blocks/image"
import type { Block } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { useImageSrc } from "../../data/images"
import { cx } from "../../utils/cx"
import { IconButton } from "../icon-button"
import { AlignCenterIcon16, AlignLeftIcon16, AlignRightIcon16, LoadingIcon16 } from "../icons"
import type { BlockEditorApi } from "./block-item"

/** The side of the row a picture keeps to, as the figure's alignment in the
 * row's column. */
const ALIGN_SELF: Record<ImageAlign, string> = {
  left: "self-start",
  center: "self-center",
  right: "self-end",
}

const IMAGE_ALIGN_LABELS: Record<ImageAlign, string> = {
  left: "Align left",
  center: "Align centre",
  right: "Align right",
}

const ALIGN_ICONS: Record<ImageAlign, React.ComponentType<{ className?: string }>> = {
  left: AlignLeftIcon16,
  center: AlignCenterIcon16,
  right: AlignRightIcon16,
}

/** The resize handles a picture shows, by the side it keeps to: a centred
 * picture grows from both sides; one kept to a side grows away from it, so
 * only the free side has a handle. */
const HANDLES: Record<ImageAlign, readonly ("left" | "right")[]> = {
  left: ["right"],
  center: ["left", "right"],
  right: ["left"],
}

/** A drag that lands within this much of the row's full width snaps to it,
 * so "as wide as the row" is easy to hit by hand. */
const SNAP_TO_FULL = 3

/**
 * An image block's picture with its caption beneath: the figure that sits
 * in the row. A click on the picture opens the lightbox.
 *
 * No frame of its own: the row's padding is the picture's spacing. Left to
 * itself, a picture is its natural size — filling the row's width when it
 * is wide enough and centring itself when it is not, never wider than the
 * row, never taller than a screenful. The block's props can say otherwise
 * (`src/blocks/image.ts`): `align` keeps it to one side of the row, and
 * `size` makes it a fraction of the row's width, so a picture reads as a
 * figure in the text rather than a wall across it. The caption is the
 * figure's width exactly and goes wherever the picture goes.
 *
 * In an editable editor the figure carries its own controls, revealed on
 * hover or while the row is selected, and never in the way of reading:
 * a handle at the picture's side drags it wider or narrower — one at each
 * side of a centred picture, which grows from both sides at once; only at
 * the free side of a picture kept to the left or right, which grows away
 * from the side it keeps to (a handle against that side would only fight
 * it) — and a small toolbar in the picture's corner sets which side it
 * keeps to. The same choices are in the row's context menu, for a
 * keyboard or a touch screen. A drag is one undo step, committed when the
 * pointer lets go.
 *
 * A picture that is still uploading draws from its local preview under a
 * spinner (`useImageSrc`), so pasting one is instant and the round trip
 * happens behind it. Bytes that had to be fetched fade in, so a note full of
 * pictures settles rather than snapping.
 */
export function ImageFigure({
  block,
  occurrence,
  api,
  caption,
}: {
  block: Block
  occurrence: Occurrence
  api: BlockEditorApi
  /** The caption line (the row's body, view or textarea), or null for an
   * uncaptioned picture that is not being edited. */
  caption: ReactNode
}) {
  const { src, uploading } = useImageSrc(block)
  const { width, height, size } = imagePropsOf(block)
  const align = imageAlignOf(block)
  const [loaded, setLoaded] = useState(false)
  // The size while a handle is being dragged: the figure follows the pointer
  // live and the block is written once, when it lets go.
  const [dragSize, setDragSize] = useState<number | null>(null)
  const figureRef = useRef<HTMLDivElement>(null)
  const captionText = block.text.trim()
  const editable = !api.readOnly
  const selected = editable && api.selectedSet.has(occurrence.key)
  const shownSize = dragSize ?? size
  const sized = shownSize !== undefined

  const open = (event: React.MouseEvent) => {
    event.stopPropagation()
    // A picture still on its way up has no asset to open yet.
    if (uploading) return
    if (api.openImage) {
      if (!api.readOnly) api.select(occurrence.key)
      api.openImage(block.id)
    } else {
      api.activate?.(occurrence.key)
    }
  }

  const setLayout = (layout: { align?: ImageAlign; size?: number | null }) =>
    api.onBlockChange(block.id, { props: withImageLayout(block, layout) }, "structural")

  /**
   * Start dragging the `side` handle. The pointer's travel is the change in
   * the picture's width — doubled on a centred picture, which grows from both
   * sides to stay centred — and the width is stored as a fraction of the row
   * so it holds on a narrower screen.
   */
  const startResize = (side: "left" | "right") => (event: React.PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const figure = figureRef.current
    const row = figure?.parentElement
    if (!figure || !row) return
    const rowWidth = row.getBoundingClientRect().width
    const startWidth = figure.getBoundingClientRect().width
    if (rowWidth <= 0) return
    const startX = event.clientX
    const direction = side === "right" ? 1 : -1
    const growth = align === "center" ? 2 : 1
    let last = size ?? clampImageSize((startWidth / rowWidth) * 100)
    const move = (e: PointerEvent) => {
      const next = startWidth + (e.clientX - startX) * direction * growth
      last = snapImageSize((next / rowWidth) * 100)
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

  const picture =
    src === "error" ? (
      <div
        data-testid="block-image-missing"
        className="self-start rounded-lg border border-dashed border-border-secondary px-3 py-2 text-sm text-text-tertiary"
      >
        Image unavailable
      </div>
    ) : (
      <button
        type="button"
        tabIndex={-1}
        aria-label={captionText ? `Open image: ${captionText}` : "Open image"}
        aria-busy={uploading || undefined}
        onClick={open}
        className={cx(
          "block max-w-full overflow-hidden rounded-lg",
          sized && "w-full",
          uploading ? "cursor-progress" : "cursor-zoom-in",
        )}
      >
        {src ? (
          <span className="relative block">
            <img
              src={src}
              alt={captionText}
              data-testid="block-image"
              draggable={false}
              onLoad={() => setLoaded(true)}
              className={cx(
                // At its natural size the picture is capped at the row's
                // width and a screenful of height; a sized picture is the
                // width it was given, whatever that makes its height.
                sized ? "block h-auto w-full" : "block h-auto max-h-80 w-auto max-w-full",
                "transition-opacity duration-300 ease-out",
                loaded ? "opacity-100" : "opacity-0",
              )}
            />
            {uploading ? (
              <span
                aria-hidden
                data-testid="block-image-uploading"
                // A translucent wash, so the preview shows through the spinner.
                className="absolute inset-0 grid place-items-center bg-bg-overlay-backdrop"
              >
                <LoadingIcon16 className="text-text-secondary" />
              </span>
            ) : null}
          </span>
        ) : (
          <span
            aria-hidden
            data-testid="block-image-placeholder"
            className={cx(
              "block max-w-full animate-pulse bg-bg-tertiary",
              sized ? "w-full" : "max-h-80 w-64",
            )}
            style={{ aspectRatio: width && height ? `${width} / ${height}` : "4 / 3" }}
          />
        )}
      </button>
    )

  // The controls: only on a picture that is there to lay out, in an editor
  // that can write the change. Hidden — not just faded, so a stray tap never
  // lands on them — until the figure is hovered or its row is selected.
  const controls = editable && src && src !== "error"
  const reveal = cx(
    "transition-opacity duration-150",
    selected || dragSize !== null
      ? "visible opacity-100"
      : "invisible opacity-0 group-hover/figure:visible group-hover/figure:opacity-100",
  )

  return (
    <div
      ref={figureRef}
      data-testid="image-figure"
      data-align={align}
      data-size={shownSize}
      className={cx(
        "group/figure relative flex max-w-full flex-col gap-1.5",
        ALIGN_SELF[align],
        dragSize !== null && "select-none",
      )}
      style={sized ? { width: `${shownSize}%` } : undefined}
    >
      {/* The picture and, over it, its controls: the handles span the
          picture's height, never the caption's. */}
      <div className="relative">
        {picture}
        {controls ? (
          <>
            {HANDLES[align].map((side) => (
              // A slim pill at the picture's edge, on its vertical centre. It
              // has to read against a picture of ANY colour, so it carries its
              // own contrast rather than relying on the image: an opaque white
              // core (translucent, a pale picture bled through and washed it
              // out), a dark hairline that draws the edge where white meets
              // white, and a soft shadow under that to lift it off. On a dark
              // picture the white core does the work and the shadow is
              // invisible; on a pale one the hairline and shadow do.
              <button
                key={side}
                type="button"
                tabIndex={-1}
                aria-label={`Resize image from the ${side}`}
                data-testid={`image-resize-${side}`}
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
                    "absolute top-1/2 h-8 max-h-[60%] w-1 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_1px_#00000073,0_1px_4px_#0000004d]",
                    side === "left" ? "left-2" : "right-2",
                  )}
                />
              </button>
            ))}
            <div
              role="toolbar"
              aria-label="Image layout"
              data-testid="image-toolbar"
              className={cx(
                "absolute right-2 top-2 flex gap-0.5 p-0.5",
                // The card surface without `card`'s radius: the corners are
                // concentric with the buttons' — their 4px plus the 2px of
                // padding around them — so nothing is squeezed at the ends.
                "rounded-[6px] bg-bg-overlay-backdrop shadow-lg ring-1 ring-[var(--neutral-a3)] backdrop-blur-lg dark:ring-inset",
                reveal,
              )}
            >
              {IMAGE_ALIGNS.map((option) => {
                const Icon = ALIGN_ICONS[option]
                return (
                  <IconButton
                    key={option}
                    size="small"
                    tabIndex={-1}
                    tooltipSide="top"
                    aria-label={IMAGE_ALIGN_LABELS[option]}
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
        // Exactly as wide as the picture: a zero width keeps a long caption
        // from widening the figure, and the minimum stretches it back out
        // to the picture's edges.
        <div className="w-0 min-w-full">{caption}</div>
      ) : null}
    </div>
  )
}

/** A dragged width, kept within range and snapped to the row's full width
 * when it is nearly there. */
function snapImageSize(size: number): number {
  if (size >= FULL_IMAGE_SIZE - SNAP_TO_FULL) return FULL_IMAGE_SIZE
  return clampImageSize(size)
}
