import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cacheImage,
  fetchImageBlob,
  ImageFetchError,
  readCachedImage,
  startImageCache,
  stopImageCache,
} from "./image-cache"
import { sessionFetch } from "./session-fetch"

vi.mock("./session-fetch", () => ({ sessionFetch: vi.fn() }))
const fetched = vi.mocked(sessionFetch)

/** An in-memory CacheStorage: enough of the Cache API for the module. */
class FakeCache {
  entries = new Map<string, { blob: Blob; headers: Headers }>()
  async match(request: Request) {
    const entry = this.entries.get(request.url)
    return entry ? new Response(entry.blob, { headers: entry.headers }) : undefined
  }
  async put(request: Request, response: Response) {
    this.entries.set(request.url, { blob: await response.blob(), headers: response.headers })
  }
  async delete(request: Request) {
    return this.entries.delete(request.url)
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url))
  }
}
class FakeCacheStorage {
  caches = new Map<string, FakeCache>()
  async open(name: string) {
    let cache = this.caches.get(name)
    if (!cache) this.caches.set(name, (cache = new FakeCache()))
    return cache
  }
  async keys() {
    return [...this.caches.keys()]
  }
  async delete(name: string) {
    return this.caches.delete(name)
  }
}

let storage: FakeCacheStorage

const ORIGIN = "https://ruminate.test"
const A = "img_aaaaaaaaaaaaaaaaaaaaaaaa"
const B = "img_bbbbbbbbbbbbbbbbbbbbbbbb"
const C = "img_cccccccccccccccccccccccc"

beforeEach(() => {
  storage = new FakeCacheStorage()
  vi.stubGlobal("caches", storage)
  // Node, not jsdom: jsdom's Blob is not one Node's Response can read. The
  // browser global the module reaches for is stood in for.
  vi.stubGlobal("location", { origin: ORIGIN })
  fetched.mockReset()
})

afterEach(() => {
  stopImageCache()
  vi.unstubAllGlobals()
})

describe("fetchImageBlob", () => {
  it("tells a picture the server has not got from one it cannot reach", async () => {
    fetched.mockResolvedValueOnce(new Response("", { status: 404 }))
    await expect(fetchImageBlob(A)).rejects.toMatchObject({ failure: "missing" })
    fetched.mockResolvedValueOnce(new Response("", { status: 503 }))
    await expect(fetchImageBlob(A)).rejects.toMatchObject({ failure: "unreachable" })
    fetched.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    await expect(fetchImageBlob(A)).rejects.toBeInstanceOf(ImageFetchError)
  })
})

describe("the device's copy of the user's pictures", () => {
  it("keeps nothing while no one is signed in", async () => {
    await cacheImage(A, new Blob(["a"]))
    expect(await readCachedImage(A)).toBeNull()
    expect(storage.caches.size).toBe(0)
  })

  it("keeps a picture for the signed-in identity and reads it back", async () => {
    startImageCache("42")
    await cacheImage(A, new Blob(["bytes"], { type: "image/png" }))
    const kept = await readCachedImage(A)
    expect(await kept?.text()).toBe("bytes")
    expect(await readCachedImage(B)).toBeNull()
  })

  it("throws away another identity's pictures when a different account signs in", async () => {
    startImageCache("7")
    await cacheImage(A, new Blob(["theirs"]))
    await storage.open("unrelated-cache")
    startImageCache("42")
    await vi.waitFor(() => expect(storage.caches.has("ruminate-images-7")).toBe(false))
    expect(storage.caches.has("unrelated-cache")).toBe(true)
    expect(await readCachedImage(A)).toBeNull()
  })

  it("keeps within its cap by letting the earliest-kept pictures go", async () => {
    startImageCache("42", 10)
    await cacheImage(A, new Blob(["aaaa"]))
    await cacheImage(B, new Blob(["bbbb"]))
    // Six more bytes would pass ten: A, the oldest, goes to make room.
    await cacheImage(C, new Blob(["cccccc"]))
    expect(await readCachedImage(A)).toBeNull()
    expect(await (await readCachedImage(B))?.text()).toBe("bbbb")
    expect(await (await readCachedImage(C))?.text()).toBe("cccccc")
    // A picture larger than the whole cap is not kept at all.
    await cacheImage(A, new Blob(["x".repeat(11)]))
    expect(await readCachedImage(A)).toBeNull()
    expect(await readCachedImage(B)).not.toBeNull()
  })

  it("counts what the cache already held at start towards its cap", async () => {
    startImageCache("42", 10)
    await cacheImage(A, new Blob(["aaaaaa"]))
    stopImageCache()
    // Signed in again: A's six bytes are still counted, so B pushes it out.
    startImageCache("42", 10)
    await cacheImage(B, new Blob(["bbbbbb"]))
    expect(await readCachedImage(A)).toBeNull()
    expect(await (await readCachedImage(B))?.text()).toBe("bbbbbb")
  })

  it("keeps one copy of a picture put twice at once", async () => {
    startImageCache("42", 10)
    await Promise.all([cacheImage(A, new Blob(["aaaa"])), cacheImage(A, new Blob(["aaaa"]))])
    await cacheImage(B, new Blob(["bbbbbb"]))
    // Four and six fit exactly, so nothing was double-counted and pushed out.
    expect(await readCachedImage(A)).not.toBeNull()
    expect(await readCachedImage(B)).not.toBeNull()
  })
})
