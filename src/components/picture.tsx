import React from "react"
import { useNetworkState } from "react-use"
import { imagePropsOf } from "../blocks/image"
import type { Block } from "../blocks/types"
import { fittedSize, THUMB_MAX_EDGE } from "../data/image-fit"
import { thumbHashDataUrl } from "../data/image-thumbhash"
import { usePicture } from "../data/images"
import { useNearView } from "../hooks/in-view"
import { cx } from "../utils/cx"
import { LoadingIcon16, OfflineIcon16 } from "./icons"

/** How close to the screen a lazy picture is before it fetches its bytes:
 * a screenful above and below, so a scroll finds the next ones already on
 * their way. A percentage of the page's scroll container, not the
 * viewport (`useNearView`). */
const NEAR_MARGIN = "100% 0px"

/** How a picture meets the box it is given. */
export type PictureFit =
  /** Fills the box, cropped to it: a tile. */
  | "cover"
  /** Its own size, no larger than the box: the lightbox, the inspector,
   * and a figure that is not boxed. */
  | "natural"

/** Which of a picture's two copies (docs/images.md, Thumbnails) are drawn. */
export type PictureDetail =
  /** The thumbnail alone: a tile. */
  | "thumb"
  /** The thumbnail, then the picture itself once decoded: the lightbox. */
  | "full"
  /** The thumbnail, then the picture itself only where the box, measured
   * on screen, wants more pixels than the thumbnail has: a figure. */
  | "auto"

/** What a picture's surroundings may need to know of it. */
export interface PictureState {
  /** The bytes are still going up. */
  uploading: boolean
  /** There is a picture on screen. */
  ready: boolean
  /** There is no picture to be had. */
  missing: boolean
}

/**
 * An image block's picture, drawn the one way everywhere a picture is
 * drawn — the editor's figure, the lightbox, a board's wall and its
 * inspector — over the one reader (`usePicture`, src/data/images.ts).
 *
 * Nothing is fetched for a `lazy` picture until it is within a screenful
 * of the screen; until its bytes are here it is its likeness (the block's
 * ThumbHash, docs/images.md, Offline) in the box the caller gives it, or a
 * pulsing box when the block has none. The thumbnail fades in over the
 * likeness once decoded; the picture itself, where `detail` asks for it,
 * is swapped in only once the browser has decoded it, so nothing paints
 * across the box as its bytes arrive. A picture still uploading draws its
 * local preview at once, under a spinner. One that is not on this device
 * and cannot be fetched keeps its likeness with a small badge saying why,
 * and loads when the network comes back; only one the server has not got
 * is "Image unavailable".
 *
 * The caller sizes the box: `className` and `style` go on it (a tile's
 * `h-full w-full`, a figure's `aspectRatio`). Test ids are `<name>` on
 * the `<img>`, and `<name>-placeholder`, `-uploading`, `-unreachable` and
 * `-missing` on the rest.
 */
