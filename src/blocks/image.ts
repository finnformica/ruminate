import { imageIdOfUrl, imageUrlOf } from "../../worker/handlers/image-policy"
import type { Block, BlockProps } from "./types"

/**
 * The `image` block (docs/images.md): its `text` is the caption and its
 * `props` say where the picture is — `image`, an asset id the Worker serves
 * from `/api/images/<id>` (the app's own uploads), or `src`, an external
 * URL (a picture pasted as a markdown reference). `width`/`height` are the
 * pixel size measured at upload, so a row can reserve the picture's space
 * before its bytes arrive.
 *
 * Two more props say how the picture sits in its row (the layout, chosen in
 * the editor): `align`, which side of the row it keeps to (centred when
 * absent), and `size`, its width as a percentage of the row's — a picture
 * dragged narrower or wider. Absent, a picture is its natural size, no wider
 * than the row. Both are the row's layout only: the picture's pixels, and
 * the markdown line, are the same whatever they say.
 *
 * In markdown an image block is one line, `![caption](url)`, which is what
 * the serializer writes and the parser reads back into the same props.
 */
export interface ImageProps {
  image?: string
  src?: string
  width?: number
  height?: number
  align?: ImageAlign
  size?: number
}

export type ImageAlign = "left" | "center" | "right"

export const IMAGE_ALIGNS: readonly ImageAlign[] = ["left", "center", "right"]

/** The narrowest a picture can be dragged, as a percentage of the row. */
const MIN_IMAGE_SIZE = 10
/** A drag that lands this close to the row's full width snaps to it. */
export const FULL_IMAGE_SIZE = 100

/** The image props of a block, read leniently (a stray shape renders as a
 * missing picture, never as a crash; a stray layout as the default one). */
export function imagePropsOf(block: Pick<Block, "props">): ImageProps {
  const props = block.props ?? {}
  const out: ImageProps = {}
  if (typeof props.image === "string") out.image = props.image
  if (typeof props.src === "string") out.src = props.src
  if (typeof props.width === "number" && props.width > 0) out.width = props.width
  if (typeof props.height === "number" && props.height > 0) out.height = props.height
  if (props.align === "left" || props.align === "right") out.align = props.align
  if (typeof props.size === "number" && Number.isFinite(props.size)) {
    out.size = clampImageSize(props.size)
  }
  return out
}

/** A size within the range a drag can reach: never narrower than
 * `MIN_IMAGE_SIZE`, never wider than the row. */
export function clampImageSize(size: number): number {
  return Math.min(FULL_IMAGE_SIZE, Math.max(MIN_IMAGE_SIZE, Math.round(size)))
}

/** Which side an image block keeps to: `center` unless it says otherwise. */
export function imageAlignOf(block: Pick<Block, "props">): ImageAlign {
  return imagePropsOf(block).align ?? "center"
}

/**
 * The block's props with its layout changed: `align` (the default, `center`,
 * is stored as nothing) and/or `size` (`null` returns the picture to its
 * natural size). Every other prop — where the picture is, its pixel size —
 * is kept as it was.
 */
export function withImageLayout(
  block: Pick<Block, "props">,
  layout: { align?: ImageAlign; size?: number | null },
): BlockProps {
  const next: BlockProps = { ...(block.props ?? {}) }
  if (layout.align !== undefined) {
    if (layout.align === "center") delete next.align
    else next.align = layout.align
  }
  if (layout.size !== undefined) {
    if (layout.size === null) delete next.size
    else next.size = clampImageSize(layout.size)
  }
  return next
}

/** The URL an image block's markdown names. An asset id is spelled as the
 * app path; an external picture keeps its own URL; neither yields nothing. */
export function imageUrlOfBlock(block: Pick<Block, "props">): string {
  const { image, src } = imagePropsOf(block)
  if (image) return imageUrlOf(image)
  return src ?? ""
}

/** The block's one markdown line: `![caption](url)`. */
export function imageLine(block: Pick<Block, "text" | "props">): string {
  return `![${block.text}](${imageUrlOfBlock(block)})`
}

const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/

/** Read a whole-line markdown image into an image block's text + props, or
 * null when the line is anything else (an image mid-sentence stays text). */
export function parseImageLine(line: string): { text: string; props: BlockProps } | null {
  const match = IMAGE_LINE_RE.exec(line)
  if (!match) return null
  const [, caption, url] = match
  const id = imageIdOfUrl(url)
  return { text: caption, props: id ? { image: id } : { src: url } }
}
