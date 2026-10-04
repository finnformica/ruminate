import { rgbaToThumbHash, thumbHashToDataURL } from "thumbhash"

/**
 * A picture's ThumbHash (https://evanw.github.io/thumbhash/): its colours
 * and shapes squeezed into about 25 bytes, kept in the image block's props
 * as base64 (`thumbhash`) so a device that has not got the bytes — offline,
 * or before they arrive — draws a blurred likeness of the picture in its
 * place rather than a grey box (docs/images.md, Offline).
 *
 * Measured once, from the file, as the picture is uploaded. Small enough
 * to ride in the graph, which is rows every device holds a copy of.
 */

/** ThumbHash encodes pictures no larger than this on either side. */
const MAX_SIDE = 100

/** The ThumbHash of a decoded picture, as base64, or null when the browser
 * cannot draw it to read its pixels back. */
export function thumbHashOf(
  source: CanvasImageSource,
  width: number,
  height: number,
): string | null {
  if (typeof document === "undefined" || width <= 0 || height <= 0) return null
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  try {
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext("2d")
    if (!context) return null
    context.drawImage(source, 0, 0, w, h)
    const pixels = context.getImageData(0, 0, w, h).data
    return toBase64(rgbaToThumbHash(w, h, pixels))
  } catch {
    return null
  }
}

const dataUrls = new Map<string, string | null>()

/** The picture a ThumbHash stands for, as a small PNG data URL (cached), or
 * null for a hash that does not decode. */
export function thumbHashDataUrl(hash: string): string | null {
  const cached = dataUrls.get(hash)
  if (cached !== undefined) return cached
  let url: string | null = null
  try {
    url = thumbHashToDataURL(fromBase64(hash))
  } catch {
    url = null
  }
  dataUrls.set(hash, url)
  return url
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}
