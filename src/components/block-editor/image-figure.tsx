import type React from "react"
import { imagePropsOf } from "../../blocks/image"
import type { Block } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { useImageSrc } from "../../data/images"
import type { BlockEditorApi } from "./block-item"

/** An image block's picture: the bytes once fetched (a quiet placeholder
 * until then), a click opening the lightbox. Sized to the row — never wider
 * than the text column, never taller than a screenful. */
export function ImageFigure({
  block,
  occurrence,
  api,
}: {
  block: Block
  occurrence: Occurrence
  api: BlockEditorApi
}) {
  const src = useImageSrc(block)
  const { width, height } = imagePropsOf(block)
  const caption = block.text.trim()
  const open = (event: React.MouseEvent) => {
    event.stopPropagation()
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
      onClick={open}
      className="block max-w-full cursor-zoom-in self-start overflow-hidden rounded-lg border border-border-secondary bg-bg-secondary"
    >
      {src ? (
        <img
          src={src}
          alt={caption}
          data-testid="block-image"
          className="block h-auto max-h-80 w-auto max-w-full object-contain"
        />
      ) : (
        <div
          aria-hidden
          className="max-h-80 w-64 max-w-full animate-pulse"
          style={{ aspectRatio: width && height ? `${width} / ${height}` : "4 / 3" }}
        />
      )}
    </button>
  )
}
