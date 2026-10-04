// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchImageBlob } from "../../data/image-cache"
import { beginPendingImage, releasePendingImage } from "../../data/images"
import { BoardPicture } from "./board-picture"

vi.mock("../../data/image-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../data/image-cache")>()
  return {
    ...actual,
    cacheImage: vi.fn(async () => {}),
    fetchImageBlob: vi.fn(),
    readCachedImage: vi.fn(async () => null),
  }
})

const fetched = vi.mocked(fetchImageBlob)

/** An IntersectionObserver that never fires on its own: the test plays
 * the tile coming near with `intersect`. */
class FakeObserver {
  static instances: FakeObserver[] = []
  watched: Element | null = null
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeObserver.instances.push(this)
  }
  observe(element: Element) {
    this.watched = element
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return []
  }
  intersect() {
    this.callback(
      [{ target: this.watched!, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

// jsdom has no object URLs.
beforeAll(() => {
  const url = URL as unknown as Record<string, unknown>
  url.createObjectURL = vi.fn(() => "blob:picture")
  url.revokeObjectURL = vi.fn()
})

beforeEach(() => {
  fetched.mockReset()
  fetched.mockResolvedValue(new Blob(["bytes"]))
  FakeObserver.instances = []
  vi.stubGlobal("IntersectionObserver", FakeObserver)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const THUMBHASH = "YyUKNJh2d3eAiHh3iIeGcGgHdw=="
const picture = (id: string, props: Record<string, unknown> = {}) => ({
  id: `blk_${id}`,
  text: "",
  props: { image: `img_${id}`, ...props },
})

describe("BoardPicture", () => {
  it("fetches a lazy tile's bytes only once it is near the screen", async () => {
    render(<BoardPicture image={picture("lazy00000000")} fit="cover" lazy />)
    expect(screen.getByTestId("board-image-placeholder")).toBeTruthy()
    expect(fetched).not.toHaveBeenCalled()

    act(() => FakeObserver.instances[0].intersect())
    await waitFor(() => expect(screen.getByTestId("board-image")).toBeTruthy())
    expect(fetched).toHaveBeenCalledWith("img_lazy00000000")
  })

  it("fetches straight away when it is not lazy", async () => {
    render(<BoardPicture image={picture("eager0000000")} fit="contain" />)
    await waitFor(() => expect(screen.getByTestId("board-image")).toBeTruthy())
    expect(FakeObserver.instances).toHaveLength(0)
  })

  it("draws the block's likeness while it waits, fitted as the picture will be", () => {
    render(
      <BoardPicture image={picture("hash00000000", { thumbhash: THUMBHASH })} fit="cover" lazy />,
    )
    const placeholder = screen.getByTestId("board-image-placeholder")
    expect(placeholder.style.backgroundImage).toMatch(/^url\("data:image\/png;base64,/)
    expect(placeholder.style.backgroundSize).toBe("cover")
    expect(placeholder.className).not.toContain("animate-pulse")
  })

  it("pulses a plain box for a block with no likeness", () => {
    render(<BoardPicture image={picture("plain0000000")} fit="cover" lazy />)
    const placeholder = screen.getByTestId("board-image-placeholder")
    expect(placeholder.style.backgroundImage).toBe("")
    expect(placeholder.className).toContain("animate-pulse")
  })

  it("never holds back a picture still uploading: its preview is in hand", () => {
    const id = "blk_up0000000000"
    beginPendingImage(id, new File(["png"], "a.png", { type: "image/png" }))
    try {
      render(<BoardPicture image={{ id, text: "", props: null }} fit="cover" lazy />)
      expect(screen.getByTestId("board-image-uploading")).toBeTruthy()
      expect(fetched).not.toHaveBeenCalled()
    } finally {
      releasePendingImage(id)
    }
  })
})
