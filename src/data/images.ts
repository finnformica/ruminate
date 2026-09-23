import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { imagePropsOf } from "../blocks/image"
import type { Block } from "../blocks/types"
import { cacheImage, fetchImageBlob, ImageFetchError, readCachedImage } from "./image-cache"
import type { ImageFetchFailure } from "./image-cache"
import { thumbHashOf } from "./image-thumbhash"
import { sessionFetch } from "./session-fetch"
import { isImageMime, MAX_IMAGE_BYTES } from "../../worker/handlers/image-policy"

/**
 * The client half of image assets (docs/images.md): uploading a pasted
 * picture to the Worker and getting its bytes back to draw.
 *
 * Switched on by `VITE_IMAGES_ENABLED=true` at build time — the same
 * variable the Worker reads at runtime. Off, `imagesEnabled` is false, the
 * editor never offers to upload, and a pasted picture is left to the
 * browser (which, in a textarea, drops it): the feature is a no-op.
 *
 * Reads go through `fetch` with the session's bearer token — an `<img src>`
 * cannot carry one — and become object URLs, cached for the page's life so
 * a picture is fetched once however many rows show it. The bytes are kept
 * on the device too (`image-cache.ts`), and read from there first, so a
 * picture seen once is there offline.
 */
export const imagesEnabled: boolean = import.meta.env.VITE_IMAGES_ENABLED === "true"

export type ImageUploadErrorCode =
  "signed_out" | "unsupported" | "too_large" | "disabled" | "failed"

export class ImageUploadError extends Error {
  constructor(
    public readonly code: ImageUploadErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ImageUploadError"
  }
}

/** The stored result of an upload: what an image block's props hold. */
export interface UploadedImage {
  id: string
  width?: number
  height?: number
  /** A blurred likeness of the picture (`image-thumbhash.ts`). */
  thumbhash?: string
}

/** The image files in a paste or drop, if any (a screenshot pasted from the
 * clipboard arrives as one `image/png` file). */
export function imageFilesOf(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return []
  return Array.from(transfer.files ?? []).filter((file) => file.type.startsWith("image/"))
}

/** Why a file cannot be uploaded, or null when it can. Checked before the
 * network so the reader hears about a 12 MB screenshot at once. */
function rejectImage(file: File): ImageUploadError | null {
  if (!isImageMime(file.type)) {
    return new ImageUploadError(
      "unsupported",
      `${file.type || "That file"} is not a supported image`,
    )
  }
  if (file.size > MAX_IMAGE_BYTES) {
    const mb = Math.round(MAX_IMAGE_BYTES / (1024 * 1024))
    return new ImageUploadError("too_large", `Images must be under ${mb} MB`)
  }
  return null
}

interface Measured {
  width: number
  height: number
  thumbhash?: string
}

/** The pixel size and ThumbHash of an image file, read from the one decode;
 * nothing when the browser can't say. */
async function measure(file: File): Promise<Measured | null> {
  const measured = (source: CanvasImageSource, width: number, height: number): Measured => {
    const thumbhash = thumbHashOf(source, width, height)
    return { width, height, ...(thumbhash ? { thumbhash } : {}) }
  }
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file)
      const size = measured(bitmap, bitmap.width, bitmap.height)
      bitmap.close()
      return size
    } catch {
      // Fall through to the <img> route (some formats, some browsers).
    }
  }
  if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") return null
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(measured(img, img.naturalWidth, img.naturalHeight))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

const signedOut = () => new ImageUploadError("signed_out", "Sign in to add images")

/** Upload one picture; resolves to what the block should remember. */
export async function uploadImage(file: File): Promise<UploadedImage> {
  const rejected = rejectImage(file)
  if (rejected) throw rejected
  const [size, response] = await Promise.all([
    measure(file),
    sessionFetch(
      "/api/images",
      { method: "POST", headers: { "Content-Type": file.type }, body: file },
      signedOut,
    ),
  ])
  if (response.status === 501) {
    throw new ImageUploadError("disabled", "Images are not switched on for this Ruminate")
  }
  if (response.status === 413) throw new ImageUploadError("too_large", "That image is too large")
  if (response.status === 415) {
    throw new ImageUploadError("unsupported", "That image format is not supported")
  }
  if (!response.ok) throw new ImageUploadError("failed", `Upload failed (${response.status})`)
  const body = (await response.json()) as { id?: unknown }
  if (typeof body.id !== "string") throw new ImageUploadError("failed", "Upload failed")
  return { id: body.id, ...(size ?? {}) }
}

// ── Pictures still on their way up ───────────────────────────────────────────

/**
 * Local previews for pictures that are still uploading, by the block that
 * shows them.
 *
 * A pasted screenshot is already on the reader's machine, so the row is
 * inserted at once and draws these bytes while the round trip to R2 happens
 * behind it. The block's `props` stay empty until the asset id arrives, so
 * nothing provisional is ever written to the graph; this map is the only
 * place the preview exists, and it lives no longer than the upload.
 */
const pendingPreviews = new Map<string, string>()
const pendingSubscribers = new Set<() => void>()

const emitPending = () => {
  for (const notify of pendingSubscribers) notify()
}

