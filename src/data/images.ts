import { useEffect, useState } from "react"
import { imagePropsOf } from "../blocks/image"
import type { Block } from "../blocks/types"
import { ensureFreshToken, getAccessToken, withAuthRetry } from "../utils/github-session"
import { imageUrlOf, isImageMime, MAX_IMAGE_BYTES } from "../../worker/handlers/image-policy"

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
 * a picture is fetched once however many rows show it. The Worker marks the
 * response immutable and private, so the browser's own cache keeps the
 * bytes across reloads too.
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

/** The pixel size of an image file, or nothing when the browser can't say. */
async function measure(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file)
      const size = { width: bitmap.width, height: bitmap.height }
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
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

/** A fetch carrying the session: bearer token + same-origin cookie, refreshed
 * first if near expiry, and retried once through a refresh on a 401. */
async function authorizedFetch(input: string, init: RequestInit): Promise<Response> {
  await ensureFreshToken()
  if (!getAccessToken()) throw new ImageUploadError("signed_out", "Sign in to add images")
  return withAuthRetry(async () => {
    const token = getAccessToken()
    if (!token) throw new ImageUploadError("signed_out", "Sign in to add images")
    const response = await fetch(input, {
      ...init,
      credentials: "same-origin",
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    })
    if (response.status === 401) {
      throw Object.assign(new Error("Image request rejected (401)"), { status: 401 })
    }
    return response
  })
}

/** Upload one picture; resolves to what the block should remember. */
export async function uploadImage(file: File): Promise<UploadedImage> {
  const rejected = rejectImage(file)
  if (rejected) throw rejected
  const [size, response] = await Promise.all([
    measure(file),
    authorizedFetch("/api/images", {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    }),
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

// ── Reading ─────────────────────────────────────────────────────────────────

/** Object URLs by asset id, for the page's lifetime. A failed fetch is
 * dropped from the cache so the next mount retries. */
const objectUrls = new Map<string, Promise<string>>()

/** The bytes of an uploaded picture as an object URL (cached). */
function imageObjectUrl(id: string): Promise<string> {
  const cached = objectUrls.get(id)
  if (cached) return cached
  const loading = (async () => {
    const response = await authorizedFetch(imageUrlOf(id), { method: "GET" })
    if (!response.ok) throw new Error(`Image ${id} unavailable (${response.status})`)
    return URL.createObjectURL(await response.blob())
  })()
  objectUrls.set(id, loading)
  loading.catch(() => objectUrls.delete(id))
  return loading
}

/** What an `<img>` should show for a block: an external picture straight
 * through the file proxy, an uploaded one once its bytes are here. `null`
 * while loading, `"error"` when it cannot be shown. */
export function useImageSrc(block: Pick<Block, "props">): string | null | "error" {
  const { image, src } = imagePropsOf(block)
  const [state, setState] = useState<string | null | "error">(null)
  useEffect(() => {
    if (!image) return
    let live = true
    setState(null)
    imageObjectUrl(image).then(
      (url) => live && setState(url),
      () => live && setState("error"),
    )
    return () => {
      live = false
    }
  }, [image])
  if (src) return src
  if (!image) return "error"
  return state
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
