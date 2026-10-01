import type { BlockProps } from "../../blocks/types"
import { useImageSrc } from "../../data/images"
import { cx } from "../../utils/cx"
import { LoadingIcon16 } from "../icons"

/** What the board knows of a picture: the image block's row. */
export interface BoardImage {
  id: string
  /** The caption. */
  text: string
  props: BlockProps | null
}

/**
 * A board's picture, drawn from the same bytes the editor draws
 * (`useImageSrc`): the local preview while it uploads, under a spinner;
 * the asset once it has landed; a quiet box while the bytes are on their
 * way, and a dashed one when they cannot be had.
 */
export function BoardPicture({
  image,
  fit,
  className,
  onSize,
}: {
  image: BoardImage
  /** `cover` fills its box (a tile); `contain` shows the whole picture. */
  fit: "cover" | "contain"
  className?: string
  /** Told the picture's own pixels once its bytes have arrived, for a
   * block that recorded no size. */
  onSize?: (width: number, height: number) => void
}) {
  const { src, uploading } = useImageSrc(image)
  const caption = image.text.trim()
  if (src === "error") {
    return (
      <div
        data-testid="board-image-missing"
        className={cx(
          "grid place-items-center rounded-lg border border-dashed border-border-secondary px-3 py-2 text-sm text-text-tertiary",
          className,
        )}
      >
        Image unavailable
      </div>
    )
  }
  if (src === null) {
    return (
      <div
        aria-hidden
        data-testid="board-image-placeholder"
        className={cx("animate-pulse rounded-lg bg-bg-tertiary", className)}
      />
    )
  }
  return (
    <span className={cx("relative block overflow-hidden rounded-lg", className)}>
      <img
        src={src}
        alt={caption}
        draggable={false}
        data-testid="board-image"
        className={cx("block h-full w-full", fit === "cover" ? "object-cover" : "object-contain")}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget
          if (naturalWidth > 0 && naturalHeight > 0) onSize?.(naturalWidth, naturalHeight)
        }}
      />
      {uploading ? (
        <span
          aria-hidden
          data-testid="board-image-uploading"
          className="absolute inset-0 grid place-items-center bg-bg-overlay-backdrop"
        >
          <LoadingIcon16 className="text-text-secondary" />
        </span>
      ) : null}
    </span>
  )
}
