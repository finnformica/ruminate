import { getDefaultStore } from "jotai"
import { imageUrlOf, isImageId } from "../../worker/handlers/image-policy"
import { databaseGraphAtom } from "./database-mode"
import type { GraphSnapshot } from "./graph"
import { parseProps } from "./graph"
import { sessionFetch } from "./session-fetch"

/**
 * The device's own copy of the user's pictures (docs/images.md, Offline).
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
 * While signed in, every picture in the user's own notes is fetched into
 * the cache in the background (`sweep`), so a note opened offline for the
 * first time still has its pictures. Notes shared with the user are left
 * out: they are not kept offline at all (docs/sharing.md). The sweep stops
 * short of filling the device (`STORAGE_HEADROOM`), and asks the browser
 * once to keep the app's storage rather than evict it under pressure.
 *
 * Everything here is a no-op where the Cache API is missing (tests, very
 * old browsers): pictures are then fetched as they are shown, as before.
 */

const CACHE_PREFIX = "ruminate-images-"

/** Stop sweeping once the origin is using this fraction of its quota. */
const STORAGE_HEADROOM = 0.8

/** How long the graph must be still before a sweep starts: a pull lands in
 * bursts, and a note being written changes the graph on every keystroke. */
const SWEEP_DELAY_MS = 3000

/** How long a sweep that could not reach the server waits before the graph
 * changing may start another (the network coming back starts one at once). */
const UNREACHABLE_PAUSE_MS = 60_000

/** Pictures fetched at once by a sweep. */
const SWEEP_CONCURRENCY = 2

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
  /** Asset ids known to be in the cache, so a sweep need not ask it. */
  known: Set<string>
  /** Asset ids the server said it does not have: not retried this session. */
  missing: Set<string>
  sweeping: boolean
  /** No sweep before this (ms epoch): the server was out of reach. */
  pausedUntil: number
  timer: ReturnType<typeof setTimeout> | null
  unsubscribe: () => void
}

let session: CacheSession | null = null

const cacheStorage = (): CacheStorage | null => (typeof caches === "undefined" ? null : caches)

/** The cache key for an asset: its own address, so the entry reads as what
 * it is in the browser's devtools. */
const keyOf = (id: string) => new Request(new URL(imageUrlOf(id), location.origin).href)

async function openCache(): Promise<Cache | null> {
  const storage = cacheStorage()
  if (!storage || !session) return null
  try {
    return await storage.open(session.name)
  } catch {
    return null
  }
}

/**
 * Start keeping pictures for `owner` (the same identity the SQL store is
 * bound to). Other identities' caches are deleted first; then the cache is
 * listed, and a sweep fetches whatever the user's notes show that it lacks
 * — now, whenever the graph changes, and when the network comes back.
 */
export function startImageCache(owner: string): void {
  if (session?.owner === owner) return
  stopImageCache()
  const storage = cacheStorage()
  if (!storage) return
  const name = CACHE_PREFIX + owner
  const current: CacheSession = {
    owner,
    name,
    known: new Set(),
    missing: new Set(),
    sweeping: false,
    pausedUntil: 0,
    timer: null,
    unsubscribe: () => {},
  }
  session = current
  const unsubscribeGraph = getDefaultStore().sub(databaseGraphAtom, () => scheduleSweep())
  const onOnline = () => {
    current.pausedUntil = 0
    scheduleSweep(0)
  }
  window.addEventListener("online", onOnline)
  current.unsubscribe = () => {
    unsubscribeGraph()
    window.removeEventListener("online", onOnline)
  }
  void (async () => {
    try {
      for (const other of await storage.keys()) {
        if (other.startsWith(CACHE_PREFIX) && other !== name) await storage.delete(other)
      }
      const cache = await storage.open(name)
      if (session !== current) return
      for (const request of await cache.keys()) {
        const id = new URL(request.url).pathname.split("/").pop()
        if (id) current.known.add(id)
      }
    } catch {
      // Unlistable: the sweep re-fetches what it cannot see, which is only
      // slower.
    }
    // Pictures are the heaviest thing the app keeps; asking once keeps them
    // (and the notes' own store) from being evicted when the device is
    // short of space. The browser decides; a refusal changes nothing else.
    void navigator.storage?.persist?.().catch(() => false)
    if (session === current) scheduleSweep(0)
  })()
}

/** Stop keeping pictures: the sweep stops and the cache is left as it is. */
export function stopImageCache(): void {
  const stopped = session
  if (!stopped) return
  session = null
  if (stopped.timer !== null) clearTimeout(stopped.timer)
  stopped.unsubscribe()
}

/** The cached bytes of a picture, or null when the device has none. */
export async function readCachedImage(id: string): Promise<Blob | null> {
  const cache = await openCache()
  if (!cache) return null
  try {
    const response = await cache.match(keyOf(id))
    return response ? await response.blob() : null
  } catch {
    return null
  }
}

/** Keep a picture's bytes on the device (bytes just uploaded, or fetched). */
export async function cacheImage(id: string, blob: Blob): Promise<void> {
  const current = session
  const cache = await openCache()
  if (!cache || session !== current || !current) return
  try {
    await cache.put(
      keyOf(id),
      new Response(blob, {
        headers: {
          "Content-Type": blob.type || "application/octet-stream",
          "Content-Length": String(blob.size),
        },
      }),
    )
    current.known.add(id)
  } catch {
    // Out of space, most likely: the picture is still drawn from memory.
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

/** The asset ids of the uploaded pictures in a graph. */
export function imageIdsOf(graph: GraphSnapshot): string[] {
  const ids: string[] = []
  for (const node of graph.nodes.values()) {
    if (node.type !== "image" || node.props === null) continue
    const image = parseProps(node.props)?.image
    if (typeof image === "string" && isImageId(image)) ids.push(image)
  }
  return ids
}

function scheduleSweep(delay = SWEEP_DELAY_MS): void {
  const current = session
  if (!current) return
  if (current.timer !== null) clearTimeout(current.timer)
  current.timer = setTimeout(() => {
    current.timer = null
    void sweep(current)
  }, delay)
}

/** Is there room for more pictures? Unknown counts as yes. */
async function hasRoom(): Promise<boolean> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (!estimate?.quota || estimate.usage === undefined) return true
    return estimate.usage / estimate.quota < STORAGE_HEADROOM
  } catch {
    return true
  }
}

/**
 * Fetch every picture the user's notes show that the cache lacks. One sweep
 * at a time; a sweep that finds the network gone stops, and the `online`
 * listener starts the next.
 */
async function sweep(current: CacheSession): Promise<void> {
  if (current.sweeping) return scheduleSweep()
  if (typeof navigator !== "undefined" && navigator.onLine === false) return
  if (Date.now() < current.pausedUntil) return
  const wanted = imageIdsOf(getDefaultStore().get(databaseGraphAtom)).filter(
    (id) => !current.known.has(id) && !current.missing.has(id),
  )
  if (wanted.length === 0) return
  current.sweeping = true
  try {
    let unreachable = false
    const next = async (): Promise<void> => {
      while (session === current && !unreachable) {
        const id = wanted.shift()
        if (id === undefined) return
        if (current.known.has(id)) continue
        if (!(await hasRoom())) return
        try {
          await cacheImage(id, await fetchImageBlob(id))
        } catch (error) {
          if (error instanceof ImageFetchError && error.failure === "missing") {
            current.missing.add(id)
          } else {
            unreachable = true
            current.pausedUntil = Date.now() + UNREACHABLE_PAUSE_MS
          }
        }
      }
    }
    await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, next))
  } finally {
    current.sweeping = false
  }
}