/** Draw `file` for `blockId` until its upload finishes. */
export function beginPendingImage(blockId: string, file: File): void {
  releasePendingImage(blockId)
  if (typeof URL.createObjectURL !== "function") return
  pendingPreviews.set(blockId, URL.createObjectURL(file))
  emitPending()
}

/** Forget a preview — the upload landed, or it failed and the row is going. */
export function releasePendingImage(blockId: string): void {
  const url = pendingPreviews.get(blockId)
  if (url === undefined) return
  pendingPreviews.delete(blockId)
  URL.revokeObjectURL(url)
  emitPending()
}

function subscribePending(notify: () => void): () => void {
  pendingSubscribers.add(notify)
  return () => {
    pendingSubscribers.delete(notify)
  }
}

/** The local preview for a block whose picture has not landed yet. */
function usePendingImage(blockId: string): string | null {
  return useSyncExternalStore(
    subscribePending,
    () => pendingPreviews.get(blockId) ?? null,
    () => null,
  )
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Object URLs by asset id, for the page's lifetime. A failed fetch is
 * dropped from the cache so the next mount retries. */
const objectUrls = new Map<string, Promise<string>>()

/** Seed the read cache from bytes already in hand, so a picture that has just
 * finished uploading draws from them rather than fetching itself straight
 * back down — and keep them on the device, so it is there offline. */
export function primeImageObjectUrl(id: string, file: File): void {
  void cacheImage(id, file)
  if (objectUrls.has(id) || typeof URL.createObjectURL !== "function") return
  objectUrls.set(id, Promise.resolve(URL.createObjectURL(file)))
}

/** Forget the page's object URLs (on signing out: they are one account's). */
export function resetImageObjectUrls(): void {
  const urls = [...objectUrls.values()]
  objectUrls.clear()
  for (const url of urls) url.then((href) => URL.revokeObjectURL(href)).catch(() => {})
}

/** The bytes of an uploaded picture as an object URL (cached): from the
 * device's copy when it has one, else from the Worker, keeping a copy.
 * Throws `ImageFetchError`. */
function imageObjectUrl(id: string): Promise<string> {
  const cached = objectUrls.get(id)
  if (cached) return cached
  const loading = (async () => {
    const kept = await readCachedImage(id)
    if (kept) return URL.createObjectURL(kept)
    const blob = await fetchImageBlob(id)
    void cacheImage(id, blob)
    return URL.createObjectURL(blob)
  })()
  objectUrls.set(id, loading)
  loading.catch(() => objectUrls.delete(id))
  return loading
}

/** Bump on the network coming back, so a picture that could not be reached
 * tries again. */
function useOnlineRetry(active: boolean): number {
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!active || typeof window === "undefined") return
    const retry = () => setAttempt((n) => n + 1)
    window.addEventListener("online", retry)
    return () => window.removeEventListener("online", retry)
  }, [active])
  return attempt
}

/**
 * What an `<img>` should show for a block, whether those bytes are still
 * going up, and why there is nothing to show when there is not.
 *
 * A picture still uploading draws from its local preview, so it is on screen
 * from the moment it is pasted; an external one draws from its own address;
 * an uploaded one draws once its bytes are here. `src` is `null` until then.
 * `failure` says why it may never come: `missing` when there is no picture
 * to show (the server has none, or the block names none); `unreachable`
 * when the picture is not on this device and the server cannot be reached
 * — offline, most often — in which case it is tried again when the network
 * returns.
 */
export function useImageSrc(block: Pick<Block, "id" | "props">): {
  src: string | null
  uploading: boolean
  failure: ImageFetchFailure | null
} {
  const { image, src } = imagePropsOf(block)
  const pending = usePendingImage(block.id)
  const [state, setState] = useState<{ src: string | null; failure: ImageFetchFailure | null }>({
    src: null,
    failure: null,
  })
  const attempt = useOnlineRetry(state.failure === "unreachable")
  const shown = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!image) return
    let live = true
    // A retry keeps the unreachable picture's placeholder up while it tries;
    // a different picture starts from nothing.
    const retrying = shown.current === image
    shown.current = image
    if (!retrying) setState({ src: null, failure: null })
    imageObjectUrl(image).then(
      (url) => live && setState({ src: url, failure: null }),
      (error: unknown) =>
        live &&
        setState({
          src: null,
          failure:
            error instanceof ImageFetchError && error.failure === "missing"
              ? "missing"
              : "unreachable",
        }),
    )
    return () => {
      live = false
    }
  }, [image, attempt])
  if (pending) return { src: pending, uploading: true, failure: null }
  if (src) return { src, uploading: false, failure: null }
  if (!image) return { src: null, uploading: false, failure: "missing" }
  return { ...state, uploading: false }
}

/** Save a block's picture to the reader's device, named after its caption. */
export async function downloadImage(block: Pick<Block, "text" | "props">): Promise<void> {
  const { image, src } = imagePropsOf(block)
  const url = image ? await imageObjectUrl(image) : src
  if (!url) return
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = (block.text.trim() || image || "image").replace(/[/\\?%*:|"<>]/g, "-")
  anchor.rel = "noopener"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}
