import type React from "react"
import { useState } from "react"
import { imagePropsOf } from "../../blocks/image"
import type { Block } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { useImageSrc } from "../../data/images"
import { cx } from "../../utils/cx"
import { LoadingIcon16 } from "../icons"
import type { BlockEditorApi } from "./block-item"

/**
 * An image block's picture: a click opens the lightbox.
 *
 * No frame of its own: the row's padding is the picture's spacing. It fills
 * the row's width when it is wide enough and centres itself when it is not,
 * never wider than the row, never taller than a screenful.
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
}: {
  block: Block
  occurrence: Occurrence
  api: BlockEditorApi
}) {
  const { src, uploading } = useImageSrc(block)
  const { width, height } = imagePropsOf(block)
  const [loaded, setLoaded] = useState(false)
  const caption = block.text.trim()
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

  if (src === "error") {
    return (
      <div
        data-testid="block-image-missing"
        className="self-start rounded-lg border border-dashed border-border-secondary px-3 py-2 text-sm text-text-tertiary"
      >
        Image unavailable
      </div>
    )
  }

  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={caption ? `Open image: ${caption}` : "Open image"}
      aria-busy={uploading || undefined}
      onClick={open}
      className={cx(
        "block max-w-full self-center overflow-hidden rounded-lg",
        uploading ? "cursor-progress" : "cursor-zoom-in",
      )}
    >
      {src ? (
        <span className="relative block">
          <img
            src={src}
            alt={caption}
            data-testid="block-image"
            onLoad={() => setLoaded(true)}
            className={cx(
              "block h-auto max-h-80 w-auto max-w-full object-contain",
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
          className="block max-h-80 w-64 max-w-full animate-pulse bg-bg-tertiary"
          style={{ aspectRatio: width && height ? `${width} / ${height}` : "4 / 3" }}
        />
      )}
    </button>
  )
}
