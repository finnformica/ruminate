import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NodeRow } from "../../worker/handlers/replica-payload"
import { buildGraphSnapshot, parseProps, type GraphSnapshot } from "./graph"
import {
  drainUploads,
  queuedUploads,
  queueUpload,
  startUploadQueue,
  stopUploadQueue,
} from "./image-queue"
import { ImageUploadError, type UploadedImage } from "./images"
import { applyOps, type Op } from "./ops"

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

const ID = "blk_pic000000000"
const ASSET: UploadedImage = { id: "img_aaaaaaaaaaaaaaaaaaaaaaaa", width: 40, height: 30 }

const imageNode = (props: Record<string, unknown> | null): NodeRow => ({
  id: ID,
  type: "image",
  text: "a caption",
  props: props ? JSON.stringify(props) : null,
  updated_at: 1,
})

/** The graph a drain reads and writes, as the app's store holds it. */
function graphOf(node: NodeRow | null) {
  let graph: GraphSnapshot = buildGraphSnapshot(node ? [node] : [], [])
  const written: Op[] = []
  return {
    graph: () => graph,
    apply: (ops: Op[]) => {
      written.push(...ops)
      graph = applyOps(graph, ops, 2)
    },
    written,
  }
}

const picked = () => new File(["png"], "shot.png", { type: "image/png" })

beforeEach(() => {
  vi.stubGlobal("caches", new FakeCacheStorage())
  vi.stubGlobal("location", { origin: "https://ruminate.test" })
  startUploadQueue("owner")
})

afterEach(() => {
  stopUploadQueue()
  vi.unstubAllGlobals()
})

describe("the offline upload queue", () => {
  it("sends a kept picture and adds its asset to what the row already says", async () => {
    expect(await queueUpload(ID, picked())).toBe(true)
    const store = graphOf(imageNode({ align: "left" }))
    const upload = vi.fn(async (_file: File) => ASSET)

    await drainUploads({ ...store, onRefused: vi.fn(), upload })

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0].name).toBe("shot.png")
    expect(parseProps(store.graph().nodes.get(ID)?.props ?? null)).toEqual({
      align: "left",
      image: ASSET.id,
      width: 40,
      height: 30,
    })
    expect(await queuedUploads()).toEqual([])
  })

  it("keeps a picture that still cannot reach the server, for next time", async () => {
    await queueUpload(ID, picked())
    const store = graphOf(imageNode(null))
    const upload = vi.fn(async (file: File): Promise<UploadedImage> => {
      throw new ImageUploadError("offline", "You are offline", file)
    })

    await drainUploads({ ...store, onRefused: vi.fn(), upload })

    expect(store.written).toEqual([])
    expect(await queuedUploads()).toEqual([ID])
  })

  it("lets a picture go whose row has gone, without sending it", async () => {
    await queueUpload(ID, picked())
    const store = graphOf(null)
    const upload = vi.fn(async () => ASSET)

    await drainUploads({ ...store, onRefused: vi.fn(), upload })

    expect(upload).not.toHaveBeenCalled()
    expect(await queuedUploads()).toEqual([])
  })

  it("takes the row out with a picture the server refuses, and says why", async () => {
    await queueUpload(ID, picked())
    const store = graphOf(imageNode(null))
    const refused = new ImageUploadError("disabled", "Images are not switched on")
    const onRefused = vi.fn()

    await drainUploads({
      ...store,
      onRefused,
      upload: async () => {
        throw refused
      },
    })

    expect(onRefused).toHaveBeenCalledWith(refused)
    expect(store.graph().nodes.has(ID)).toBe(false)
    expect(await queuedUploads()).toEqual([])
  })

  it("keeps what it holds across a restart, and drops it for another account", async () => {
    await queueUpload(ID, picked())
    stopUploadQueue()
    startUploadQueue("owner")
    expect(await queuedUploads()).toEqual([ID])

    startUploadQueue("someone-else")
    expect(await queuedUploads()).toEqual([])
    startUploadQueue("owner")
    expect(await queuedUploads()).toEqual([])
  })
})
