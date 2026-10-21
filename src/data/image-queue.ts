import { imagePropsOf } from "../blocks/image"
import type { BlockProps } from "../blocks/types"
import { parseProps, propsJson, type GraphSnapshot } from "./graph"
import {
  ImageUploadError,
  primeImageObjectUrl,
  queuePendingImage,
  releasePendingImage,
  releaseQueuedImages,
  uploadImage,
  type UploadedImage,
} from "./images"
import { deleteBlockOps, type Op } from "./ops"

/**
 * Pictures added offline, kept on the device until they can go up
 * (docs/images.md, Uploading offline).
 *
 * An upload that cannot reach the server (`offline`, `uploadImage`) leaves
 * its row in place, drawing the picture from the device under a "Waiting to
 * upload" badge, and its bytes are put here, by the block that shows them.
 * When the network returns, or the app starts again, `drainUploads` sends
 * each one and writes its asset id onto its block, as an upload that went
 * at once does. Nothing provisional reaches the graph: until then the block
 * has no asset, exactly as it has none during an upload that takes a second.
 *
 * The bytes live in the Cache API under one cache per signed-in identity
 * (`ruminate-uploads-<owner>`), bound as the picture cache is
 * (`image-cache.ts`): a different account signing in deletes the previous
 * one's. They are apart from the picture cache on purpose: that one lets
 * its oldest pictures go to stay under its cap, and a picture here is the
 * only copy there is.
 *
 * Everything here is a no-op where the Cache API is missing: an offline
 * upload then fails as it did before, and its row is taken back out.
 */

const CACHE_PREFIX = "ruminate-uploads-"

/** The cache key for a block's picture. Not an address the app serves:
 * only a name the Cache API can hold. */
const keyOf = (blockId: string) =>
  new Request(new URL(`/__uploads/${encodeURIComponent(blockId)}`, location.origin).href)
const blockIdOfKey = (request: Request) =>
  decodeURIComponent(new URL(request.url).pathname.slice("/__uploads/".length))

/** The file name, kept beside the bytes so a `File` comes back out. */
const NAME_HEADER = "X-Ruminate-Name"

interface QueueSession {
  owner: string
  name: string
  /** Settles once every kept picture is drawn again (`queuePendingImage`). */
  ready: Promise<void>
}

let session: QueueSession | null = null

const cacheStorage = (): CacheStorage | null => (typeof caches === "undefined" ? null : caches)

async function openCache(current: QueueSession): Promise<Cache | null> {
  try {
    return (await cacheStorage()?.open(current.name)) ?? null
  } catch {
    return null
  }
}

/**
 * Start keeping offline pictures for `owner`. Other identities' are deleted
 * first; then each picture this one kept is drawn again on its row.
 */
export function startUploadQueue(owner: string): void {
  if (session?.owner === owner) return
  stopUploadQueue()
  const storage = cacheStorage()
  if (!storage) return
  const current: QueueSession = { owner, name: CACHE_PREFIX + owner, ready: Promise.resolve() }
  session = current
  current.ready = (async () => {
    try {
      for (const other of await storage.keys()) {
        if (other.startsWith(CACHE_PREFIX) && other !== current.name) await storage.delete(other)
      }
      const cache = await storage.open(current.name)
      for (const request of await cache.keys()) {
        const blob = await (await cache.match(request))?.blob()
        if (blob && session === current) queuePendingImage(blockIdOfKey(request), blob)
      }
    } catch {
      // Unlistable: what was kept waits for the next start.
    }
  })()
}

/** Stop keeping offline pictures; what is kept stays for the next sign-in. */
export function stopUploadQueue(): void {
  session = null
  releaseQueuedImages()
}

/**
 * Keep `file` on the device as `blockId`'s picture until it can go up, and
 * draw it as waiting. False when it cannot be kept (no Cache API, no room,
 * no session): the caller then takes the row back out, as for any failed
 * upload.
 */
