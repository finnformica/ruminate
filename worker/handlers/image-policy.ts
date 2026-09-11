// Image asset policy, shared between the Worker and the client.
//
// Pure — no Cloudflare types, no DOM. The Worker (`images.ts`) enforces these
// limits on upload; the client (`src/data/images.ts`) checks them before it
// bothers uploading, and the block layer (`src/blocks/image.ts`) spells an
// asset's URL the one way both sides recognise. Same repo, same file, no
// drift.

/** The largest image accepted, in bytes. R2's free tier is 10 GB-months, so
 * ten megabytes a picture keeps a thousand of them inside it. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** The formats an `<img>` renders everywhere and that carry no script. SVG is
 * deliberately absent: an SVG served from the app's own origin can run script
 * when opened directly, which no note needs. */
const IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]

export function isImageMime(type: string): boolean {
  return IMAGE_MIME_TYPES.includes(type.split(";")[0].trim().toLowerCase())
}

/** Where an asset is served from: `/api/images/<id>`, same origin, session
 * required (the Worker resolves the tenant from the session, never the URL). */
const IMAGE_API_PATH = "/api/images/"

const IMAGE_ID_RE = /^img_[a-z0-9]{12,40}$/

/** Asset ids are minted by the Worker on upload — `img_` + a random
 * lowercase-alphanumeric tail — and validated on every read so a key can
 * never be steered outside the tenant's own prefix. */
export function isImageId(id: string): boolean {
  return IMAGE_ID_RE.test(id)
}

/** A fresh asset id from a hex/uuid-ish source of randomness. */
export function newImageId(random: () => string): string {
  const tail = random()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 24)
  return `img_${tail}`
}

/** The URL an asset id is written as (in markdown and in `<img src>`). */
export function imageUrlOf(id: string): string {
  return IMAGE_API_PATH + id
}

/** The asset id an app-served image URL names, or null for any other URL. */
export function imageIdOfUrl(url: string): string | null {
  if (!url.startsWith(IMAGE_API_PATH)) return null
  const id = url.slice(IMAGE_API_PATH.length)
  return isImageId(id) ? id : null
}
