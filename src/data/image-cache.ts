import { imageUrlOf } from "../../worker/handlers/image-policy"
import { sessionFetch } from "./session-fetch"

/**
 * The device's own copy of the pictures the user has seen (docs/images.md,
 * Offline).
 *
 * An uploaded picture's bytes never change under its asset id, so a copy
 * kept on the device is never stale. They are kept in the Cache API — not
 * the browser's HTTP cache, which the browser may empty whenever it likes
 * and the app can neither list nor clear — under one cache per signed-in
 * identity, bound the same way the SQL store is (`database-mode.ts`, owner
 * binding): signing out leaves the copy in place for the next sign-in, and
 * a different account signing in on this browser throws the previous
 * owner's away before anything can read it.
 *
 * A picture is kept when it is shown or uploaded, never fetched ahead: the
 * copy grows with what the user looks at, not with the size of the corpus.
 * It is held under `MAX_CACHE_BYTES`, the earliest-kept pictures going
 * first to make room, and the browser is asked once to keep the app's
 * storage rather than evict it under pressure.
 *
 * Everything here is a no-op where the Cache API is missing (tests, very
 * old browsers): pictures are then fetched as they are shown, as before.
 */

const CACHE_PREFIX = "ruminate-images-"

/** Each entry's size, stamped on it so the cache can be totted up at start
 * without reading every picture's bytes back. */
const SIZE_HEADER = "X-Ruminate-Size"

/** The most the copy may hold. Pictures are up to ten megabytes each, so
 * this is a few hundred screenshots — the notes of recent weeks — without
 * letting a phone's storage fill with every picture ever looked at. */
const MAX_CACHE_BYTES = 250 * 1024 * 1024

/** Why a picture's bytes could not be had. `missing`: the server says there
 * is no such picture (a 404) — no retry will find it. `unreachable`:
 * anything else (offline, signed out, a server error) — it is probably
 * there, just not reachable from here right now. */
export type ImageFetchFailure = "missing" | "unreachable"

export class ImageFetchError extends Error {
  constructor(public readonly failure: ImageFetchFailure) {
    super(failure === "missing" ? "Image not found" : "Image unreachable")
    this.name = "ImageFetchError"
  }
}

interface CacheSession {
  owner: string
  name: string
  /** The cap, `MAX_CACHE_BYTES` but for tests. */
  maxBytes: number
  /** What the cache holds, oldest first: asset id → bytes. Filled from the
   * cache at start (`ready`), kept in step with every put and eviction. */
  sizes: Map<string, number>
  total: number
  /** Settles once `sizes` reflects the cache. */
  ready: Promise<void>
}

let session: CacheSession | null = null

const cacheStorage = (): CacheStorage | null => (typeof caches === "undefined" ? null : caches)

/** The cache key for an asset: its own address, so the entry reads as what
 * it is in the browser's devtools. */
const keyOf = (id: string) => new Request(new URL(imageUrlOf(id), location.origin).href)

const idOfKey = (request: Request) => new URL(request.url).pathname.split("/").pop() ?? ""

async function openCache(current: CacheSession): Promise<Cache | null> {
  const storage = cacheStorage()
  if (!storage) return null
  try {
    return await storage.open(current.name)
  } catch {
    return null
  }
}

/**
 * Start keeping pictures for `owner` (the same identity the SQL store is
 * bound to). Other identities' caches are deleted first; then the cache is
 * listed, oldest first, to know how much it holds.
 */
export function startImageCache(owner: string, maxBytes = MAX_CACHE_BYTES): void {
  if (session?.owner === owner) return
  stopImageCache()
  const storage = cacheStorage()
  if (!storage) return
  const name = CACHE_PREFIX + owner
  const current: CacheSession = {
    owner,
    name,
    maxBytes,
    sizes: new Map(),
    total: 0,
    ready: Promise.resolve(),
  }
  session = current
  current.ready = (async () => {
    try {
      for (const other of await storage.keys()) {
        if (other.startsWith(CACHE_PREFIX) && other !== name) await storage.delete(other)
      }
      const cache = await storage.open(name)
      // Keys come back in the order they were put: oldest first.
      for (const request of await cache.keys()) {
        const response = await cache.match(request)
        const size = Number(response?.headers.get(SIZE_HEADER) ?? 0) || 0
        current.sizes.set(idOfKey(request), size)
        current.total += size
      }
    } catch {
      // Unlistable: the cap counts only what is put from here on.
    }
    // Asking once keeps the pictures (and the notes' own store) from being
    // evicted when the device is short of space. The browser decides; a
    // refusal changes nothing else.
    void navigator.storage?.persist?.().catch(() => false)
  })()
}

/** Stop keeping pictures; the cache is left as it is. */
export function stopImageCache(): void {
  session = null
}

/** The cached bytes of a picture, or null when the device has none. */
export async function readCachedImage(id: string): Promise<Blob | null> {
  const current = session
  if (!current) return null
  const cache = await openCache(current)
  if (!cache) return null
  try {
    const response = await cache.match(keyOf(id))
    return response ? await response.blob() : null
  } catch {
    return null
  }
}

/** Keep a picture's bytes on the device (bytes just uploaded, or fetched),
 * making room under the cap by letting the earliest-kept pictures go. */
export async function cacheImage(id: string, blob: Blob): Promise<void> {
  const current = session
  if (!current || blob.size > current.maxBytes) return
  await current.ready
  const cache = await openCache(current)
  if (!cache || session !== current || current.sizes.has(id)) return
  // Counted before any await, so two puts of one picture keep one copy.
  current.sizes.set(id, blob.size)
  current.total += blob.size
  try {
    // The newest entry is this one, so the oldest is never it.
    while (current.total > current.maxBytes && current.sizes.size > 1) {
      const [oldest, size] = current.sizes.entries().next().value as [string, number]
      current.sizes.delete(oldest)
      current.total -= size
      await cache.delete(keyOf(oldest))
    }
    await cache.put(
      keyOf(id),
      new Response(blob, {
        headers: {
          "Content-Type": blob.type || "application/octet-stream",
          [SIZE_HEADER]: String(blob.size),
        },
      }),
    )
  } catch {
    // Out of space, most likely: the picture is still drawn from memory.
    if (current.sizes.delete(id)) current.total -= blob.size
  }
}

/** Fetch a picture's bytes from the Worker. Throws `ImageFetchError`. */
export async function fetchImageBlob(id: string): Promise<Blob> {
  let response: Response
  try {
    response = await sessionFetch(
      imageUrlOf(id),
      { method: "GET" },
      () => new ImageFetchError("unreachable"),
    )
  } catch {
    throw new ImageFetchError("unreachable")
  }
  if (response.status === 404) throw new ImageFetchError("missing")
  if (!response.ok) throw new ImageFetchError("unreachable")
  return response.blob()
}