export async function queueUpload(blockId: string, file: File): Promise<boolean> {
  const current = session
  if (!current) return false
  await current.ready
  const cache = await openCache(current)
  if (!cache || session !== current) return false
  try {
    await cache.put(
      keyOf(blockId),
      new Response(file, {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          [NAME_HEADER]: encodeURIComponent(file.name),
        },
      }),
    )
  } catch {
    return false
  }
  queuePendingImage(blockId, file)
  return true
}

/** The block ids with a picture kept on this device. */
export async function queuedUploads(): Promise<string[]> {
  const current = session
  if (!current) return []
  await current.ready
  const cache = await openCache(current)
  if (!cache) return []
  try {
    return (await cache.keys()).map(blockIdOfKey)
  } catch {
    return []
  }
}

async function forget(current: QueueSession, blockId: string): Promise<void> {
  try {
    await (await openCache(current))?.delete(keyOf(blockId))
  } catch {
    // Left for the next drain, which finds its row answered and drops it.
  }
  releasePendingImage(blockId)
}

/** What a block's props become when its picture lands: the asset added to
 * what the row already says (a caption's layout, a board's position). */
function landedProps(props: BlockProps | null, asset: UploadedImage): BlockProps {
  return {
    ...(props ?? {}),
    image: asset.id,
    ...(asset.width && asset.height ? { width: asset.width, height: asset.height } : {}),
    ...(asset.thumbhash ? { thumbhash: asset.thumbhash } : {}),
  }
}

/** Whether a block still waits for the picture kept for it: there, an
 * image, and naming no picture yet. */
function waits(graph: GraphSnapshot, blockId: string): boolean {
  const node = graph.nodes.get(blockId)
  if (!node || node.deleted_at || node.type !== "image") return false
  const { image, src } = imagePropsOf({ props: parseProps(node.props) ?? undefined })
  return !image && !src
}

let draining: Promise<void> | null = null

/**
 * Send every picture kept on the device, one at a time, and write each
 * asset id onto its block. A picture whose row has gone (deleted, undone)
 * or already names a picture is let go. One that still cannot reach the
 * server stays for next time; one the server refuses is let go with its
 * row, and `onRefused` says why, as a failed upload does.
 *
 * Only run once the graph is loaded: before then every row looks gone.
 * Calls made while a drain runs share it.
 */
export function drainUploads({
  graph,
  apply,
  onRefused,
  upload = uploadImage,
}: {
  /** The graph as it is now. */
  graph: () => GraphSnapshot
  apply: (ops: Op[]) => void
  onRefused: (error: unknown) => void
  upload?: (file: File) => Promise<UploadedImage>
}): Promise<void> {
  if (draining) return draining
  draining = (async () => {
    const current = session
    if (!current) return
    const cache = await openCache(current)
    if (!cache) return
    for (const blockId of await queuedUploads()) {
      if (session !== current) return
      if (!waits(graph(), blockId)) {
        await forget(current, blockId)
        continue
      }
      const response = await cache.match(keyOf(blockId)).catch(() => undefined)
      if (!response) continue
      const name = decodeURIComponent(response.headers.get(NAME_HEADER) ?? "image")
      const blob = await response.blob()
      const file = new File([blob], name, { type: blob.type })
      let asset: UploadedImage
      try {
        asset = await upload(file)
      } catch (error) {
        if (error instanceof ImageUploadError && error.code === "offline") return
        apply(deleteBlockOps(blockId, graph()))
        await forget(current, blockId)
        onRefused(error)
        continue
      }
      primeImageObjectUrl(asset.id, file)
      // Read again: the row may have changed (or gone) while it went up.
      const now = graph()
      if (waits(now, blockId)) {
        const props = landedProps(parseProps(now.nodes.get(blockId)?.props ?? null), asset)
        apply([{ op: "setProps", id: blockId, props: propsJson(props) }])
      }
      await forget(current, blockId)
    }
  })().finally(() => {
    draining = null
  })
  return draining
}
