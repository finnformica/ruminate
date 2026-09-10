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
 * In markdown an image block is one line, `![caption](url)`, which is what
 * the serializer writes and the parser reads back into the same props.
 */
export interface ImageProps {
  image?: string
  src?: string
  width?: number
  height?: number
}

/** The image props of a block, read leniently (a stray shape renders as a
 * missing picture, never as a crash). */
export function imagePropsOf(block: Pick<Block, "props">): ImageProps {
  const props = block.props ?? {}
  const out: ImageProps = {}
  if (typeof props.image === "string") out.image = props.image
  if (typeof props.src === "string") out.src = props.src
  if (typeof props.width === "number" && props.width > 0) out.width = props.width
  if (typeof props.height === "number" && props.height > 0) out.height = props.height
  return out
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
