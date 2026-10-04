import type React from "react"
import { useState } from "react"
import type { ReactNode } from "react"
import { imagePropsOf } from "../../blocks/image"
import type { Block } from "../../blocks/types"
import type { Occurrence } from "../../blocks/view"
import { cx } from "../../utils/cx"
import { Picture, type PictureState } from "../picture"
import type { BlockEditorApi } from "./block-item"
import { FigureFrame } from "./figure-frame"

/**
 * An image block's picture with its caption beneath: the figure that sits
 * in the row. A click on the picture opens the lightbox. The layout — the
 * side it keeps to, its width, the handles and toolbar that set them — is
 * the frame's (`figure-frame.tsx`), shared with every figure block; the
 * picture itself is drawn as everywhere (`Picture`, src/components/
 * picture.tsx): nothing fetched until the row is near the screen, its
 * likeness until then, the thumbnail fading in over it, and the picture
 * itself only where the figure's box wants more pixels than the thumbnail
 * has, swapped in once decoded.
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
  const { width, height } = imagePropsOf(block)
  const captionText = block.text.trim()
  const FIGURE_MAX_HEIGHT = "20rem"
  // What the picture is up to, for the chrome around it.
  const [state, setState] = useState<PictureState>({
    uploading: false,
    ready: false,
    missing: false,
  })
  // The frame's width, when it can be known before the picture loads: the
  // width its natural size gives — its own pixels, no wider than the row,
  // and no wider than a screenful of height allows (`FIGURE_MAX_HEIGHT`,
  // carried over to the width through the ratio). Without it the frame
  // shrinks to the picture as it loads. The picture's box keeps the same
  // shape (`Picture` shapes it from the same pixels), so neither the
  // placeholder nor the `<img>` waiting for its bytes is any smaller than
  // the picture will be.
  const pixels = width && height ? { width, height } : null
  const naturalWidth = pixels
    ? `min(${pixels.width}px, 100%, calc(${FIGURE_MAX_HEIGHT} * ${pixels.width / pixels.height}))`
    : undefined

  const open = (event: React.MouseEvent) => {
    event.stopPropagation()
    // A picture still on its way up has no asset to open yet, and one
    // that is gone has nothing to show larger.
    if (state.uploading || state.missing) return
    if (api.openImage) {
      if (!api.readOnly) api.select(occurrence.key)
      api.openImage(block.id)
    } else {
      api.activate?.(occurrence.key)
    }
  }

  // The controls: only on a picture that is there to lay out, in an editor
  // that can write the change.
  const controls = !api.readOnly && state.ready

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
      {({ boxed }) => (
        <button
          type="button"
          tabIndex={-1}
          aria-label={captionText ? `Open image: ${captionText}` : "Open image"}
          aria-busy={state.uploading || undefined}
          onClick={open}
          className={cx(
            "block max-w-full overflow-hidden rounded-lg",
            boxed && "w-full",
            state.uploading
              ? "cursor-progress"
              : state.missing
                ? "cursor-default"
                : "cursor-zoom-in",
          )}
        >
          <Picture
            block={block}
            name="block-image"
            // In a frame with a width the picture fills it, whatever that
            // makes its height. Otherwise it is its natural size, capped at
            // the row's width and a screenful of height.
            fit={boxed ? "cover" : "natural"}
            detail="auto"
            lazy
            className={boxed ? "w-full" : undefined}
            maxHeight={boxed ? undefined : FIGURE_MAX_HEIGHT}
            onState={setState}
          />
        </button>
      )}
    </FigureFrame>
  )
}
