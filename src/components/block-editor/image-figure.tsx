import type React from "react"
import { useLayoutEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { imagePropsOf } from "../../blocks/image"
import type { Block } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { useNetworkState } from "react-use"
import { thumbHashDataUrl } from "../../data/image-thumbhash"
import { useImageSrc } from "../../data/images"
import { cx } from "../../utils/cx"
import { LoadingIcon16, OfflineIcon16 } from "../icons"
import type { BlockEditorApi } from "./block-item"
import { FigureFrame } from "./figure-frame"

/**
 * An image block's picture with its caption beneath: the figure that sits
 * in the row. A click on the picture opens the lightbox. The layout — the
 * side it keeps to, its width, the handles and toolbar that set them — is
 * the frame's (`figure-frame.tsx`), shared with every figure block.
 *
 * A picture that is still uploading draws from its local preview under a
 * spinner (`useImageSrc`), so pasting one is instant and the round trip
 * happens behind it. Bytes that had to be fetched fade in, so a note full of
 * pictures settles rather than snapping.
 *
 * The figure is its final size from its first frame, before the bytes
 * arrive, whenever the picture's pixel size is known (an upload's is
 * measured as it goes up): the width the picture will have is worked out
 * from that size and given to the frame, and the picture's box keeps the
 * same ratio, so neither the placeholder that stands in for a fetched
 * picture nor the `<img>` waiting for its bytes is any smaller than the
 * picture will be. Nothing moves when the bytes land — and nothing that
 * measured the row meanwhile is short by a picture: a fold unfolding the
 * row's nest measures it the moment it mounts (fold-motion.ts), and a nest
 * measured without its picture is revealed with the picture's height
 * already showing, then grows under the rows below. A picture whose size
 * is not known (an external URL pasted as markdown) is laid out as it
 * loads, as before.
 *
 * The placeholder is the picture's ThumbHash when the block has one (a
 * blurred likeness, measured at upload: `image-thumbhash.ts`), a grey box
 * when it has not. A picture that is not on this device and cannot be
 * fetched — offline, most often — keeps that placeholder, still, with a
 * small badge saying why; it loads when the network comes back. Only a
 * picture the server says it does not have is "Image unavailable".
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
  const { src, uploading, failure } = useImageSrc(block)
  const { width, height, thumbhash } = imagePropsOf(block)
  const likeness = thumbhash ? thumbHashDataUrl(thumbhash) : null
  const likenessStyle: React.CSSProperties | undefined = likeness
    ? { backgroundImage: `url("${likeness}")`, backgroundSize: "cover" }
    : undefined
  const [loaded, setLoaded] = useState(false)
  const captionText = block.text.trim()
  // The picture's shape, when its pixel size is known: the box the
  // placeholder and the `<img>` keep before and after the bytes arrive.
  const pixels = width && height ? { width, height } : null
  const ratio = pixels ? `${pixels.width} / ${pixels.height}` : undefined
  // The frame's width, when it can be known before the picture loads: the
  // width its natural size gives — its own pixels, no wider than the row,
  // and no wider than a screenful of height allows (the 20rem `max-h-80`
  // cap below, carried over to the width through the ratio). Without it
  // the frame shrinks to the picture as it loads.
  const naturalWidth = pixels
    ? `min(${pixels.width}px, 100%, ${(20 * pixels.width) / pixels.height}rem)`
    : undefined
  // A picture the browser already holds (the row was just remounted — a
  // nest unfolded, say) needs no fade: it is there on the first frame.
  const imgRef = useRef<HTMLImageElement>(null)
  useLayoutEffect(() => {
    const img = imgRef.current
    if (img?.complete && img.naturalWidth > 0) setLoaded(true)
  }, [src])

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

  // The controls: only on a picture that is there to lay out, in an editor
  // that can write the change.
  const controls = !api.readOnly && !!src

  return (
    <FigureFrame
      block={block}
      occurrence={occurrence}
      api={api}
      noun="image"
      naturalWidth={naturalWidth}
      controls={controls}
      caption={caption}
    >
      {({ boxed }) =>
        failure === "missing" ? (
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
              boxed && "w-full",
              uploading ? "cursor-progress" : "cursor-zoom-in",
            )}
          >
            {src ? (
              // The likeness sits behind the picture while it fades in.
              <span
                className="relative block bg-no-repeat"
                style={loaded ? undefined : likenessStyle}
              >
                <img
                  ref={imgRef}
                  src={src}
                  alt={captionText}
                  data-testid="block-image"
                  draggable={false}
                  onLoad={() => setLoaded(true)}
                  // The picture's ratio, set outright rather than left to the
                  // bytes: the box is then the same shape before they arrive
                  // as after.
                  style={ratio ? { aspectRatio: ratio } : undefined}
                  className={cx(
                    // In a frame with a width the picture fills it, whatever
                    // that makes its height. Otherwise it is its natural size,
                    // capped at the row's width and a screenful of height.
                    boxed ? "block h-auto w-full" : "block h-auto max-h-80 w-auto max-w-full",
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
                data-testid="block-image-placeholder"
                // The picture's own box, when its size is known; a guess at
                // one when it is not. It pulses while the bytes are on their
                // way, unless it already looks like the picture.
                className={cx(
                  "relative block max-w-full bg-bg-tertiary bg-no-repeat",
                  boxed ? "w-full" : "max-h-80 w-64",
                  !failure && !likeness && "animate-pulse",
                )}
                style={{ aspectRatio: ratio ?? "4 / 3", ...likenessStyle }}
              >
                {failure === "unreachable" ? <UnreachableBadge /> : null}
              </span>
            )}
          </button>
        )
      }
    </FigureFrame>
  )
}

/** Why a picture that is surely there is not showing: this device has no
 * copy, and the server cannot be reached to fetch one. */
function UnreachableBadge() {
  const { online } = useNetworkState()
  return (
    <span
      data-testid="block-image-unreachable"
      className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-bg-overlay-backdrop px-2 py-0.5 text-xs text-text-secondary backdrop-blur-lg"
    >
      <OfflineIcon16 aria-hidden className="size-3" />
      {online === false ? "Offline" : "Couldn’t load image"}
    </span>
  )
}
