import type { ImageVariant } from "../../../worker/handlers/image-policy"
import { imagePropsOf } from "../../blocks/image"
import type { BlockProps } from "../../blocks/types"
import { thumbHashDataUrl } from "../../data/image-thumbhash"
import { useImageSrc } from "../../data/images"
import { useNearView } from "../../hooks/in-view"
import { cx } from "../../utils/cx"
import { LoadingIcon16 } from "../icons"

/** What the board knows of a picture: the image block's row. */
export interface BoardImage {
  id: string
  /** The caption. */
  text: string
  props: BlockProps | null
}

/** How close to the screen a lazy tile is before it fetches its bytes: a
 * screenful above and below, so a scroll finds the next tiles already
 * on their way. A percentage of the wall's scroll container, not the
 * viewport (`useNearView`). */
const NEAR_MARGIN = "100% 0px"

/**
 * A board's picture, drawn from the same bytes the editor draws
 * (`useImageSrc`): the local preview while it uploads, under a spinner;
 * the asset once it has landed; its likeness while the bytes are on their
 * way (the block's ThumbHash, docs/images.md, Offline — a quiet box when
 * it has none), and a dashed one when they cannot be had.
 *
 * A `lazy` picture — a tile on the wall — fetches nothing until it is
 * near the screen: a wall of hundreds opens by fetching the first
 * screenful, and the rest as they are scrolled to. A picture still
 * uploading is never held back: its preview is already in hand. A tile
 * asks for the `thumb` variant (docs/images.md, Thumbnails): the small
 * copy, tens of kilobytes against the picture's megabytes.
 */
export function BoardPicture({
  image,
  fit,
  className,
  onSize,
  lazy = false,
  variant = "full",
}: {
  image: BoardImage
  /** `cover` fills its box (a tile); `contain` shows the whole picture. */
  fit: "cover" | "contain"
  className?: string
  /** Told the picture's own pixels once its bytes have arrived, for a
   * block that recorded no size. */
  onSize?: (width: number, height: number) => void
  /** Fetch the bytes only once the picture is near the screen. */
  lazy?: boolean
  /** The picture itself, or its thumbnail. */
  variant?: ImageVariant
}) {
  const { image: asset, src: external, thumbhash } = imagePropsOf(image)
  const likeness = thumbhash ? thumbHashDataUrl(thumbhash) : null
  const { ref, near } = useNearView<HTMLDivElement>(NEAR_MARGIN)
  // Only a picture with bytes to fetch waits: one still uploading draws
  // its local preview, which costs nothing.
  const waiting = lazy && !near && (asset !== undefined || external !== undefined)
  if (waiting) {
    return <Placeholder observe={ref} likeness={likeness} fit={fit} className={className} />
  }
  return (
    <LoadedPicture
      image={image}
      fit={fit}
      className={className}
      onSize={onSize}
      likeness={likeness}
      variant={variant}
    />
  )
}

function LoadedPicture({
  image,
  fit,
  className,
  onSize,
  likeness,
  variant,
}: {
  image: BoardImage
  fit: "cover" | "contain"
  className?: string
  onSize?: (width: number, height: number) => void
  likeness: string | null
  variant: ImageVariant
}) {
  const { src, uploading } = useImageSrc(image, variant)
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
    return <Placeholder likeness={likeness} fit={fit} className={className} />
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

/** The picture's place before its bytes are here: its likeness, fitted
 * as the picture will be, or a pulsing box when the block has none. */
function Placeholder({
  observe,
  likeness,
  fit,
  className,
}: {
  /** Where a waiting tile is watched from (`useNearView`). */
  observe?: (element: HTMLDivElement | null) => void
  likeness: string | null
  fit: "cover" | "contain"
  className?: string
}) {
  return (
    <div
      ref={observe}
      aria-hidden
      data-testid="board-image-placeholder"
      className={cx(
        "rounded-lg bg-bg-tertiary bg-center bg-no-repeat",
        !likeness && "animate-pulse",
        className,
      )}
      style={likeness ? { backgroundImage: `url("${likeness}")`, backgroundSize: fit } : undefined}
    />
  )
}