export function Picture({
  block,
  name,
  fit,
  detail,
  lazy = false,
  className,
  style,
  onSize,
  onState,
}: {
  block: Pick<Block, "id" | "text" | "props">
  /** The test id's stem. */
  name: string
  fit: PictureFit
  detail: PictureDetail
  /** Fetch the bytes only once the picture is near the screen. */
  lazy?: boolean
  className?: string
  style?: React.CSSProperties
  /** Told the picture's own pixels once its bytes have arrived, for a
   * block that recorded no size. */
  onSize?: (width: number, height: number) => void
  /** Told as the picture's state changes, for the chrome around it. */
  onState?: (state: PictureState) => void
}) {
  const { width, height, thumbhash } = imagePropsOf(block)
  const likeness = thumbhash ? thumbHashDataUrl(thumbhash) : null
  const { ref: observe, near } = useNearView<HTMLElement>(NEAR_MARGIN, lazy)
  const { ref: measure, wantsFull } = useWantsFull(detail === "auto", width, height)
  const { src, uploading, failure } = usePicture(block, {
    full: detail === "full" || (detail === "auto" && wantsFull),
    hold: lazy && !near,
  })
  const caption = block.text.trim()
  const missing = failure === "missing"

  // Loaded means decoded and ready to paint whole: until then the picture
  // is transparent over its likeness. A picture the browser already holds
  // (a row remounted — a nest unfolded, say) is there on the first frame
  // and needs no fade; a new src starts over.
  const [loaded, setLoaded] = React.useState(false)
  const imgRef = React.useRef<HTMLImageElement>(null)
  React.useLayoutEffect(() => {
    const img = imgRef.current
    setLoaded(!!img && img.complete && img.naturalWidth > 0)
  }, [src])

  const ready = src !== null
  React.useEffect(() => {
    onState?.({ uploading, ready, missing })
  }, [onState, uploading, ready, missing])

  const box = React.useCallback(
    (element: HTMLElement | null) => {
      observe(element)
      measure(element)
    },
    [observe, measure],
  )

  if (missing) {
    return (
      <div
        ref={box}
        data-testid={`${name}-missing`}
        className={cx(
          "grid place-items-center rounded-lg border border-dashed border-border-secondary px-3 py-2 text-sm text-text-tertiary",
          className,
        )}
      >
        Image unavailable
      </div>
    )
  }
  const likenessStyle = likeness
    ? { backgroundImage: `url("${likeness}")`, backgroundSize: "cover" }
    : undefined
  const shaped = style?.aspectRatio !== undefined
  return (
    <span
      ref={box}
      data-testid={src === null ? `${name}-placeholder` : undefined}
      aria-hidden={src === null || undefined}
      className={cx(
        "relative block overflow-hidden rounded-lg bg-bg-tertiary bg-center bg-no-repeat",
        fit === "natural" && "max-w-full",
        // A box no one has shaped — a picture of unknown size, not here
        // yet — is a guess at one, so the row is not short by a picture.
        src === null && !shaped && fit === "natural" && "aspect-4/3 w-64",
        // It pulses while the bytes are on their way, unless it already
        // looks like the picture, and not while it waits for the network.
        src === null && !likeness && !failure && "animate-pulse",
        className,
      )}
      // The likeness sits behind the picture while it fades in.
      style={loaded ? style : { ...style, ...likenessStyle }}
    >
      {src !== null ? (
        <img
          ref={imgRef}
          src={src}
          alt={caption}
          draggable={false}
          decoding="async"
          data-testid={name}
          className={cx(
            "transition-opacity duration-300 ease-out",
            fit === "cover"
              ? "block h-full w-full object-cover"
              : "mx-auto block h-auto max-h-[inherit] w-auto max-w-full",
            loaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={(event) => {
            setLoaded(true)
            const { naturalWidth, naturalHeight } = event.currentTarget
            if (naturalWidth > 0 && naturalHeight > 0) onSize?.(naturalWidth, naturalHeight)
          }}
        />
      ) : null}
      {uploading ? (
        <span
          aria-hidden
          data-testid={`${name}-uploading`}
          // A translucent wash, so the preview shows through the spinner.
          className="absolute inset-0 grid place-items-center bg-bg-overlay-backdrop"
        >
          <LoadingIcon16 className="text-text-secondary" />
        </span>
      ) : null}
      {failure === "unreachable" ? <UnreachableBadge name={name} /> : null}
    </span>
  )
}

/**
 * Whether the box a picture is drawn in wants more pixels than its
 * thumbnail has: the box's width on screen, in device pixels, against the
 * thumbnail's (`THUMB_MAX_EDGE` on the picture's longest side). Unknown
 * until the box has been measured; a picture of unknown size, or a
 * browser that cannot measure, wants the picture itself.
 */
function useWantsFull(
  enabled: boolean,
  width: number | undefined,
  height: number | undefined,
): { ref: (element: HTMLElement | null) => void; wantsFull: boolean } {
  const [element, setElement] = React.useState<HTMLElement | null>(null)
  const [boxWidth, setBoxWidth] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (!enabled || !element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => setBoxWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [enabled, element])
  if (!enabled) return { ref: setElement, wantsFull: false }
  if (!width || !height || typeof ResizeObserver === "undefined") {
    return { ref: setElement, wantsFull: true }
  }
  const thumbWidth = fittedSize(width, height, THUMB_MAX_EDGE).width
  const ratio = typeof devicePixelRatio === "number" ? devicePixelRatio : 1
  return { ref: setElement, wantsFull: boxWidth !== null && boxWidth * ratio > thumbWidth }
}

/** Why a picture that is surely there is not showing: this device has no
 * copy, and the server cannot be reached to fetch one. */
function UnreachableBadge({ name }: { name: string }) {
  const { online } = useNetworkState()
  return (
    <span
      data-testid={`${name}-unreachable`}
      className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-bg-overlay-backdrop px-2 py-0.5 text-xs text-text-secondary backdrop-blur-lg"
    >
      <OfflineIcon16 aria-hidden className="size-3" />
      {online === false ? "Offline" : "Couldn’t load image"}
    </span>
  )
}
