import { getDefaultStore } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { databaseGraphAtom, EMPTY_GRAPH } from "./database-mode"
import { buildGraphSnapshot } from "./graph"
import {
  cacheImage,
  fetchImageBlob,
  ImageFetchError,
  imageIdsOf,
  readCachedImage,
  startImageCache,
  stopImageCache,
} from "./image-cache"
import { sessionFetch } from "./session-fetch"

vi.mock("./session-fetch", () => ({ sessionFetch: vi.fn() }))
const fetched = vi.mocked(sessionFetch)

/** An in-memory CacheStorage: enough of the Cache API for the module. */
class FakeCache {
  entries = new Map<string, Blob>()
  async match(request: Request) {
    const blob = this.entries.get(request.url)
    return blob ? new Response(blob) : undefined
  }
  async put(request: Request, response: Response) {
    this.entries.set(request.url, await response.blob())
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

const node = (id: string, type: string, props: Record<string, unknown> | null = null) => ({
  id,
  type,
  text: "",
  props: props === null ? null : JSON.stringify(props),
  updated_at: 1,
})

const graphOf = (...ids: string[]) =>
  buildGraphSnapshot(
    [node("p", "page"), ...ids.map((image, i) => node(`b${i}`, "image", { image }))],
    [],
  )

const ORIGIN = "https://ruminate.test"
const A = "img_aaaaaaaaaaaaaaaaaaaaaaaa"
const B = "img_bbbbbbbbbbbbbbbbbbbbbbbb"

beforeEach(() => {
  storage = new FakeCacheStorage()
  vi.stubGlobal("caches", storage)
  // Node, not jsdom: jsdom's Blob is not one Node's Response can read. The
  // two browser globals the module reaches for are stood in for.
  vi.stubGlobal("window", new EventTarget())
  vi.stubGlobal("location", { origin: ORIGIN })
  fetched.mockReset()
  getDefaultStore().set(databaseGraphAtom, EMPTY_GRAPH)
})

afterEach(() => {
  stopImageCache()
  vi.unstubAllGlobals()
})

describe("imageIdsOf", () => {
  it("lists the uploaded pictures in a graph, and nothing else", () => {
    const graph = buildGraphSnapshot(
      [
        node("a", "image", { image: A }),
        node("b", "image", { src: "https://example.com/x.png" }),
        node("c", "image", { image: "../../escape" }),
        node("d", "text", { image: B }),
        node("e", "image"),
      ],
      [],
    )
    expect(imageIdsOf(graph)).toEqual([A])
  })
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
    await (
      await storage.open("ruminate-images-7")
    ).put(new Request(`${ORIGIN}/api/images/${A}`), new Response(new Blob(["theirs"])))
    await storage.open("unrelated-cache")
    startImageCache("42")
    await vi.waitFor(() => expect(storage.caches.has("ruminate-images-7")).toBe(false))
    expect(storage.caches.has("unrelated-cache")).toBe(true)
    expect(await readCachedImage(A)).toBeNull()
  })

  it("fetches every picture in the user's notes it lacks, in the background", async () => {
    await (
      await storage.open("ruminate-images-42")
    ).put(new Request(`${ORIGIN}/api/images/${A}`), new Response(new Blob(["already"])))
    getDefaultStore().set(databaseGraphAtom, graphOf(A, B))
    fetched.mockImplementation(async () => new Response(new Blob(["fetched"])))
    startImageCache("42")
    await vi.waitFor(async () => expect(await (await readCachedImage(B))?.text()).toBe("fetched"))
    // Only the picture it lacked was fetched.
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(fetched.mock.calls[0][0]).toBe(`/api/images/${B}`)
  })

  it("does not ask again for a picture the server has not got", async () => {
    vi.useFakeTimers()
    try {
      getDefaultStore().set(databaseGraphAtom, graphOf(A))
      fetched.mockImplementation(async () => new Response("", { status: 404 }))
      startImageCache("42")
      await vi.advanceTimersByTimeAsync(100)
      expect(fetched).toHaveBeenCalledTimes(1)
      // The graph changes; the sweep runs again, and leaves the missing one be.
      getDefaultStore().set(databaseGraphAtom, graphOf(A, B))
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetched.mock.calls.map((call) => call[0])).toEqual([
        `/api/images/${A}`,
        `/api/images/${B}`,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops sweeping when the server is out of reach, and starts again when the network returns", async () => {
    vi.useFakeTimers()
    try {
      getDefaultStore().set(databaseGraphAtom, graphOf(A, B))
      fetched.mockRejectedValue(new TypeError("Failed to fetch"))
      startImageCache("42")
      await vi.advanceTimersByTimeAsync(100)
      // Both workers stop at their first failure.
      expect(fetched.mock.calls.length).toBeLessThanOrEqual(2)
      const before = fetched.mock.calls.length
      // An edit within the pause does not try again.
      getDefaultStore().set(databaseGraphAtom, graphOf(A, B, A))
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetched.mock.calls.length).toBe(before)
      // The network coming back does.
      fetched.mockImplementation(async () => new Response(new Blob(["back"])))
      window.dispatchEvent(new Event("online"))
      await vi.advanceTimersByTimeAsync(100)
      expect(await (await readCachedImage(A))?.text()).toBe("back")
      expect(await (await readCachedImage(B))?.text()).toBe("back")
    } finally {
      vi.useRealTimers()
    }
  })
})
