import { isImageMime, MAX_IMAGE_BYTES } from "../../worker/handlers/image-policy"

/**
 * **Fitting a picture to the upload limit** (docs/images.md, "Limits").
 *
 * A phone's photo is over ten megabytes because of its pixels, not its
 * metadata: a 48-megapixel JPEG is 10–15 MB however little it carries
 * beside the image, and the HDR gain map and EXIF are a megabyte or two of
 * that at most. So a picture that does not fit is re-encoded here, through
 * a canvas, before it goes up: drawn no larger than `FIT_MAX_EDGE` on its
 * longest side and written back as a JPEG. A canvas keeps only the pixels,
 * so the gain map, the EXIF block, the colour profile and every other
 * segment go with the resolution — that is what makes the re-encoded file
 * small, and it is why the orientation EXIF described has to be applied
 * while decoding (`imageOrientation: "from-image"`), or a portrait photo
 * would come out on its side.
 *
 * The same route takes a format the Worker refuses but this browser can
 * decode — a phone's HEIC, in Safari — and hands it on as a JPEG.
 *
 * A picture that fits is sent as it is: its bytes, its metadata, its
 * format. An animated GIF is never re-encoded (a canvas would keep one
 * frame): it fits or it is refused, as before.
 */

/** The longest edge a re-encoded picture is kept at. */
export const FIT_MAX_EDGE = 3200
/** The quality a re-encoded picture is written at. */
const FIT_QUALITY = 0.85
const FIT_TYPE = "image/jpeg"

/** Formats the Worker does not take but a browser may decode. */
const DECODABLE_ONLY: readonly string[] = ["image/heic", "image/heif"]

const mimeOf = (type: string) => type.split(";")[0].trim().toLowerCase()

/** Whether the browser might decode this type, though the Worker refuses it. */
function isDecodableOnly(type: string): boolean {
  return DECODABLE_ONLY.includes(mimeOf(type))
}

/**
 * Whether `file` has to be re-encoded before it can go up: a supported
 * picture over the size limit, or a format only the browser may read. A GIF
 * is left alone whatever its size.
 */
export function needsFitting(file: Pick<File, "size" | "type">): boolean {
  const type = mimeOf(file.type)
  if (type === "image/gif") return false
  if (isDecodableOnly(type)) return true
  return isImageMime(type) && file.size > MAX_IMAGE_BYTES
}

/** The size a picture is drawn at: its own, or scaled down so that its
 * longest edge is `maxEdge`, the shape kept. */
export function fittedSize(
  width: number,
  height: number,
  maxEdge: number = FIT_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** The re-encoded file's name: the original's, with a JPEG's ending. */
export function fittedName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "")
  return `${base || "image"}.jpg`
}

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void }

/** The picture's pixels, oriented as its EXIF says, or null when this
 * browser cannot decode the file. */
async function decode(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" })
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      }
    } catch {
      // Fall through to the <img> route (some formats, some browsers).
    }
  }
  if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") return null
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

/** Draw `source` at `width` × `height` and encode it, or null where there
 * is no canvas that can. */
async function encode(
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext("2d")
    if (!context) return null
    context.drawImage(source, 0, 0, width, height)
    return canvas.convertToBlob({ type: FIT_TYPE, quality: FIT_QUALITY })
  }
  if (typeof document === "undefined") return null
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")
  if (!context) return null
  context.drawImage(source, 0, 0, width, height)
  return new Promise((resolve) => canvas.toBlob(resolve, FIT_TYPE, FIT_QUALITY))
}

/** Whether this browser has a canvas to re-encode with at all. */
function canEncode(): boolean {
  if (typeof OffscreenCanvas === "function") return true
  if (typeof document === "undefined") return false
  try {
    return document.createElement("canvas").getContext("2d") !== null
  } catch {
    return false
  }
}

/**
 * `file`, fitted to the upload limit: the file itself when it fits, else a
 * JPEG of it no larger than `FIT_MAX_EDGE` on its longest side, with no
 * metadata. Null when the browser cannot decode or re-encode it — the
 * caller then refuses the original for what it is (too large, or a format
 * not supported).
 */
export async function fitImage(file: File): Promise<File | null> {
  if (!needsFitting(file)) return file
  if (!canEncode()) return null
  const decoded = await decode(file)
  if (!decoded) return null
  try {
    const { width, height } = fittedSize(decoded.width, decoded.height)
    const blob = await encode(decoded.source, width, height)
    if (!blob) return null
    return new File([blob], fittedName(file.name), { type: FIT_TYPE, lastModified: Date.now() })
  } finally {
    decoded.close()
  }
}
